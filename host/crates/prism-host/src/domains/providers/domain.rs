//! The `providers` domain: profiles, logins, limits and catalogs (T08).
//! Port of src/main/ipc/providers.ts, src/main/ipc/agentModels.ts,
//! src/main/providerUsage.ts and the profile half of
//! src/main/ipc/traycerImport.ts (the Traycer reads stay on the desktop).
//!
//! Changes are serialized and published to every client as
//! `providers.changed`. Managing accounts is the owner's.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, Once};
use std::time::Duration;

use prism_agents::claude::ClaudeAgents;
use prism_agents::codex::{CodexError, CodexErrorKind, CodexQueries, CodexSessions};
use prism_agents::profile_env::{home_dir, traycer_account, ProfileError, ProfileErrorKind, Profiles, Provider};
use prism_protocol::chats::methods as chat_methods;
use prism_protocol::providers::{
    methods, AvailableParams, CatalogParams, CodexResetParams, CommandsParams, CreateProfileParams, DetailsParams, ImportProfilesParams,
    LoginCancelParams, LoginInputParams, LoginParams, LoginResizeParams, LoginStarted, ProfileIdParams, ProfileRefParams, ProfilesList,
    RenameProfileParams, SetLinkParams, StoredProfilesList, UpdateProfileParams,
};
use prism_protocol::{ErrorCode, HostError, OkResult, Role};
use serde::Serialize;
use serde_json::{json, Map, Value};

use super::catalog::Catalogs;
use super::login::{self, LoginRequest, Logins};
use super::profiles::{self, create_private_dir, public_list, FolderRemoval, HostProfiles};
use crate::domain::{params, CallContext, ClientId, Domain, HandlerFuture, Notifier};
use crate::domains::chats::{ChatsDomain, Hold};

/// `LINKED_LOGIN_REFUSAL` (src/main/ipc/providerProfiles.ts).
const LINKED_LOGIN_REFUSAL: &str = "Esta conta usa o login do Traycer. Entre pelo Traycer ou desvincule para entrar no Prism.";
const NOT_FOUND: &str = "Conta não encontrada.";

const METHODS: &[&str] = &[
    methods::LIST,
    methods::CREATE,
    methods::UPDATE,
    methods::RENAME,
    methods::REMOVE,
    methods::STATUS,
    methods::LOGIN,
    methods::LOGIN_INPUT,
    methods::LOGIN_RESIZE,
    methods::LOGIN_CANCEL,
    methods::DETAILS,
    methods::MODELS,
    methods::COMMANDS,
    methods::CODEX_RESET,
    methods::AVAILABLE,
    methods::STORED,
    methods::IMPORT_PROFILES,
    methods::SET_LINK,
];

/// What the domain is built from (`domains::all`).
pub struct ProvidersParts {
    pub host_profiles: Arc<HostProfiles>,
    pub profiles: Profiles,
    pub catalogs: Arc<Catalogs>,
    pub chats: Arc<ChatsDomain>,
    pub claude: Option<ClaudeAgents>,
    pub codex: Arc<CodexSessions>,
    pub codex_queries: Arc<CodexQueries>,
}

pub struct ProvidersDomain {
    inner: Arc<Inner>,
}

struct Inner {
    host_profiles: Arc<HostProfiles>,
    profiles: Profiles,
    catalogs: Arc<Catalogs>,
    chats: Arc<ChatsDomain>,
    claude: Option<ClaudeAgents>,
    codex: Arc<CodexSessions>,
    codex_queries: Arc<CodexQueries>,
    logins: Arc<Logins>,
    /// Who hears `providers.changed`: every client that called this domain.
    clients: Mutex<HashMap<ClientId, Notifier>>,
    /// One change at a time (the TS handlers ran one at a time too).
    changes: tokio::sync::Mutex<()>,
    purged: Once,
}

impl ProvidersDomain {
    pub fn new(parts: ProvidersParts) -> Self {
        let ProvidersParts { host_profiles, profiles, catalogs, chats, claude, codex, codex_queries } = parts;
        Self {
            inner: Arc::new(Inner {
                host_profiles,
                profiles,
                catalogs,
                chats,
                claude,
                codex,
                codex_queries,
                logins: Logins::new(),
                clients: Mutex::new(HashMap::new()),
                changes: tokio::sync::Mutex::new(()),
                purged: Once::new(),
            }),
        }
    }
}

impl Drop for ProvidersDomain {
    fn drop(&mut self) {
        self.inner.logins.shutdown();
    }
}

fn invalid(message: impl Into<String>) -> HostError {
    HostError::new(ErrorCode::Invalid, message)
}

fn busy(message: impl Into<String>) -> HostError {
    HostError::new(ErrorCode::Busy, message)
}

fn not_found(message: impl Into<String>) -> HostError {
    HostError::new(ErrorCode::NotFound, message)
}

fn internal(message: impl Into<String>) -> HostError {
    HostError::new(ErrorCode::Internal, message)
}

fn answer<T: Serialize>(value: T) -> Result<Value, HostError> {
    serde_json::to_value(value).map_err(|err| internal(err.to_string()))
}

fn ok() -> Result<Value, HostError> {
    answer(OkResult { ok: true })
}

/// A profile that cannot run, in the protocol's codes.
pub fn profile_error(err: ProfileError) -> HostError {
    let code = match err.kind {
        ProfileErrorKind::NotFound => ErrorCode::NotFound,
        ProfileErrorKind::Disabled => ErrorCode::Invalid,
        ProfileErrorKind::BrokenLink => ErrorCode::CliAuth,
        ProfileErrorKind::Unreadable => ErrorCode::Internal,
    };
    HostError::new(code, err.message)
}

fn codex_error(err: CodexError) -> HostError {
    let code = match err.kind {
        CodexErrorKind::Invalid => ErrorCode::Invalid,
        CodexErrorKind::NotFound => ErrorCode::NotFound,
        CodexErrorKind::Busy => ErrorCode::Busy,
        CodexErrorKind::CliMissing => ErrorCode::CliMissing,
        CodexErrorKind::CliAuth => ErrorCode::CliAuth,
        CodexErrorKind::Failed => ErrorCode::Internal,
    };
    HostError::new(code, err.message)
}

fn provider(name: &str) -> Option<Provider> {
    match name {
        "claude" => Some(Provider::Claude),
        "codex" => Some(Provider::Codex),
        _ => None,
    }
}

fn owner(ctx: &CallContext) -> Result<(), HostError> {
    if ctx.user.role == Role::Owner {
        Ok(())
    } else {
        Err(HostError::new(ErrorCode::Forbidden, "Só o dono do host gerencia as contas."))
    }
}

fn is_hex_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn now_ms() -> u64 {
    crate::now_ms()
}

/// Runs blocking work (the store, the file system) off the runtime.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, HostError> + Send + 'static) -> Result<T, HostError> {
    tokio::task::spawn_blocking(work).await.map_err(|err| internal(format!("Falha interna: {err}")))?
}

/// Edits one stored profile in place (blocking); `None` when it does not exist.
fn edit_document(host: &HostProfiles, id: &str, change: impl FnOnce(&mut Map<String, Value>)) -> Result<Option<Value>, HostError> {
    let Some(Value::Object(mut doc)) = host.documents()?.into_iter().find(|d| d.get("id").and_then(Value::as_str) == Some(id)) else {
        return Ok(None);
    };
    change(&mut doc);
    let doc = Value::Object(doc);
    host.put(&doc)?;
    Ok(Some(doc))
}

/// A linked profile's own copy of the login is a fork of the rotating refresh
/// token: it is renamed so it never runs again (never deleted).
fn retire_own_login(root: &Path, id: &str, provider: Provider) {
    let file = root.join(id).join(provider.credential_file());
    if !file.is_file() {
        return;
    }
    let retired = file.with_file_name(format!("{}.replaced-by-traycer-link-{}", provider.credential_file(), now_ms()));
    if let Err(err) = std::fs::rename(&file, &retired) {
        tracing::warn!(profile = %id, %err, "a cópia antiga do login não foi desativada; ela não é usada enquanto o vínculo existir");
    }
}

impl Domain for ProvidersDomain {
    fn name(&self) -> &'static str {
        "providers"
    }

    fn call(&self, method: &str, value: Value, ctx: CallContext) -> Option<HandlerFuture> {
        if !METHODS.contains(&method) {
            return None;
        }
        let inner = Arc::clone(&self.inner);
        inner.clients.lock().unwrap().insert(ctx.notifier.client, ctx.notifier.clone());
        inner.purge_once();
        let method = method.to_string();
        Some(Box::pin(async move { inner.call(&method, value, ctx).await }))
    }

    fn disconnected(&self, client: ClientId) {
        self.inner.clients.lock().unwrap().remove(&client);
        self.inner.logins.client_gone(client);
    }
}

impl Inner {
    async fn call(self: Arc<Self>, method: &str, value: Value, ctx: CallContext) -> Result<Value, HostError> {
        match method {
            methods::LIST => answer(ProfilesList { profiles: self.public().await? }),
            methods::CREATE => {
                owner(&ctx)?;
                self.create(params(value)?).await
            }
            methods::UPDATE => {
                owner(&ctx)?;
                self.update(params(value)?).await
            }
            methods::RENAME => {
                owner(&ctx)?;
                self.rename(params(value)?).await
            }
            methods::REMOVE => {
                owner(&ctx)?;
                self.remove(params(value)?).await
            }
            methods::STATUS => {
                let p: ProfileRefParams = params(value)?;
                self.catalogs.status(&p.provider, &p.id).await
            }
            methods::LOGIN => {
                owner(&ctx)?;
                self.login(params(value)?, &ctx).await
            }
            methods::LOGIN_INPUT => {
                owner(&ctx)?;
                let p: LoginInputParams = params(value)?;
                self.logins.input(&p.id, ctx.notifier.client, &p.text);
                ok()
            }
            methods::LOGIN_RESIZE => {
                owner(&ctx)?;
                let p: LoginResizeParams = params(value)?;
                self.logins.resize(&p.id, ctx.notifier.client, Some(p.cols), Some(p.rows));
                ok()
            }
            methods::LOGIN_CANCEL => {
                owner(&ctx)?;
                let p: LoginCancelParams = params(value)?;
                self.logins.cancel(&p.id, ctx.notifier.client, p.session.as_deref());
                ok()
            }
            methods::DETAILS => {
                let p: DetailsParams = params(value)?;
                self.catalogs.details(&p.provider, &p.profile_id, p.refresh.unwrap_or(false)).await
            }
            methods::MODELS => {
                let p: CatalogParams = params(value)?;
                self.catalogs.models(&p.provider, &p.profile_id, p.refresh.unwrap_or(false)).await
            }
            methods::COMMANDS => {
                let p: CommandsParams = params(value)?;
                self.catalogs.commands(&p.provider, &p.profile_id, &p.cwd, p.refresh.unwrap_or(false)).await
            }
            methods::CODEX_RESET => {
                owner(&ctx)?;
                let p: CodexResetParams = params(value)?;
                let outcome = self.codex_queries.reset(&json!(p.profile_id), &json!(p.idempotency_key), &json!(p.credit_id)).await.map_err(codex_error)?;
                Ok(json!({ "outcome": outcome }))
            }
            methods::AVAILABLE => {
                let p: AvailableParams = params(value)?;
                self.catalogs.available(&p.provider).await
            }
            methods::STORED => {
                owner(&ctx)?;
                let host = Arc::clone(&self.host_profiles);
                answer(StoredProfilesList { profiles: blocking(move || host.documents()).await? })
            }
            methods::IMPORT_PROFILES => {
                owner(&ctx)?;
                self.import_profiles(params(value)?).await
            }
            methods::SET_LINK => {
                owner(&ctx)?;
                self.set_link(params(value)?).await
            }
            _ => Err(HostError::new(ErrorCode::MethodNotFound, format!("Método desconhecido: providers.{method}"))),
        }
    }

    /// The public list (`publicProfiles`).
    async fn public(&self) -> Result<Vec<Value>, HostError> {
        let host = Arc::clone(&self.host_profiles);
        let docs = blocking(move || host.documents()).await?;
        Ok(public_list(&docs))
    }

    /// Publishes the list to every client and answers it.
    async fn changed(&self) -> Result<Value, HostError> {
        let list = answer(ProfilesList { profiles: self.public().await? })?;
        self.clients.lock().unwrap().retain(|_, notifier| notifier.send(methods::CHANGED, list.clone()));
        Ok(list)
    }

    /// A profile's login changed or it was turned off: its idle processes end,
    /// its "always allow" choices and cached reads are forgotten.
    fn profile_changed(&self, id: &str) {
        if let Some(claude) = &self.claude {
            claude.profile_changed(id);
        }
        self.codex.profile_changed(id);
        self.catalogs.forget(id);
    }

    /// Whether a turn runs on the profile (the chats engine knows).
    async fn running(&self, id: &str, ctx: &CallContext) -> Result<bool, HostError> {
        let Some(call) = self.chats.call(chat_methods::BUSY_PROFILES, json!({}), ctx.clone()) else { return Ok(false) };
        let busy = call.await?;
        Ok(busy.get("profileIds").and_then(Value::as_array).is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some(id))))
    }

    /// Edits one stored document; `None` when it does not exist.
    async fn edit(&self, id: &str, change: impl FnOnce(&mut Map<String, Value>) + Send + 'static) -> Result<Option<Value>, HostError> {
        let host = Arc::clone(&self.host_profiles);
        let id = id.to_string();
        blocking(move || edit_document(&host, &id, change)).await
    }

    /// The stored profile's provider (`None`: no such profile).
    async fn provider_of(&self, id: &str) -> Result<Option<String>, HostError> {
        Ok(self.stored(id).await?.and_then(|doc| doc.get("provider").and_then(Value::as_str).map(str::to_string)))
    }

    async fn stored(&self, id: &str) -> Result<Option<Value>, HostError> {
        let host = Arc::clone(&self.host_profiles);
        let id = id.to_string();
        blocking(move || Ok(host.documents()?.into_iter().find(|d| d.get("id").and_then(Value::as_str) == Some(id.as_str())))).await
    }

    async fn create(&self, p: CreateProfileParams) -> Result<Value, HostError> {
        let name: String = p.name.trim().chars().take(80).collect();
        let Some(provider) = provider(&p.provider).filter(|_| !name.is_empty()) else {
            return Err(invalid("Informe o agente e o nome da conta."));
        };
        let _change = self.changes.lock().await;
        let doc = json!({ "id": uuid::Uuid::new_v4().to_string(), "provider": provider.as_str(), "name": name });
        let host = Arc::clone(&self.host_profiles);
        let created = doc.clone();
        blocking(move || {
            let id = created["id"].as_str().unwrap_or_default();
            create_private_dir(&host.root().join(id)).map_err(|err| internal(format!("Não foi possível criar a pasta da conta: {err}")))?;
            host.put(&created)
        })
        .await?;
        self.changed().await?;
        Ok(doc)
    }

    async fn update(&self, p: UpdateProfileParams) -> Result<Value, HostError> {
        if p.id.starts_with("ambient-") {
            return Err(invalid("A conta do terminal é gerenciada pelo terminal."));
        }
        if p.name.as_deref().is_some_and(|n| n.trim().is_empty()) {
            return Err(invalid("Informe um nome."));
        }
        let color = p.color.filter(|c| !c.is_empty());
        if color.as_deref().is_some_and(|c| !is_hex_color(c)) {
            return Err(invalid("Cor inválida."));
        }
        let _change = self.changes.lock().await;
        let disabling = p.enabled == Some(false);
        let (name, enabled) = (p.name, p.enabled);
        let change = move |doc: &mut Map<String, Value>| {
            if let Some(name) = name {
                doc.insert("name".into(), Value::String(name.trim().chars().take(80).collect()));
            }
            if let Some(enabled) = enabled {
                doc.insert("enabled".into(), Value::Bool(enabled));
            }
            if let Some(color) = color {
                doc.insert("color".into(), Value::String(color));
            }
        };
        if !disabling {
            self.edit(&p.id, change).await?;
            return self.changed().await;
        }
        // Turned off while no turn runs on it, and none can start until it is.
        if let Some(provider) = self.provider_of(&p.id).await? {
            let (host, id) = (Arc::clone(&self.host_profiles), p.id.clone());
            let refusal = "Pare as tarefas desta conta antes de alterá-la.";
            self.chats.exclusive(&provider, &p.id, refusal, Hold::Nothing, move || edit_document(&host, &id, change).map(drop)).await?;
            self.profile_changed(&p.id);
        }
        self.changed().await
    }

    async fn rename(&self, p: RenameProfileParams) -> Result<Value, HostError> {
        let name: String = p.name.trim().chars().take(80).collect();
        if name.is_empty() {
            return Err(invalid("Informe um nome."));
        }
        let _change = self.changes.lock().await;
        self.edit(&p.id, move |doc| {
            doc.insert("name".into(), Value::String(name));
        })
        .await?;
        self.changed().await
    }

    /// Tombstoned (old references read as removed), its chats moved to the
    /// terminal account, everything still running on it told to close and its
    /// login awaited, and only then its own folder deleted (`runProfileRemoval`).
    async fn remove(&self, p: ProfileIdParams) -> Result<Value, HostError> {
        if p.id.is_empty() || p.id.starts_with("ambient-") {
            return Err(invalid("A conta do terminal é gerenciada pelo terminal e não pode ser removida."));
        }
        let _change = self.changes.lock().await;
        let stored = self.stored(&p.id).await?.filter(|doc| doc.get("tombstoned").and_then(Value::as_bool) != Some(true));
        let Some(doc) = stored else { return Err(not_found(NOT_FOUND)) };
        let provider = doc.get("provider").and_then(Value::as_str).unwrap_or_default().to_string();
        // Its chats moved to the terminal account and itself tombstoned, while
        // no turn runs on it and none can start until both are done.
        let (host, id) = (Arc::clone(&self.host_profiles), p.id.clone());
        self.chats
            .exclusive(&provider, &p.id, "Pare as tarefas desta conta antes de removê-la.", Hold::Reassign, move || {
                edit_document(&host, &id, |doc| {
                    doc.insert("tombstoned".into(), Value::Bool(true));
                    doc.insert("enabled".into(), Value::Bool(false));
                })
                .map(drop)
            })
            .await?;
        self.profile_changed(&p.id);
        self.logins.end(&p.id, Duration::from_secs(3)).await;
        let host = Arc::clone(&self.host_profiles);
        let id = p.id.clone();
        let outcome = blocking(move || Ok(profiles::remove_profile_folder(host.root(), &id, now_ms()))).await?;
        if outcome == FolderRemoval::Kept {
            tracing::warn!(profile = %p.id, "a pasta do perfil removido continua em uso; nova tentativa no próximo início");
        }
        self.changed().await
    }

    /// Checked and started as one change: a link, a removal or a second login
    /// of the profile never lands between the checks and the start.
    async fn login(&self, p: LoginParams, ctx: &CallContext) -> Result<Value, HostError> {
        let Some(provider) = provider(&p.provider) else { return Err(invalid("Agente inválido.")) };
        let _change = self.changes.lock().await;
        let profile = {
            let profiles = self.profiles.clone();
            let id = p.id.clone();
            blocking(move || profiles.get(provider, &id).map_err(profile_error)).await?
        };
        // `loginRefusal`: a Traycer link, live or broken, always refuses.
        if self.running(&p.id, ctx).await? {
            return Err(busy("Pare as tarefas desta conta antes de fazer login novamente."));
        }
        if profile.ambient {
            return Err(invalid("Adicione uma conta para fazer login sem alterar a conta do terminal."));
        }
        if profile.credential_link.is_some() {
            return Err(invalid(LINKED_LOGIN_REFUSAL));
        }
        if self.logins.is_open(&p.id) {
            return Err(busy(login::ALREADY_OPEN));
        }
        let Some(command) = self.profiles.command(provider, Some(&p.id)).await else {
            let name = if provider == Provider::Claude { "Claude Code" } else { "Codex" };
            return Err(HostError::new(ErrorCode::CliMissing, format!("Instale {name} e tente novamente.")));
        };
        let env = {
            let profiles = self.profiles.clone();
            let id = p.id.clone();
            blocking(move || profiles.environment(provider, Some(&id)).map_err(profile_error)).await?
        };
        let session = login::session_id(p.session.as_deref()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let (cols, rows) = login::terminal_size(p.cols, p.rows);
        let args: Vec<String> = match provider {
            Provider::Claude => vec!["auth".into(), "login".into(), "--claudeai".into()],
            Provider::Codex => vec!["login".into(), "--device-auth".into(), "-c".into(), "cli_auth_credentials_store=\"file\"".into()],
        };
        // The CLI's exit may mean a new login: the account's cached reads and idle processes go.
        let changed = Arc::new((self.claude.clone(), Arc::clone(&self.codex), Arc::clone(&self.catalogs)));
        let id = p.id.clone();
        let on_exit: Box<dyn FnOnce() + Send> = Box::new(move || {
            if let Some(claude) = &changed.0 {
                claude.profile_changed(&id);
            }
            changed.1.profile_changed(&id);
            changed.2.forget(&id);
        });
        let request = LoginRequest {
            profile_id: p.id.clone(),
            session: session.clone(),
            cols,
            rows,
            owner: ctx.notifier.client,
            notifier: ctx.notifier.clone(),
            command,
            args,
            env,
            cwd: home_dir(),
            on_exit,
            runtime: tokio::runtime::Handle::current(),
        };
        let logins = Arc::clone(&self.logins);
        blocking(move || {
            logins.start(request).map_err(|err| if err == login::ALREADY_OPEN { busy(err) } else { internal(format!("Não foi possível abrir o login: {err}")) })
        })
        .await?;
        answer(LoginStarted { session })
    }

    /// The Traycer import's profiles (inserted or replaced as given).
    async fn import_profiles(&self, p: ImportProfilesParams) -> Result<Value, HostError> {
        for doc in &p.profiles {
            let id = doc.get("id").and_then(Value::as_str).unwrap_or_default();
            let provider_ok = doc.get("provider").and_then(Value::as_str).and_then(provider).is_some();
            if !profiles::is_profile_folder_name(id) || id.starts_with("ambient-") || !provider_ok || !doc.get("name").is_some_and(Value::is_string) {
                return Err(invalid("Perfil inválido."));
            }
        }
        let _change = self.changes.lock().await;
        let host = Arc::clone(&self.host_profiles);
        let docs = p.profiles;
        let ids: Vec<String> = docs.iter().filter_map(|d| d.get("id").and_then(Value::as_str).map(str::to_string)).collect();
        blocking(move || {
            for doc in &docs {
                let id = doc.get("id").and_then(Value::as_str).unwrap_or_default();
                create_private_dir(&host.root().join(id)).map_err(|err| internal(format!("Não foi possível criar a pasta da conta: {err}")))?;
                host.put(doc)?;
            }
            Ok(())
        })
        .await?;
        for id in &ids {
            self.profile_changed(id);
        }
        self.changed().await
    }

    /// Links a profile to a Traycer account's login, or back to its own
    /// (`setTraycerLogin`): the chats resuming its sessions start new ones,
    /// and a linked profile's old copied login is retired, never deleted. All
    /// of it while no turn runs on the profile and none can start, so its old
    /// copy never runs next to the link.
    async fn set_link(&self, p: SetLinkParams) -> Result<Value, HostError> {
        let _change = self.changes.lock().await;
        let stored = self.stored(&p.id).await?.filter(|doc| doc.get("tombstoned").and_then(Value::as_bool) != Some(true));
        let Some(doc) = stored else { return Err(not_found(NOT_FOUND)) };
        let Some(provider) = doc.get("provider").and_then(Value::as_str).and_then(provider) else { return Err(not_found(NOT_FOUND)) };
        let name = doc.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        match &p.link {
            Some(link) => {
                if link.provider_id != provider.traycer_id() {
                    return Err(invalid("Esta conta não foi importada desta instalação do Traycer."));
                }
                let account = traycer_account(Path::new(&link.root), provider, &link.profile_id);
                // macOS keeps Claude's login in the Keychain under the folder: the folder is the login.
                let has_login = account.is_some_and(|a| (cfg!(target_os = "macos") && provider == Provider::Claude) || a.home.join(provider.credential_file()).is_file());
                if !has_login {
                    return Err(invalid("O Traycer não tem um login ativo para esta conta. Entre nela pelo Traycer e tente de novo."));
                }
            }
            None if doc.get("credentialLink").is_none() => return self.changed().await,
            None => {}
        }
        let refusal = format!("Pare as tarefas da conta “{name}” antes de trocar o login dela.");
        let (host, id, link) = (Arc::clone(&self.host_profiles), p.id.clone(), p.link.clone());
        self.chats
            .exclusive(provider.as_str(), &p.id, refusal, Hold::ForgetSessions, move || {
                let linking = link.is_some();
                edit_document(&host, &id, move |doc| match link {
                    Some(link) => {
                        doc.insert("credentialLink".into(), json!({ "root": link.root, "providerId": link.provider_id, "profileId": link.profile_id }));
                    }
                    None => {
                        doc.remove("credentialLink");
                    }
                })?;
                if linking {
                    retire_own_login(host.root(), &id, provider);
                }
                Ok(())
            })
            .await?;
        self.profile_changed(&p.id);
        self.changed().await
    }

    /// What an earlier removal could not delete (trash, folders of removed
    /// profiles), once per host run, in the background.
    fn purge_once(self: &Arc<Self>) {
        let me = Arc::clone(self);
        self.purged.call_once(move || {
            let _ = std::thread::Builder::new().name("profiles-purge".into()).spawn(move || {
                let removed: Vec<String> = me
                    .host_profiles
                    .documents()
                    .unwrap_or_default()
                    .iter()
                    .filter(|d| d.get("tombstoned").and_then(Value::as_bool) == Some(true))
                    .filter_map(|d| d.get("id").and_then(Value::as_str).map(str::to_string))
                    .collect();
                let purged = profiles::purge_profile_trash(me.host_profiles.root(), &removed);
                if purged > 0 {
                    tracing::info!(purged, "pastas de perfis removidos apagadas");
                }
            });
        });
    }
}

#[cfg(test)]
mod tests;

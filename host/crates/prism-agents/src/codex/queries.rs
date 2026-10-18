//! One-shot Codex reads, each on a short-lived app-server like the app does
//! today: the model catalog (src/main/ipc/agentModels.ts), the `/` skills
//! (src/main/ipc/agentCommands.ts), the account's limits and plan
//! (`profileUsage` in src/main/providerUsage.ts) and the manual reset
//! (`consumeCodexResetCredit`).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tokio::sync::watch;

use super::convert::{codex_details, codex_models, codex_reset_outcome, codex_skill_commands};
use super::server::AppServer;
use super::{CodexError, Launcher};

pub const CATALOG_TTL: Duration = Duration::from_secs(300);
pub const DETAILS_TTL: Duration = Duration::from_secs(60);
pub const DETAILS_ERROR_TTL: Duration = Duration::from_secs(30);
pub const DETAILS_ERROR: &str = "Não foi possível consultar o uso. Verifique o login, a conexão e a versão da CLI e atualize novamente.";

type Shared = watch::Receiver<Option<Result<Value, CodexError>>>;

enum Slot {
    Ready(Instant, Value),
    Pending(u64, Shared),
}

type Slots = Mutex<HashMap<String, (String, Slot)>>;

/// Results cached per key for a while; concurrent callers share one read,
/// and `refresh` starts a new one.
#[derive(Default)]
struct Memo {
    slots: Slots,
    generation: std::sync::atomic::AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A read in flight. Dropped before it settles (its caller went away), it
/// frees the key so the next caller reads again instead of waiting forever.
struct Claim<'a> {
    slots: &'a Slots,
    key: &'a str,
    generation: u64,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        let mut slots = lock(self.slots);
        if matches!(slots.get(self.key), Some((_, Slot::Pending(g, _))) if *g == self.generation) {
            slots.remove(self.key);
        }
    }
}

impl Memo {
    async fn get<F>(&self, key: String, profile: &str, ttl: Duration, refresh: bool, read: F) -> Result<Value, CodexError>
    where
        F: Future<Output = Result<Value, CodexError>>,
    {
        // One lock decides between the kept value, the read in flight and a
        // read of our own, so two first callers never start two servers.
        let (generation, tx) = loop {
            let mut waiting = {
                let mut slots = lock(&self.slots);
                match slots.get(&key) {
                    Some((_, Slot::Ready(expires, value))) if !refresh && *expires > Instant::now() => return Ok(value.clone()),
                    Some((_, Slot::Pending(_, rx))) if !refresh => rx.clone(),
                    _ => {
                        let generation = self.generation.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let (tx, rx) = watch::channel(None);
                        slots.insert(key.clone(), (profile.to_string(), Slot::Pending(generation, rx)));
                        break (generation, tx);
                    }
                }
            };
            if let Ok(result) = waiting.wait_for(Option::is_some).await
                && let Some(result) = result.clone()
            {
                return result;
            }
            // Its reader went away (its claim freed the key): decide again.
        };
        let claim = Claim { slots: &self.slots, key: &key, generation };
        let result = read.await;
        {
            let mut slots = lock(&self.slots);
            if matches!(slots.get(&key), Some((_, Slot::Pending(g, _))) if *g == generation) {
                match &result {
                    Ok(value) => {
                        slots.insert(key.clone(), (profile.to_string(), Slot::Ready(Instant::now() + ttl, value.clone())));
                    }
                    Err(_) => {
                        slots.remove(&key);
                    }
                }
            }
        }
        drop(claim);
        let _ = tx.send(Some(result.clone()));
        result
    }

    fn forget(&self, profile: &str) {
        lock(&self.slots).retain(|_, (owner, _)| owner != profile);
    }
}

#[derive(Default)]
struct DetailsEntry {
    expires: Option<Instant>,
    value: Option<Value>,
    pending: Option<watch::Receiver<Option<Value>>>,
}

pub struct CodexQueries {
    launcher: Arc<dyn Launcher>,
    models: Memo,
    skills: Memo,
    details: Mutex<HashMap<String, DetailsEntry>>,
    resetting: Mutex<HashSet<String>>,
}

/// Closes a one-shot server however the read ends.
struct Closing(Arc<AppServer>);

impl Drop for Closing {
    fn drop(&mut self) {
        self.0.close();
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl CodexQueries {
    pub fn new(launcher: Arc<dyn Launcher>) -> Arc<Self> {
        Arc::new(Self {
            launcher,
            models: Memo::default(),
            skills: Memo::default(),
            details: Mutex::new(HashMap::new()),
            resetting: Mutex::new(HashSet::new()),
        })
    }

    async fn open(&self, profile: &str, cwd: Option<String>) -> Result<Closing, CodexError> {
        let server = Closing(self.launcher.launch(profile.to_string(), cwd).await?);
        server.0.ready().await.map_err(CodexError::failed)?;
        Ok(server)
    }

    /// The visible models as `AgentModel[]`, default first. Cached 5 min.
    pub async fn models(&self, profile: &str, refresh: bool) -> Result<Value, CodexError> {
        let read = async {
            let server = self.open(profile, None).await?;
            let mut rows = Vec::new();
            let mut cursor: Option<Value> = None;
            loop {
                let mut params = json!({ "limit": 100 });
                if let Some(cursor) = &cursor {
                    params["cursor"] = cursor.clone();
                }
                let page = server.0.request("model/list", params).await.map_err(CodexError::failed)?;
                rows.extend(page.get("data").and_then(Value::as_array).cloned().unwrap_or_default());
                cursor = page.get("nextCursor").filter(|c| c.as_str().is_some_and(|s| !s.is_empty())).cloned();
                if cursor.is_none() {
                    break;
                }
            }
            Ok(Value::Array(codex_models(&rows)))
        };
        self.models.get(profile.to_string(), profile, CATALOG_TTL, refresh, read).await
    }

    /// The enabled skills of an account and folder as `/` menu rows. Cached 5 min.
    pub async fn skills(&self, profile: &str, cwd: &str, refresh: bool) -> Result<Value, CodexError> {
        let key = json!([profile, cwd]).to_string();
        let read = async {
            let server = self.open(profile, Some(cwd.to_string()).filter(|c| !c.is_empty())).await?;
            let cwds = if cwd.is_empty() { json!([]) } else { json!([cwd]) };
            let listing = server.0.request("skills/list", json!({ "cwds": cwds })).await.map_err(CodexError::failed)?;
            Ok(Value::Array(codex_skill_commands(&listing)))
        };
        self.skills.get(key, profile, CATALOG_TTL, refresh, read).await
    }

    async fn read_details(&self, profile: &str) -> Result<Value, CodexError> {
        let server = self.open(profile, None).await?;
        let account = server.0.request("account/read", json!({ "refreshToken": false })).await.map_err(CodexError::failed)?;
        let limits = server.0.request("account/rateLimits/read", json!({})).await.map_err(CodexError::failed)?;
        Ok(codex_details(&account, &limits, now_ms()))
    }

    /// Limits, plan and resets (`ProfileDetails`). The profile is validated
    /// even when cached; a failed read keeps the last good snapshot, marked
    /// stale. Cached 1 min (30 s after a failure).
    pub async fn details(&self, profile: &str, refresh: bool) -> Result<Value, CodexError> {
        self.launcher.account(profile.to_string()).await?;
        let claimed = {
            let mut details = self.details.lock().unwrap();
            let entry = details.entry(profile.to_string()).or_default();
            match (&entry.pending, &entry.value, entry.expires) {
                (Some(pending), _, _) => Err(Some(pending.clone())),
                (None, Some(value), Some(expires)) if !refresh && expires > Instant::now() => return Ok(value.clone()),
                _ => {
                    let (tx, rx) = watch::channel(None);
                    entry.pending = Some(rx);
                    entry.expires = None;
                    Ok((tx, entry.value.clone()))
                }
            }
        };
        let (tx, previous) = match claimed {
            Ok(claimed) => claimed,
            Err(pending) => return wait_details(pending).await,
        };
        let mine = tx.subscribe();
        let value = match self.read_details(profile).await {
            Ok(value) => value,
            Err(_) => {
                let mut fallback = previous.clone().filter(Value::is_object).unwrap_or_else(|| json!({ "limits": [] }));
                fallback["stale"] = json!(previous.is_some());
                fallback["error"] = json!(DETAILS_ERROR);
                fallback
            }
        };
        let ttl = if value.get("error").is_some() { DETAILS_ERROR_TTL } else { DETAILS_TTL };
        {
            // A reset or login that dropped the entry meanwhile wins: this read is not cached.
            let mut details = self.details.lock().unwrap();
            if let Some(entry) = details.get_mut(profile)
                && entry.pending.as_ref().is_some_and(|p| p.same_channel(&mine))
            {
                entry.value = Some(value.clone());
                entry.expires = Some(Instant::now() + ttl);
                entry.pending = None;
            }
        }
        let _ = tx.send(Some(value.clone()));
        Ok(value)
    }

    /// Drops what is cached for a profile (a login or reset changed it).
    pub fn forget(&self, profile: &str) {
        self.models.forget(profile);
        self.skills.forget(profile);
        self.forget_details(profile);
    }

    fn forget_details(&self, profile: &str) {
        self.details.lock().unwrap().remove(profile);
    }

    /// Spends one real Codex manual reset. The caller's idempotency key makes a
    /// retried click safe; one reset at a time per account, never for a
    /// disabled profile. The usage snapshot is dropped afterwards.
    pub async fn reset(&self, profile: &Value, idempotency_key: &Value, credit_id: &Value) -> Result<&'static str, CodexError> {
        let profile = profile.as_str().filter(|p| !p.is_empty()).ok_or_else(|| CodexError::invalid("Perfil inválido."))?;
        let key = idempotency_key
            .as_str()
            .filter(|k| (8..=128).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
            .ok_or_else(|| CodexError::invalid("Chave de idempotência inválida."))?;
        let credit = match credit_id {
            Value::Null => None,
            Value::String(id) if !id.is_empty() && id.encode_utf16().count() <= 256 => Some(id.as_str()),
            _ => return Err(CodexError::invalid("Redefinição manual inválida.")),
        };
        // Unknown, removed, non-Codex or disabled profiles stop here.
        let account = self.launcher.account(profile.to_string()).await?;
        if !self.resetting.lock().unwrap().insert(account.clone()) {
            return Err(CodexError::busy("Já há uma redefinição manual em andamento para esta conta."));
        }
        let result = async {
            let server = self.open(profile, None).await?;
            let params = match credit {
                Some(credit) => json!({ "idempotencyKey": key, "creditId": credit }),
                None => json!({ "idempotencyKey": key }),
            };
            let reply = server.0.request("account/rateLimitResetCredit/consume", params).await.map_err(CodexError::failed)?;
            codex_reset_outcome(&reply).map_err(CodexError::failed)
        }
        .await;
        self.resetting.lock().unwrap().remove(&account);
        self.forget_details(profile);
        result.map_err(|err| {
            if err.message.starts_with("Tempo esgotado") {
                CodexError::failed("Tempo esgotado ao usar a redefinição manual do Codex.")
            } else {
                err
            }
        })
    }
}

async fn wait_details(pending: Option<watch::Receiver<Option<Value>>>) -> Result<Value, CodexError> {
    let Some(mut pending) = pending else { return Err(CodexError::failed(DETAILS_ERROR)) };
    match pending.wait_for(Option::is_some).await {
        Ok(value) => Ok(value.clone().unwrap_or_else(|| json!({ "limits": [], "error": DETAILS_ERROR }))),
        Err(_) => Err(CodexError::failed(DETAILS_ERROR)),
    }
}

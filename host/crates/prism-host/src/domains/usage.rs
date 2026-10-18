//! `usage.*` (T08): Settings ▸ Uso's records on the host, the port of
//! `usageRecords` (src/main/ipc/usage.ts).
//!
//! Prism's turns come from the host's own database: the chats (folded), the
//! tasks and the journal's `begin`/`session` events. The Traycer turns come
//! from the desktop's `prism-usage.db`, which the desktop's main imports into
//! and the host only reads; a host without one (a VPS) has none. Importing
//! from Traycer, copying or saving the image and revealing a saved file stay
//! in the desktop's main.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use prism_agents::profile_env::Profiles;
use prism_protocol::providers::usage_methods;
use prism_protocol::{ErrorCode, HostError};
use prism_store::{kinds, read_desktop_turn_runs, read_traycer_usage, Store, TraycerUsage, TurnRun};
use serde::{Serialize, Serializer};
use serde_json::{json, Value};

use crate::domain::{CallContext, Domain, HandlerFuture};
use crate::domains::store::{store_error, SharedStore};

const TERMINAL_ACCOUNT: &str = "Conta do terminal";

/// How a counter relates to the turn it is stored on (`UsageCounterBasis`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Basis {
    Turn,
    Cumulative,
    LastCall,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Completed,
    Interrupted,
    Error,
}

/// What a run's metrics mean for its turn (`prismCounters`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counters {
    pub token_basis: Basis,
    pub cost_basis: Basis,
    #[serde(serialize_with = "js_opt")]
    pub input_tokens: Option<f64>,
    #[serde(serialize_with = "js_opt")]
    pub cache_read_tokens: Option<f64>,
    #[serde(serialize_with = "js_opt")]
    pub cache_write_tokens: Option<f64>,
    #[serde(serialize_with = "js_opt")]
    pub output_tokens: Option<f64>,
    #[serde(serialize_with = "js_opt")]
    pub reasoning_tokens: Option<f64>,
    #[serde(serialize_with = "js_opt")]
    pub cost_usd: Option<f64>,
}

impl Counters {
    const NONE: Counters = Counters {
        token_basis: Basis::None,
        cost_basis: Basis::None,
        input_tokens: None,
        cache_read_tokens: None,
        cache_write_tokens: None,
        output_tokens: None,
        reasoning_tokens: None,
        cost_usd: None,
    };
}

/// One of Prism's assistant turns as recorded (`UsageObservation` with
/// `source: 'prism'`), before session totals become per-turn deltas.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    /// `prism:${chatId}:${turnId}`.
    pub id: String,
    pub source: &'static str,
    pub chat_id: String,
    pub turn_id: String,
    pub chat_title: String,
    pub task_id: Option<String>,
    pub task_title: Option<String>,
    pub project: Option<String>,
    pub provider: String,
    pub model: String,
    pub profile_id: Option<String>,
    pub profile_name: String,
    pub session_key: Option<String>,
    #[serde(serialize_with = "js_num")]
    pub started_at: f64,
    #[serde(serialize_with = "js_opt")]
    pub completed_at: Option<f64>,
    #[serde(serialize_with = "js_opt")]
    pub duration_ms: Option<f64>,
    pub outcome: Outcome,
    pub prism_chat_id: String,
    #[serde(flatten)]
    pub counters: Counters,
}

/// `UsageRecordsResponse`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecords {
    pub observations: Vec<Value>,
    pub import_state: Value,
    pub generated_at: i64,
}

/// The journal's runs by `(chatId, turnId)`.
pub type Journal = HashMap<(String, String), TurnRun>;

/// The runs by turn, a later run's route and session winning over an
/// earlier one's (`journalTurns`: the desktop's journal first, the host's last).
pub fn journal(runs: Vec<TurnRun>) -> Journal {
    let mut map = Journal::new();
    for run in runs {
        let entry = map
            .entry((run.chat_id.clone(), run.turn_id.clone()))
            .or_insert_with(|| TurnRun { chat_id: run.chat_id.clone(), turn_id: run.turn_id.clone(), ..TurnRun::default() });
        if run.route.is_some() {
            entry.route = run.route;
        }
        if run.session_id.is_some() {
            entry.session_id = run.session_id;
        }
    }
    map
}

/// The last path segment, for a workspace's display name.
pub fn project_name(cwd: Option<&str>) -> Option<String> {
    cwd.unwrap_or_default().split(['\\', '/']).rfind(|part| !part.is_empty()).map(str::to_string)
}

/// Prism's assistant turns that actually ran here. Transcripts imported from
/// Traycer carry neither a start time nor metrics, so they are skipped (their
/// usage comes from the Traycer import instead). A turn still running is
/// picked up once it completes.
pub fn prism_observations(chats: &[Value], tasks: &[Value], profile_names: &HashMap<String, String>, journal: &Journal) -> Vec<Observation> {
    let task_titles: HashMap<&str, &str> =
        tasks.iter().filter_map(|t| Some((t.get("id")?.as_str()?, t.get("title")?.as_str()?))).collect();
    let mut observations = Vec::new();
    for chat in chats {
        let chat_id = chat.get("id").and_then(Value::as_str).unwrap_or_default();
        let selection = chat.get("selection");
        let selected_provider = selection.and_then(|s| s.get("provider")).and_then(Value::as_str);
        let task_id = chat.get("taskId").and_then(Value::as_str);
        for turn in chat.get("turns").and_then(Value::as_array).into_iter().flatten() {
            // `===`: a missing id and a missing pending turn are equal too.
            if turn.get("role").and_then(Value::as_str) != Some("assistant") || chat.get("pendingTurnId") == turn.get("id") {
                continue;
            }
            if !truthy(turn.get("metrics")) && !truthy(turn.get("startedAt")) {
                continue;
            }
            let turn_id = turn.get("id").and_then(Value::as_str).unwrap_or_default();
            let run = journal.get(&(chat_id.to_string(), turn_id.to_string()));
            let (route_provider, route_profile) = run.and_then(|r| r.route.as_deref()).map_or(("", ""), |route| route.split_once(':').unwrap_or((route, "")));
            let provider = filled(turn.get("provider")).or(text(route_provider)).or(selected_provider).unwrap_or_default().to_string();
            let profile_id = match text(route_profile) {
                Some(id) => Some(id.to_string()),
                None if Some(provider.as_str()) == selected_provider => {
                    selection.and_then(|s| s.get("profileId")).and_then(Value::as_str).map(str::to_string)
                }
                None => None,
            };
            let started = turn.get("startedAt");
            let completed_at = num(turn.get("completedAt"));
            let duration_ms = match nullish(turn.get("durationMs")) {
                Some(duration) => duration.as_f64(),
                None => match (num(started).filter(|s| *s != 0.0), completed_at.filter(|c| *c != 0.0)) {
                    (Some(started), Some(completed)) => Some((completed - started).max(0.0)),
                    _ => None,
                },
            };
            let outcome = if truthy(turn.get("error")) {
                Outcome::Error
            } else if truthy(turn.get("interrupted")) {
                Outcome::Interrupted
            } else {
                Outcome::Completed
            };
            let metrics = turn.get("metrics");
            let profile_name = filled(turn.get("profileName"))
                .or_else(|| profile_id.as_deref().filter(|id| !id.is_empty()).and_then(|id| profile_names.get(id)).map(String::as_str).filter(|n| !n.is_empty()))
                .unwrap_or(TERMINAL_ACCOUNT);
            observations.push(Observation {
                id: format!("prism:{chat_id}:{turn_id}"),
                source: "prism",
                chat_id: chat_id.to_string(),
                turn_id: turn_id.to_string(),
                chat_title: chat.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
                task_id: task_id.map(str::to_string),
                task_title: task_id.filter(|id| !id.is_empty()).and_then(|id| task_titles.get(id)).map(|t| t.to_string()),
                project: project_name(chat.get("cwd").and_then(Value::as_str)),
                // The model the provider reported, when recorded; else the one chosen (maybe an alias).
                model: filled(metrics.and_then(|m| m.get("model"))).or(filled(turn.get("model"))).unwrap_or_default().to_string(),
                profile_name: profile_name.to_string(),
                session_key: run.and_then(|r| r.session_id.clone()),
                started_at: nullish(started).or(nullish(turn.get("completedAt"))).or(nullish(chat.get("updatedAt"))).and_then(Value::as_f64).unwrap_or(0.0),
                completed_at,
                duration_ms,
                outcome,
                prism_chat_id: chat_id.to_string(),
                counters: prism_counters(&provider, metrics),
                provider,
                profile_id,
            });
        }
    }
    observations
}

/// What a run's metrics mean, per provider:
/// - the runtime's per-turn measure (`metrics.turn`), when it has one, as is
///   (a cost it could not measure stays absent);
/// - older Claude runs: `result.usage` is the turn's own main-loop usage,
///   while `total_cost_usd` is the session's running total;
/// - older Codex runs: `tokenUsage.total` is the thread's running total, input
///   including cached input; no cost.
pub fn prism_counters(provider: &str, metrics: Option<&Value>) -> Counters {
    let Some(metrics) = metrics.filter(|m| truthy(Some(m))) else {
        return Counters::NONE;
    };
    if let Some(turn) = metrics.get("turn").filter(|t| t.is_object() || t.is_array()) {
        let cost = num(turn.get("costUsd"));
        return Counters {
            token_basis: Basis::Turn,
            cost_basis: if cost.is_some() { Basis::Turn } else { Basis::None },
            input_tokens: num(turn.get("inputTokens")),
            cache_read_tokens: num(turn.get("cacheReadTokens")),
            cache_write_tokens: num(turn.get("cacheWriteTokens")),
            output_tokens: num(turn.get("outputTokens")),
            reasoning_tokens: num(turn.get("reasoningTokens")),
            cost_usd: cost,
        };
    }
    let (input, cached) = (num(metrics.get("inputTokens")), num(metrics.get("cachedTokens")));
    if provider == "codex" {
        return Counters {
            token_basis: Basis::Cumulative,
            cost_basis: Basis::None,
            input_tokens: input.map(|input| (input - cached.unwrap_or(0.0)).max(0.0)),
            cache_read_tokens: cached,
            cache_write_tokens: None,
            output_tokens: num(metrics.get("outputTokens")),
            reasoning_tokens: num(metrics.get("reasoningTokens")),
            cost_usd: None,
        };
    }
    let cost = num(metrics.get("costUsd"));
    Counters {
        token_basis: Basis::Turn,
        cost_basis: if cost.is_some() { Basis::Cumulative } else { Basis::None },
        input_tokens: input,
        cache_read_tokens: cached,
        cache_write_tokens: num(metrics.get("cacheWriteTokens")),
        output_tokens: num(metrics.get("outputTokens")),
        reasoning_tokens: num(metrics.get("reasoningTokens")),
        cost_usd: cost,
    }
}

/// Imported Traycer turns (`traycer_turns` bodies), linked to their Prism
/// copy when the chat was imported too (`traycerSource`). Bodies that are not
/// an observation are skipped.
pub fn traycer_observations(chats: &[Value], bodies: &[String]) -> Vec<Value> {
    let mut linked: HashMap<String, &str> = HashMap::new();
    for chat in chats {
        let Some(source) = chat.get("traycerSource").filter(|s| truthy(Some(s))) else { continue };
        let (Some(epic), Some(chat_id), Some(id)) = (
            source.get("epicId").and_then(Value::as_str),
            source.get("chatId").and_then(Value::as_str),
            chat.get("id").and_then(Value::as_str),
        ) else {
            continue;
        };
        linked.insert(format!("{epic}/{chat_id}"), id);
    }
    bodies
        .iter()
        .filter_map(|body| {
            let Ok(Value::Object(mut observation)) = serde_json::from_str::<Value>(body) else { return None };
            let chat_id = observation.get("chatId").and_then(Value::as_str)?;
            observation.get("id").and_then(Value::as_str)?;
            let prism_chat = linked.get(chat_id).map_or(Value::Null, |id| json!(id));
            observation.insert("prismChatId".into(), prism_chat);
            Some(Value::Object(observation))
        })
        .collect()
}

/// The last Traycer import as stored, over `never` for whatever it lacks.
pub fn import_state(body: Option<&str>) -> Value {
    let mut state = json!({
        "status": "never", "at": null, "root": null, "tasks": 0, "chats": 0, "turns": 0,
        "added": 0, "updated": 0, "unchanged": 0, "warnings": [], "error": null
    });
    if let (Some(Ok(Value::Object(stored))), Some(state)) = (body.map(serde_json::from_str::<Value>), state.as_object_mut()) {
        state.extend(stored);
    }
    state
}

/// The import state when `prism-usage.db` cannot be read: an error, so the
/// panel says so instead of "not imported yet".
pub fn unreadable_import(at: i64) -> Value {
    let mut state = import_state(None);
    state["status"] = json!("error");
    state["at"] = json!(at);
    state["error"] = json!(UNREADABLE_USAGE);
    state
}

const UNREADABLE_USAGE: &str = "Não foi possível ler o uso importado do Traycer. Importe de novo.";

/// `usage.records`: Prism's turns, then the imported Traycer ones. The
/// journals (the desktop's own, `prism-agents.db`, for the turns a window
/// still drives itself, then the host's) and the account names only add
/// detail: left out when they cannot be read, as the desktop did. An
/// unreadable `prism-usage.db` leaves the Traycer turns out and says so in
/// the import state.
pub fn records(store: &Store, profiles: &Profiles, usage_db: Option<&Path>, desktop_journal: Option<&Path>) -> Result<UsageRecords, HostError> {
    let chats = store.chats().map_err(store_error)?;
    let tasks = store.documents(kinds::TASKS).map_err(store_error)?;
    let mut runs = match desktop_journal.map(read_desktop_turn_runs).transpose() {
        Ok(runs) => runs.flatten().unwrap_or_default(),
        Err(err) => {
            tracing::warn!(%err, "diário do app ilegível: os turnos que a janela conduz seguem sem rota nem sessão");
            Vec::new()
        }
    };
    runs.extend(store.turn_runs().unwrap_or_else(|err| {
        tracing::warn!(%err, "diário ilegível: o uso segue sem rota nem sessão dos turnos");
        Vec::new()
    }));
    let names: HashMap<String, String> = match profiles.list() {
        Ok(list) => list.into_iter().map(|p| (p.id, p.name)).collect(),
        Err(err) => {
            tracing::warn!(%err, "contas ilegíveis: o uso segue sem os nomes delas");
            HashMap::new()
        }
    };
    let (traycer, state) = match usage_db.map(read_traycer_usage).transpose() {
        Ok(usage) => {
            let usage = usage.flatten().unwrap_or_default();
            let state = import_state(usage.import_state.as_deref());
            (usage, state)
        }
        Err(err) => {
            tracing::warn!(%err, "prism-usage.db ilegível: o uso segue sem os turnos do Traycer");
            (TraycerUsage::default(), unreadable_import(now_ms()))
        }
    };
    let mut observations = Vec::new();
    for observation in prism_observations(&chats, &tasks, &names, &journal(runs)) {
        observations.push(serde_json::to_value(observation).map_err(|err| HostError::new(ErrorCode::Internal, err.to_string()))?);
    }
    observations.extend(traycer_observations(&chats, &traycer.turns));
    Ok(UsageRecords { observations, import_state: state, generated_at: now_ms() })
}

pub struct UsageDomain {
    store: Arc<SharedStore>,
    profiles: Profiles,
    /// The desktop's `prism-usage.db`, read only; `None` without a desktop.
    usage_db: Option<PathBuf>,
    /// The desktop's own journal (`prism-agents.db`), read only.
    desktop_journal: Option<PathBuf>,
}

impl UsageDomain {
    pub fn new(store: Arc<SharedStore>, profiles: Profiles, usage_db: Option<PathBuf>) -> Self {
        Self { store, profiles, usage_db, desktop_journal: None }
    }

    /// Also reads the desktop's own journal, where a window still records the
    /// turns it drives itself (SSH).
    pub fn with_desktop_journal(mut self, path: Option<PathBuf>) -> Self {
        self.desktop_journal = path;
        self
    }
}

impl Domain for UsageDomain {
    fn name(&self) -> &'static str {
        "usage"
    }

    fn call(&self, method: &str, _params: Value, _ctx: CallContext) -> Option<HandlerFuture> {
        if method != usage_methods::RECORDS {
            return None;
        }
        let (shared, profiles, usage_db, desktop_journal) = (Arc::clone(&self.store), self.profiles.clone(), self.usage_db.clone(), self.desktop_journal.clone());
        Some(Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let store = shared.get()?;
                let records = records(&store, &profiles, usage_db.as_deref(), desktop_journal.as_deref())?;
                serde_json::to_value(records).map_err(|err| HostError::new(ErrorCode::Internal, err.to_string()))
            })
            .await
            .map_err(|err| HostError::new(ErrorCode::Internal, format!("Falha ao ler o uso: {err}")))?
        }))
    }
}

/// JavaScript truthiness; `None` is `undefined`.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `value ?? …`: present and not `null`.
fn nullish(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

/// A non-empty string (`value || …` on a string field).
fn filled(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `text()` of usage.ts: a string with something besides whitespace.
fn text(value: &str) -> Option<&str> {
    Some(value).filter(|s| !s.trim().is_empty())
}

/// `num()` of usage.ts: a finite number (JSON has no other kind).
fn num(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A number as `JSON.stringify` writes it: integral values without a fraction.
fn js_num<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

fn js_opt<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(value) => js_num(value, serializer),
        None => serializer.serialize_none(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{next_client_id, Notifier};
    use crate::HostState;
    use prism_agents::profile_env::{ProfileError, ProfileErrorKind, ProfileSource, StoredProfile};
    use prism_protocol::{Role, UserInfo};
    use prism_store::NewEvent;
    use tokio::sync::mpsc;

    fn ctx() -> CallContext {
        let (tx, _rx) = mpsc::unbounded_channel();
        CallContext {
            user: UserInfo { id: "owner".into(), name: "qa".into(), role: Role::Owner },
            notifier: Notifier::new(next_client_id(), tx),
            state: HostState::with_domains("t".into(), "h".into(), "Máquina".into(), "qa".into(), Vec::new()),
        }
    }

    /// A profile source with fixed contents, or one that cannot be read.
    struct Fake(Option<Vec<StoredProfile>>);

    impl ProfileSource for Fake {
        fn stored(&self) -> Result<Vec<StoredProfile>, ProfileError> {
            self.0.clone().ok_or(ProfileError { kind: ProfileErrorKind::Unreadable, message: "ilegível".into() })
        }
        fn own_home(&self, profile_id: &str) -> PathBuf {
            std::env::temp_dir().join("prism-usage-tests").join(profile_id)
        }
    }

    fn profiles(source: Fake) -> (Profiles, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let profiles = Profiles::with_roots(Arc::new(source), dir.path().join("home"), dir.path().join("traycer"));
        (profiles, dir)
    }

    fn stored(id: &str, name: &str) -> StoredProfile {
        serde_json::from_value(json!({ "id": id, "provider": "claude", "name": name })).unwrap()
    }

    fn chat(id: &str, turns: Vec<Value>) -> Value {
        json!({
            "id": id, "title": "Conversa", "cwd": "C:\\a\\b\\Proj\\", "updatedAt": 50,
            "selection": { "provider": "claude", "profileId": "work" }, "turns": turns
        })
    }

    fn turn(id: &str, extra: Value) -> Value {
        let mut turn = json!({ "id": id, "role": "assistant", "startedAt": 100 });
        turn.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        turn
    }

    fn run(chat: &str, turn: &str, route: Option<&str>, session: Option<&str>) -> TurnRun {
        TurnRun { chat_id: chat.into(), turn_id: turn.into(), route: route.map(Into::into), session_id: session.map(Into::into) }
    }

    fn observe(chats: &[Value], runs: Vec<TurnRun>) -> Vec<Observation> {
        prism_observations(chats, &[], &HashMap::new(), &journal(runs))
    }

    fn counters(provider: &str, metrics: Value) -> Value {
        serde_json::to_value(prism_counters(provider, Some(&metrics))).unwrap()
    }

    // ------------------------------------------------------------ project_name

    #[test]
    fn project_name_is_the_last_non_empty_segment() {
        assert_eq!(project_name(Some("C:\\a\\b\\Proj\\")).as_deref(), Some("Proj"));
        assert_eq!(project_name(Some("/home/q/Proj")).as_deref(), Some("Proj"));
        assert_eq!(project_name(Some("/home/q/Proj//")).as_deref(), Some("Proj"));
        assert_eq!(project_name(Some("Proj")).as_deref(), Some("Proj"));
        assert_eq!(project_name(Some("")), None);
        assert_eq!(project_name(Some("/")), None);
        assert_eq!(project_name(None), None);
    }

    // ---------------------------------------------------------- prism_counters

    #[test]
    fn codex_counters_are_cumulative_with_cached_input_taken_out_and_no_cost() {
        let metrics = json!({ "inputTokens": 1000, "cachedTokens": 300, "outputTokens": 50, "reasoningTokens": 10, "costUsd": 9, "cacheWriteTokens": 4 });
        assert_eq!(
            counters("codex", metrics),
            json!({
                "tokenBasis": "cumulative", "costBasis": "none", "inputTokens": 700, "cacheReadTokens": 300,
                "cacheWriteTokens": null, "outputTokens": 50, "reasoningTokens": 10, "costUsd": null
            })
        );
        // Never negative, and a missing cached count is zero.
        assert_eq!(counters("codex", json!({ "inputTokens": 100, "cachedTokens": 300 }))["inputTokens"], json!(0));
        assert_eq!(counters("codex", json!({ "inputTokens": 100 }))["inputTokens"], json!(100));
        assert_eq!(counters("codex", json!({ "cachedTokens": 3 }))["inputTokens"], json!(null));
    }

    #[test]
    fn claude_counters_are_per_turn_with_a_cumulative_cost() {
        let metrics = json!({ "inputTokens": 10, "cachedTokens": 5, "cacheWriteTokens": 2, "outputTokens": 3, "reasoningTokens": 1, "costUsd": 0.5 });
        assert_eq!(
            counters("claude", metrics),
            json!({
                "tokenBasis": "turn", "costBasis": "cumulative", "inputTokens": 10, "cacheReadTokens": 5,
                "cacheWriteTokens": 2, "outputTokens": 3, "reasoningTokens": 1, "costUsd": 0.5
            })
        );
        let free = counters("claude", json!({ "inputTokens": 10 }));
        assert_eq!((free["tokenBasis"].clone(), free["costBasis"].clone(), free["costUsd"].clone()), (json!("turn"), json!("none"), json!(null)));
        // Any provider that is not codex reads like Claude.
        assert_eq!(counters("", json!({ "inputTokens": 10, "costUsd": 1 }))["costBasis"], json!("cumulative"));
    }

    #[test]
    fn turn_metrics_take_precedence_over_the_cumulative_ones() {
        let metrics = json!({
            "inputTokens": 999, "costUsd": 99,
            "turn": { "inputTokens": 7, "cacheReadTokens": 6, "cacheWriteTokens": 5, "outputTokens": 4, "reasoningTokens": 3, "costUsd": 0.25 }
        });
        for provider in ["codex", "claude"] {
            assert_eq!(
                counters(provider, metrics.clone()),
                json!({
                    "tokenBasis": "turn", "costBasis": "turn", "inputTokens": 7, "cacheReadTokens": 6,
                    "cacheWriteTokens": 5, "outputTokens": 4, "reasoningTokens": 3, "costUsd": 0.25
                }),
                "{provider}"
            );
        }
        // A cost the runtime could not measure stays absent, not zero.
        let unmeasured = counters("codex", json!({ "inputTokens": 999, "turn": { "inputTokens": 7 } }));
        assert_eq!((unmeasured["costBasis"].clone(), unmeasured["costUsd"].clone(), unmeasured["inputTokens"].clone()), (json!("none"), json!(null), json!(7)));
        // A `turn` that is not an object is ignored.
        assert_eq!(counters("claude", json!({ "inputTokens": 1, "turn": 5 }))["inputTokens"], json!(1));
    }

    #[test]
    fn missing_metrics_are_all_none() {
        let none = json!({
            "tokenBasis": "none", "costBasis": "none", "inputTokens": null, "cacheReadTokens": null,
            "cacheWriteTokens": null, "outputTokens": null, "reasoningTokens": null, "costUsd": null
        });
        assert_eq!(serde_json::to_value(prism_counters("claude", None)).unwrap(), none);
        assert_eq!(serde_json::to_value(prism_counters("codex", Some(&Value::Null))).unwrap(), none);
        assert_eq!(serde_json::to_value(prism_counters("codex", Some(&json!(0)))).unwrap(), none);
    }

    // ------------------------------------------------------ prism_observations

    #[test]
    fn route_and_session_come_from_the_journal() {
        let chats = [chat("c", vec![turn("t1", json!({ "completedAt": 160 }))])];
        let observations = observe(&chats, vec![run("c", "t1", Some("codex:acc:2"), Some("s-1"))]);
        assert_eq!(observations.len(), 1);
        let o = &observations[0];
        // The route's provider beats the chat's selection; the profile keeps its colon.
        assert_eq!((o.provider.as_str(), o.profile_id.as_deref(), o.session_key.as_deref()), ("codex", Some("acc:2"), Some("s-1")));
        assert_eq!((o.id.as_str(), o.source, o.prism_chat_id.as_str()), ("prism:c:t1", "prism", "c"));
    }

    #[test]
    fn without_a_route_the_selection_supplies_provider_and_profile() {
        let chats = [chat("c", vec![turn("t1", json!({})), turn("t2", json!({ "provider": "codex" }))])];
        let observations = observe(&chats, Vec::new());
        assert_eq!((observations[0].provider.as_str(), observations[0].profile_id.as_deref(), observations[0].session_key.clone()), ("claude", Some("work"), None));
        // The turn's own provider is another one than the selected: its profile is unknown.
        assert_eq!((observations[1].provider.as_str(), observations[1].profile_id.clone()), ("codex", None));
        // A route with a blank profile falls back to the selection's when the provider matches.
        let blank = observe(&chats, vec![run("c", "t1", Some("claude:"), None)]);
        assert_eq!(blank[0].profile_id.as_deref(), Some("work"));
    }

    #[test]
    fn the_last_run_recorded_for_a_turn_wins_in_the_journal_map() {
        let map = journal(vec![run("c", "t", Some("claude:a"), None), run("c", "t", Some("codex:b"), Some("s"))]);
        assert_eq!(map.len(), 1);
        assert_eq!(map[&("c".to_string(), "t".to_string())].route.as_deref(), Some("codex:b"));
    }

    #[test]
    fn user_turns_the_pending_turn_and_imported_transcripts_are_left_out() {
        let mut c = chat(
            "c",
            vec![
                json!({ "id": "u1", "role": "user", "startedAt": 90, "metrics": { "inputTokens": 1 } }),
                turn("pending", json!({})),
                json!({ "id": "imported", "role": "assistant", "text": "do Traycer" }),
                json!({ "id": "zero", "role": "assistant", "startedAt": 0 }),
                turn("kept", json!({})),
            ],
        );
        c["pendingTurnId"] = json!("pending");
        let ids: Vec<_> = observe(&[c], Vec::new()).into_iter().map(|o| o.turn_id).collect();
        assert_eq!(ids, ["kept"]);
    }

    #[test]
    fn a_turn_with_only_metrics_starts_at_completed_at_or_the_chats_update() {
        let chats = [chat(
            "c",
            vec![
                json!({ "id": "a", "role": "assistant", "completedAt": 170, "metrics": { "inputTokens": 1 } }),
                json!({ "id": "b", "role": "assistant", "metrics": { "inputTokens": 1 } }),
            ],
        )];
        let observations = observe(&chats, Vec::new());
        assert_eq!((observations[0].started_at, observations[0].completed_at, observations[0].duration_ms), (170.0, Some(170.0), None));
        assert_eq!((observations[1].started_at, observations[1].completed_at), (50.0, None));
    }

    #[test]
    fn outcome_follows_error_then_interrupted() {
        let chats = [chat(
            "c",
            vec![
                turn("ok", json!({ "error": false, "interrupted": false })),
                turn("err", json!({ "error": true })),
                turn("stop", json!({ "interrupted": true })),
                turn("both", json!({ "error": true, "interrupted": true })),
            ],
        )];
        let outcomes: Vec<_> = observe(&chats, Vec::new()).into_iter().map(|o| o.outcome).collect();
        assert_eq!(outcomes, [Outcome::Completed, Outcome::Error, Outcome::Interrupted, Outcome::Error]);
    }

    #[test]
    fn duration_is_recorded_or_computed_and_never_negative() {
        let chats = [chat(
            "c",
            vec![
                turn("given", json!({ "completedAt": 160, "durationMs": 7 })),
                turn("computed", json!({ "completedAt": 160 })),
                turn("backwards", json!({ "completedAt": 40 })),
                turn("running", json!({})),
                turn("null-duration", json!({ "completedAt": 130, "durationMs": null })),
            ],
        )];
        let durations: Vec<_> = observe(&chats, Vec::new()).into_iter().map(|o| o.duration_ms).collect();
        assert_eq!(durations, [Some(7.0), Some(60.0), Some(0.0), None, Some(30.0)]);
    }

    #[test]
    fn profile_name_comes_from_the_turn_then_the_accounts_then_the_terminal() {
        let chats = [chat("c", vec![turn("own", json!({ "profileName": "Gravado" })), turn("map", json!({})), turn("other", json!({ "provider": "codex" }))])];
        let names = HashMap::from([("work".to_string(), "Trabalho".to_string())]);
        let observations = prism_observations(&chats, &[], &names, &Journal::new());
        let named: Vec<_> = observations.iter().map(|o| o.profile_name.as_str()).collect();
        assert_eq!(named, ["Gravado", "Trabalho", TERMINAL_ACCOUNT]);
        let empty = HashMap::from([("work".to_string(), String::new())]);
        assert_eq!(prism_observations(&chats, &[], &empty, &Journal::new())[1].profile_name, TERMINAL_ACCOUNT);
    }

    #[test]
    fn model_task_and_project_are_filled_in() {
        let mut c = chat("c", vec![turn("a", json!({ "model": "alias", "metrics": { "model": "real-1" } })), turn("b", json!({ "model": "alias" })), turn("c", json!({}))]);
        c["taskId"] = json!("k1");
        let tasks = [json!({ "id": "k1", "title": "Tarefa" }), json!({ "id": "k2" })];
        let observations = prism_observations(&[c.clone()], &tasks, &HashMap::new(), &Journal::new());
        let models: Vec<_> = observations.iter().map(|o| o.model.as_str()).collect();
        assert_eq!(models, ["real-1", "alias", ""]);
        assert_eq!((observations[0].task_id.as_deref(), observations[0].task_title.as_deref(), observations[0].project.as_deref()), (Some("k1"), Some("Tarefa"), Some("Proj")));
        assert_eq!(observations[0].chat_title, "Conversa");

        c["taskId"] = json!("gone");
        c["cwd"] = json!("");
        let orphan = prism_observations(&[c.clone()], &tasks, &HashMap::new(), &Journal::new());
        assert_eq!((orphan[0].task_id.as_deref(), orphan[0].task_title.clone(), orphan[0].project.clone()), (Some("gone"), None, None));
        c.as_object_mut().unwrap().remove("cwd");
        c.as_object_mut().unwrap().remove("taskId");
        let bare = prism_observations(&[c], &tasks, &HashMap::new(), &Journal::new());
        assert_eq!((bare[0].task_id.clone(), bare[0].task_title.clone(), bare[0].project.clone()), (None, None, None));
    }

    #[test]
    fn an_observation_serializes_like_the_typescript_one() {
        let chats = [chat("c", vec![turn("t1", json!({ "completedAt": 160, "model": "m", "metrics": { "inputTokens": 5, "costUsd": 0.5 } }))])];
        let observations = observe(&chats, vec![run("c", "t1", Some("claude:work"), Some("s"))]);
        assert_eq!(
            serde_json::to_value(&observations[0]).unwrap(),
            json!({
                "id": "prism:c:t1", "source": "prism", "chatId": "c", "turnId": "t1", "chatTitle": "Conversa",
                "taskId": null, "taskTitle": null, "project": "Proj", "provider": "claude", "model": "m",
                "profileId": "work", "profileName": TERMINAL_ACCOUNT, "sessionKey": "s", "startedAt": 100,
                "completedAt": 160, "durationMs": 60, "outcome": "completed", "prismChatId": "c",
                "tokenBasis": "turn", "costBasis": "cumulative", "inputTokens": 5, "cacheReadTokens": null,
                "cacheWriteTokens": null, "outputTokens": null, "reasoningTokens": null, "costUsd": 0.5
            })
        );
    }

    // ------------------------------------------------------ traycer_observations

    #[test]
    fn traycer_turns_link_to_their_prism_chat() {
        let mut linked = chat("prism-1", Vec::new());
        linked["traycerSource"] = json!({ "epicId": "e1", "chatId": "c1" });
        let mut half = chat("prism-2", Vec::new());
        half["traycerSource"] = json!({ "epicId": "e2" });
        let bodies = [
            json!({ "id": "x1", "chatId": "e1/c1", "source": "traycer", "inputTokens": 3 }).to_string(),
            json!({ "id": "x2", "chatId": "e9/c9", "prismChatId": "stale" }).to_string(),
            json!({ "id": "x3", "chatId": "e2/c2" }).to_string(),
        ];
        let observations = traycer_observations(&[linked, half, chat("plain", Vec::new())], &bodies);
        let links: Vec<_> = observations.iter().map(|o| (o["id"].clone(), o["prismChatId"].clone())).collect();
        assert_eq!(links, [(json!("x1"), json!("prism-1")), (json!("x2"), json!(null)), (json!("x3"), json!(null))]);
        assert_eq!(observations[0]["inputTokens"], json!(3), "the rest of the body is kept");
    }

    #[test]
    fn traycer_bodies_that_are_not_observations_are_skipped() {
        let bodies = [
            "não é json".to_string(),
            "[1,2]".to_string(),
            json!({ "chatId": "e/c" }).to_string(),
            json!({ "id": "x" }).to_string(),
            json!({ "id": 5, "chatId": "e/c" }).to_string(),
            json!({ "id": "x", "chatId": 5 }).to_string(),
            json!({ "id": "ok", "chatId": "e/c" }).to_string(),
        ];
        let observations = traycer_observations(&[], &bodies);
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0]["id"], json!("ok"));
    }

    // ------------------------------------------------------------ import_state

    #[test]
    fn import_state_is_never_without_a_stored_import() {
        let never = json!({
            "status": "never", "at": null, "root": null, "tasks": 0, "chats": 0, "turns": 0,
            "added": 0, "updated": 0, "unchanged": 0, "warnings": [], "error": null
        });
        assert_eq!(import_state(None), never);
        assert_eq!(import_state(Some("{ não é json")), never);
        assert_eq!(import_state(Some("[1]")), never);
        assert_eq!(import_state(Some("null")), never);
    }

    #[test]
    fn a_stored_import_overrides_the_defaults_it_has() {
        let state = import_state(Some(r#"{"status":"ok","at":99,"turns":12,"added":4,"warnings":["x"]}"#));
        assert_eq!(
            state,
            json!({
                "status": "ok", "at": 99, "root": null, "tasks": 0, "chats": 0, "turns": 12,
                "added": 4, "updated": 0, "unchanged": 0, "warnings": ["x"], "error": null
            })
        );
    }

    // ------------------------------------------------------------------ records

    fn usage_db(dir: &Path) -> PathBuf {
        let path = dir.join("prism-usage.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE traycer_turns(id TEXT PRIMARY KEY, epic_id TEXT, chat_id TEXT, body TEXT NOT NULL, imported_at INTEGER, updated_at INTEGER);
             CREATE TABLE state(key TEXT PRIMARY KEY, body TEXT NOT NULL);",
        )
        .unwrap();
        let body = json!({ "id": "x1", "chatId": "e1/c1", "source": "traycer" }).to_string();
        conn.execute("INSERT INTO traycer_turns(id, epic_id, chat_id, body, imported_at, updated_at) VALUES ('x1', 'e1', 'c1', ?1, 1, 1)", [body]).unwrap();
        conn.execute("INSERT INTO state(key, body) VALUES ('traycer-import', '{\"status\":\"ok\",\"turns\":1}')", []).unwrap();
        path
    }

    fn seeded_store() -> Arc<Store> {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut c = chat("c", vec![turn("t1", json!({ "completedAt": 160, "metrics": { "inputTokens": 5 } }))]);
        c["traycerSource"] = json!({ "epicId": "e1", "chatId": "c1" });
        c["taskId"] = json!("k1");
        store.put_chat(&c).unwrap();
        store.replace_documents(kinds::TASKS, &[json!({ "id": "k1", "cwd": "C:/repo", "title": "Tarefa" })]).unwrap();
        let begin = json!({ "kind": "begin", "turn": turn("t1", json!({ "completedAt": 160, "metrics": { "inputTokens": 5 } })), "route": "claude:work" });
        store.append_batch(vec![NewEvent::raw("c", "t1", begin), NewEvent::raw("c", "t1", json!({ "kind": "session", "sessionId": "sess" }))]).unwrap();
        store
    }

    fn accounts() -> (Profiles, tempfile::TempDir) {
        profiles(Fake(Some(vec![stored("work", "Trabalho")])))
    }

    #[test]
    fn records_lists_prism_first_then_traycer() {
        let store = seeded_store();
        let (profiles, _home) = accounts();
        let dir = tempfile::tempdir().unwrap();
        let db = usage_db(dir.path());
        let records = records(&store, &profiles, Some(&db), None).unwrap();
        assert_eq!(records.observations.len(), 2);
        let (prism, traycer) = (&records.observations[0], &records.observations[1]);
        assert_eq!((prism["source"].clone(), prism["id"].clone(), prism["sessionKey"].clone()), (json!("prism"), json!("prism:c:t1"), json!("sess")));
        assert_eq!((prism["profileName"].clone(), prism["taskTitle"].clone(), prism["project"].clone()), (json!("Trabalho"), json!("Tarefa"), json!("Proj")));
        assert_eq!((traycer["id"].clone(), traycer["prismChatId"].clone()), (json!("x1"), json!("c")));
        assert_eq!((records.import_state["status"].clone(), records.import_state["turns"].clone()), (json!("ok"), json!(1)));
        assert!(records.generated_at > 0);
    }

    #[test]
    fn records_without_a_usage_db_is_only_prism() {
        let store = seeded_store();
        let (profiles, _home) = accounts();
        let dir = tempfile::tempdir().unwrap();
        for db in [None, Some(dir.path().join("missing.db"))] {
            let records = records(&store, &profiles, db.as_deref(), None).unwrap();
            assert_eq!(records.observations.len(), 1);
            assert_eq!(records.observations[0]["source"], json!("prism"));
            assert_eq!(records.import_state["status"], json!("never"));
        }
    }

    #[test]
    fn records_survives_an_unreadable_usage_db() {
        let store = seeded_store();
        let (profiles, _home) = accounts();
        let dir = tempfile::tempdir().unwrap();
        let junk = dir.path().join("prism-usage.db");
        std::fs::write(&junk, b"lixo que nao e sqlite ".repeat(100)).unwrap();
        let records = records(&store, &profiles, Some(&junk), None).unwrap();
        assert_eq!(records.observations.len(), 1);
        assert_eq!(records.import_state["status"], json!("error"), "an unreadable store is not \"not imported yet\"");
        assert!(records.import_state["at"].as_i64().is_some_and(|at| at > 0));
    }

    #[test]
    fn records_survives_unreadable_accounts_and_falls_back_to_the_terminal_account() {
        let store = seeded_store();
        let (profiles, _home) = profiles(Fake(None));
        let records = records(&store, &profiles, None, None).unwrap();
        assert_eq!(records.observations[0]["profileName"], json!(TERMINAL_ACCOUNT));
    }

    #[test]
    fn records_of_an_empty_store_is_empty() {
        let store = Store::open_in_memory().unwrap();
        let (profiles, _home) = accounts();
        let records = records(&store, &profiles, None, None).unwrap();
        assert!(records.observations.is_empty());
        assert_eq!(records.import_state["status"], json!("never"));
    }

    // -------------------------------------------------------------- UsageDomain

    fn domain(usage_db: Option<PathBuf>) -> (UsageDomain, tempfile::TempDir) {
        let (profiles, home) = accounts();
        (UsageDomain::new(SharedStore::with_store(seeded_store()), profiles, usage_db), home)
    }

    #[test]
    fn the_domain_is_named_usage_and_knows_only_records() {
        let (d, _home) = domain(None);
        assert_eq!(d.name(), "usage");
        assert!(d.call("nope", json!({}), ctx()).is_none());
        assert!(d.call("import", json!({}), ctx()).is_none());
    }

    #[tokio::test]
    async fn the_records_call_answers_the_response_shape() {
        let dir = tempfile::tempdir().unwrap();
        let (d, _home) = domain(Some(usage_db(dir.path())));
        let value = d.call("records", json!({}), ctx()).expect("a usage method").await.unwrap();
        let sources: Vec<_> = value["observations"].as_array().unwrap().iter().map(|o| o["source"].clone()).collect();
        assert_eq!(sources, [json!("prism"), json!("traycer")]);
        assert_eq!(value["importState"]["status"], json!("ok"));
        assert!(value["generatedAt"].as_i64().unwrap() > 0);
    }

    #[tokio::test]
    async fn the_records_call_without_or_with_a_broken_usage_db_still_answers() {
        let dir = tempfile::tempdir().unwrap();
        let junk = dir.path().join("prism-usage.db");
        std::fs::write(&junk, b"lixo que nao e sqlite ".repeat(100)).unwrap();
        for (db, status) in [(None, "never"), (Some(dir.path().join("missing.db")), "never"), (Some(junk), "error")] {
            let (d, _home) = domain(db);
            let value = d.call("records", json!({}), ctx()).expect("a usage method").await.unwrap();
            assert_eq!(value["observations"].as_array().unwrap().len(), 1);
            assert_eq!(value["importState"]["status"], json!(status));
        }
    }

    // ---------------------------------------------- the desktop's own journal

    /// A `prism-agents.db` with a journal: `(chat, turn, body)` rows.
    fn desktop_journal(dir: &Path, events: &[(&str, &str, Value)]) -> PathBuf {
        let path = dir.join("prism-agents.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL, body TEXT NOT NULL);").unwrap();
        for (chat, turn, body) in events {
            conn.execute("INSERT INTO events(chat_id, turn_id, body) VALUES (?1, ?2, ?3)", rusqlite::params![chat, turn, body.to_string()]).unwrap();
        }
        path
    }

    /// Chat `c` with one finished turn `t1`, begun in the host's journal with
    /// `route` (if any), then the given events.
    fn store_with_events(route: Option<&str>, events: Vec<Value>) -> Arc<Store> {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let finished = turn("t1", json!({ "completedAt": 160, "metrics": { "inputTokens": 5 } }));
        store.put_chat(&chat("c", vec![finished.clone()])).unwrap();
        let mut begin = json!({ "kind": "begin", "turn": finished });
        if let Some(route) = route {
            begin["route"] = json!(route);
        }
        let all = std::iter::once(begin).chain(events);
        store.append_batch(all.map(|body| NewEvent::raw("c", "t1", body)).collect()).unwrap();
        store
    }

    #[test]
    fn a_turn_with_its_session_only_on_the_desktop_and_its_begin_only_on_the_host_gets_both() {
        let dir = tempfile::tempdir().unwrap();
        let desktop = desktop_journal(dir.path(), &[("c", "t1", json!({ "kind": "session", "sessionId": "desk-sess" }))]);
        let store = store_with_events(Some("codex:work"), vec![]);
        let (profiles, _home) = accounts();

        let with = records(&store, &profiles, None, Some(&desktop)).unwrap();
        let o = &with.observations[0];
        assert_eq!((o["provider"].clone(), o["profileId"].clone(), o["sessionKey"].clone()), (json!("codex"), json!("work"), json!("desk-sess")));

        // Without the desktop's journal the session is simply unknown.
        let without = records(&store, &profiles, None, None).unwrap();
        assert_eq!(without.observations[0]["sessionKey"], Value::Null);
        assert_eq!(without.observations[0]["provider"], json!("codex"));
    }

    #[test]
    fn the_host_journal_wins_field_by_field_over_the_desktops() {
        let dir = tempfile::tempdir().unwrap();
        let desktop = desktop_journal(
            dir.path(),
            &[("c", "t1", json!({ "kind": "begin", "route": "codex:desk" })), ("c", "t1", json!({ "kind": "session", "sessionId": "desk-sess" }))],
        );
        let (profiles, _home) = accounts();

        // The host knows only the session: it wins that field, the desktop keeps the route.
        let store = store_with_events(None, vec![json!({ "kind": "session", "sessionId": "host-sess" })]);
        let o = &records(&store, &profiles, None, Some(&desktop)).unwrap().observations[0].clone();
        assert_eq!((o["provider"].clone(), o["profileId"].clone(), o["sessionKey"].clone()), (json!("codex"), json!("desk"), json!("host-sess")));

        // The host knows both: the desktop adds nothing.
        let store = store_with_events(Some("claude:work"), vec![json!({ "kind": "session", "sessionId": "sess" })]);
        let o = &records(&store, &profiles, None, Some(&desktop)).unwrap().observations[0].clone();
        assert_eq!((o["provider"].clone(), o["profileId"].clone(), o["sessionKey"].clone()), (json!("claude"), json!("work"), json!("sess")));

        // The host knows nothing of the turn: the desktop's values stand.
        let store = store_with_events(None, vec![]);
        let o = &records(&store, &profiles, None, Some(&desktop)).unwrap().observations[0].clone();
        assert_eq!((o["provider"].clone(), o["profileId"].clone(), o["sessionKey"].clone()), (json!("codex"), json!("desk"), json!("desk-sess")));
    }

    #[test]
    fn a_missing_or_unreadable_desktop_journal_is_left_out() {
        let dir = tempfile::tempdir().unwrap();
        let junk = dir.path().join("prism-agents.db");
        std::fs::write(&junk, b"lixo que nao e sqlite ".repeat(100)).unwrap();
        let (profiles, _home) = accounts();
        for path in [dir.path().join("missing.db"), junk] {
            let records = records(&seeded_store(), &profiles, None, Some(&path)).unwrap();
            assert_eq!(records.observations.len(), 1);
            assert_eq!(records.observations[0]["sessionKey"], json!("sess"), "the host's own journal still reads");
        }
    }

    #[tokio::test]
    async fn the_domain_reads_the_desktop_journal_it_was_given() {
        let dir = tempfile::tempdir().unwrap();
        let desktop = desktop_journal(dir.path(), &[("c", "t1", json!({ "kind": "session", "sessionId": "desk-sess" }))]);
        let (profiles, _home) = accounts();
        let store = SharedStore::with_store(store_with_events(Some("claude:work"), vec![]));
        let call = |domain: UsageDomain| async move { domain.call("records", json!({}), ctx()).unwrap().await.unwrap() };

        let plain = call(UsageDomain::new(Arc::clone(&store), profiles.clone(), None)).await;
        assert_eq!(plain["observations"][0]["sessionKey"], Value::Null, "no desktop journal by default");
        let with = call(UsageDomain::new(store, profiles, None).with_desktop_journal(Some(desktop))).await;
        assert_eq!(with["observations"][0]["sessionKey"], json!("desk-sess"));
    }

    #[test]
    fn an_unreadable_usage_db_says_what_failed_and_when() {
        let dir = tempfile::tempdir().unwrap();
        let junk = dir.path().join("prism-usage.db");
        std::fs::write(&junk, b"lixo que nao e sqlite ".repeat(100)).unwrap();
        let (profiles, _home) = accounts();
        let before = now_ms();
        let state = records(&seeded_store(), &profiles, Some(&junk), None).unwrap().import_state;
        assert_eq!(state["status"], json!("error"));
        assert!(state["at"].as_i64().is_some_and(|at| at >= before), "{state}");
        assert_eq!(state["error"], json!(UNREADABLE_USAGE));
        assert!(state["error"].as_str().is_some_and(|m| !m.is_empty()));
    }
}

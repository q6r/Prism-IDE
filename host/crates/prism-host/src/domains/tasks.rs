//! `tasks.*`: the task tabs of lib/agentTasks.ts on the host (T07). The
//! `tasks` documents and the `task-tabs` state, exactly as the Electron
//! app's `tasks:*` kept them in `prism-agents.db`.

use std::collections::HashSet;
use std::sync::Arc;

use prism_protocol::chats::{task_methods, TasksMergeParams, TasksState};
use prism_protocol::{ErrorCode, HostError, OkResult};
use prism_store::{kinds, Store};
use serde_json::{json, Value};

use crate::domain::{params, CallContext, Domain, HandlerFuture};
use crate::domains::store::{store_error, SharedStore};

/// `state` key of the open tabs and the active one.
const TABS_KEY: &str = "task-tabs";

pub struct TasksDomain {
    store: Arc<SharedStore>,
}

impl TasksDomain {
    pub fn new(store: Arc<SharedStore>) -> Self {
        Self { store }
    }
}

fn check(tasks: &[Value]) -> Result<(), HostError> {
    let field = |task: &Value, name: &str| task.get(name).is_some_and(Value::is_string);
    if tasks.iter().all(|task| field(task, "id") && field(task, "cwd") && field(task, "title")) {
        Ok(())
    } else {
        Err(HostError::new(ErrorCode::Invalid, "Projeto inválido."))
    }
}

fn load(store: &Store) -> Result<Value, HostError> {
    let tasks = store.documents(kinds::TASKS).map_err(store_error)?;
    let tabs = store.read_state(TABS_KEY).map_err(store_error)?.unwrap_or(Value::Null);
    let open_ids = tabs
        .get("openIds")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let active_id = tabs.get("activeId").and_then(Value::as_str).map(str::to_string);
    serde_json::to_value(TasksState { tasks, open_ids, active_id }).map_err(|err| HostError::new(ErrorCode::Internal, err.to_string()))
}

fn save(store: &Store, state: TasksState) -> Result<Value, HostError> {
    check(&state.tasks)?;
    store.replace_documents(kinds::TASKS, &state.tasks).map_err(store_error)?;
    let ids: HashSet<&str> = state.tasks.iter().filter_map(|task| task.get("id").and_then(Value::as_str)).collect();
    let open: Vec<&String> = state.open_ids.iter().filter(|id| ids.contains(id.as_str())).collect();
    store.write_state(TABS_KEY, &json!({ "openIds": open, "activeId": state.active_id })).map_err(store_error)?;
    Ok(json!(OkResult { ok: true }))
}

fn merge(store: &Store, p: TasksMergeParams) -> Result<Value, HostError> {
    check(&p.tasks)?;
    for task in &p.tasks {
        let id = task.get("id").and_then(Value::as_str).unwrap_or_default();
        store.put_document(kinds::TASKS, id, task).map_err(store_error)?;
    }
    Ok(json!(OkResult { ok: true }))
}

type Work = Box<dyn FnOnce(&Store) -> Result<Value, HostError> + Send>;

impl Domain for TasksDomain {
    fn name(&self) -> &'static str {
        "tasks"
    }

    fn call(&self, method: &str, value: Value, _ctx: CallContext) -> Option<HandlerFuture> {
        let work: Result<Work, HostError> = match method {
            task_methods::LOAD => Ok(Box::new(load)),
            task_methods::SAVE => params::<TasksState>(value).map(|state| Box::new(move |store: &Store| save(store, state)) as Work),
            task_methods::MERGE => params::<TasksMergeParams>(value).map(|p| Box::new(move |store: &Store| merge(store, p)) as Work),
            _ => return None,
        };
        let shared = Arc::clone(&self.store);
        Some(Box::pin(async move {
            let work = work?;
            tokio::task::spawn_blocking(move || {
                let store = shared.get()?;
                work(&store)
            })
                .await
                .map_err(|err| HostError::new(ErrorCode::Internal, format!("Falha ao ler as tarefas: {err}")))?
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{next_client_id, Notifier};
    use crate::HostState;
    use prism_protocol::{Role, UserInfo};
    use tokio::sync::mpsc;

    fn ctx() -> CallContext {
        let (tx, _rx) = mpsc::unbounded_channel();
        CallContext {
            user: UserInfo { id: "owner".into(), name: "qa".into(), role: Role::Owner },
            notifier: Notifier::new(next_client_id(), tx),
            state: HostState::with_domains("t".into(), "h".into(), "Máquina".into(), "qa".into(), Vec::new()),
        }
    }

    fn domain() -> TasksDomain {
        TasksDomain::new(SharedStore::with_store(Arc::new(Store::open_in_memory().unwrap())))
    }

    async fn call(domain: &TasksDomain, method: &str, params: Value) -> Result<Value, HostError> {
        domain.call(method, params, ctx()).expect("a tasks method").await
    }

    fn task(id: &str, title: &str) -> Value {
        json!({ "id": id, "cwd": "C:/repo", "title": title })
    }

    fn titles(state: &Value) -> Vec<String> {
        let mut titles: Vec<String> = state["tasks"].as_array().unwrap().iter().map(|t| format!("{}={}", t["id"].as_str().unwrap(), t["title"].as_str().unwrap())).collect();
        titles.sort();
        titles
    }

    #[tokio::test]
    async fn load_starts_empty_and_save_replaces_everything() {
        let d = domain();
        assert_eq!(call(&d, "load", json!({})).await.unwrap(), json!({ "tasks": [], "openIds": [], "activeId": null }));

        let saved = call(&d, "save", json!({ "tasks": [task("t1", "Um"), task("t2", "Dois")], "openIds": ["t2", "t1"], "activeId": "t1" })).await.unwrap();
        assert_eq!(saved, json!({ "ok": true }));
        let state = call(&d, "load", json!({})).await.unwrap();
        assert_eq!(titles(&state), ["t1=Um", "t2=Dois"]);
        assert_eq!((state["openIds"].clone(), state["activeId"].clone()), (json!(["t2", "t1"]), json!("t1")), "the tabs keep their order");

        // A later save is the whole truth: a task left out is deleted.
        call(&d, "save", json!({ "tasks": [task("t1", "Um!")], "openIds": ["t1"], "activeId": null })).await.unwrap();
        let state = call(&d, "load", json!({})).await.unwrap();
        assert_eq!(titles(&state), ["t1=Um!"]);
        assert_eq!(state["activeId"], Value::Null);
    }

    #[tokio::test]
    async fn open_ids_keep_only_the_tasks_that_exist() {
        let d = domain();
        call(&d, "save", json!({ "tasks": [task("t1", "Um"), task("t2", "Dois")], "openIds": ["fantasma", "t1", "outro", "t2"], "activeId": "t2" })).await.unwrap();
        assert_eq!(call(&d, "load", json!({})).await.unwrap()["openIds"], json!(["t1", "t2"]));
    }

    #[tokio::test]
    async fn an_invalid_task_is_refused_and_nothing_changes() {
        let d = domain();
        call(&d, "save", json!({ "tasks": [task("t1", "Um")], "openIds": ["t1"], "activeId": "t1" })).await.unwrap();
        for bad in [json!({ "id": "x", "title": "sem pasta" }), json!({ "id": 5, "cwd": "c", "title": "t" }), json!({ "cwd": "c", "title": "t" }), json!({ "id": "x", "cwd": "c" })] {
            let err = call(&d, "save", json!({ "tasks": [task("t2", "ok"), bad.clone()], "openIds": [], "activeId": null })).await.unwrap_err();
            assert_eq!((err.code, err.message.as_str()), (ErrorCode::Invalid, "Projeto inválido."), "{bad}");
            let err = call(&d, "merge", json!({ "tasks": [task("t3", "ok"), bad] })).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::Invalid);
        }
        let state = call(&d, "load", json!({})).await.unwrap();
        assert_eq!(titles(&state), ["t1=Um"], "a refused call writes nothing");
        assert_eq!(state["openIds"], json!(["t1"]));
        assert_eq!(call(&d, "save", json!({ "tasks": "não" })).await.unwrap_err().code, ErrorCode::Invalid);
    }

    #[tokio::test]
    async fn merge_inserts_or_replaces_only_the_given_tasks() {
        let d = domain();
        call(&d, "save", json!({ "tasks": [task("t1", "Um"), task("t2", "Dois")], "openIds": ["t1"], "activeId": "t1" })).await.unwrap();
        call(&d, "merge", json!({ "tasks": [task("t2", "Dois!"), task("t3", "Três")] })).await.unwrap();
        let state = call(&d, "load", json!({})).await.unwrap();
        assert_eq!(titles(&state), ["t1=Um", "t2=Dois!", "t3=Três"]);
        assert_eq!((state["openIds"].clone(), state["activeId"].clone()), (json!(["t1"]), json!("t1")), "the tabs are not touched");
        assert!(d.call("nope", Value::Null, ctx()).is_none());
    }
}

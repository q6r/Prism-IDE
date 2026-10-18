//! Optional live check against the real Claude Code CLI, for validating a new
//! CLI version end to end (process tree, pipes, environment). Off by default:
//!
//!   PRISM_CLAUDE_LIVE=1 cargo test -p prism-agents --test claude_live -- --ignored
//!
//! Uses the terminal account and Haiku with a one-word prompt (one paid turn).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use prism_agents::claude::{Catalog, ClaudeAgents, Emitter, ProcessLauncher, SendPayload};
use prism_agents::profile_env::{ElectronProfiles, Profiles};
use serde_json::{Value, json};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "runs the real Claude Code CLI (PRISM_CLAUDE_LIVE=1)"]
async fn a_real_turn_runs_end_to_end() {
    if std::env::var("PRISM_CLAUDE_LIVE").as_deref() != Ok("1") {
        eprintln!("PRISM_CLAUDE_LIVE=1 não definido: teste ao vivo pulado");
        return;
    }
    let profiles = Profiles::new(Arc::new(ElectronProfiles::from_env()));
    let agents = ClaudeAgents::new(Arc::new(profiles), Arc::new(ProcessLauncher));
    let cwd = tempfile::tempdir().unwrap();
    let events = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
    let sink = Arc::clone(&events);
    let emit: Emitter = Arc::new(move |c: &str, d: Value| sink.lock().unwrap().push((c.to_string(), d)));
    let payload: SendPayload = serde_json::from_value(json!({"id": "live-1", "chat": {"id": "live"}, "permissionScope": "live", "profileId": "ambient-claude",
        "prompt": "Responda apenas com a palavra: pronto", "cwd": cwd.path(), "model": "haiku", "permissionMode": "default"})).unwrap();
    assert!(agents.send(1, emit, payload).await);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    while !events.lock().unwrap().iter().any(|(c, _)| c == "agent:done" || c == "agent:error") {
        assert!(tokio::time::Instant::now() < deadline, "sem resposta da CLI: {:?}", events.lock().unwrap());
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let seen = events.lock().unwrap().clone();
    let channels: Vec<&str> = seen.iter().map(|(c, _)| c.as_str()).collect();
    assert!(channels.contains(&"agent:system") && channels.contains(&"agent:text") && channels.contains(&"agent:result"), "{channels:?}");
    let result = &seen.iter().find(|(c, _)| c == "agent:result").unwrap().1;
    assert_eq!(result["isError"], false, "{result}");
    assert!(result["turn"]["outputTokens"].as_u64().unwrap_or(0) > 0, "{result}");
    assert_eq!(seen.last().unwrap(), &("agent:done".to_string(), json!({"id": "live-1", "aborted": false})));

    // The catalog through the same transport (no paid generation).
    let models = agents.catalog(Catalog::Models, None, None).await.unwrap();
    assert!(models.as_array().is_some_and(|m| m.iter().any(|row| row["value"].is_string())), "{models}");

    agents.end("unified:live");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while agents.live() > 0 {
        assert!(tokio::time::Instant::now() < deadline, "o processo não encerrou");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

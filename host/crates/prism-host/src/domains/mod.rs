//! The registered domains. Each ticket adds its module here and one entry in
//! `all` (T03 fs/search/git/workspace/sessions/commands, T04 terminal, T05
//! codex, T06 claude, T07 chats and tasks, T08 providers and usage, T09
//! remote…).

pub mod chats;
pub mod claude;
pub mod codex;
pub mod commands;
pub mod fs;
pub mod git;
pub mod node_path;
pub mod providers;
pub mod remote;
pub mod search;
pub mod sessions;
pub mod store;
pub mod tasks;
pub mod terminal;
pub mod usage;
pub mod workspace;

use std::sync::Arc;

use prism_agents::profile_env::{ProfileSource, Profiles};

use crate::domain::Domain;

pub fn all() -> Vec<Arc<dyn Domain>> {
    // One database for the stats, the chats, the tasks and the profiles,
    // opened (and, on a desktop host's first start, filled from Prism 0.2)
    // right away.
    let store = store::SharedStore::from_data_dir();
    store.warm_up();
    // One set of profiles for every agent (T08): stored by the host, each
    // login in the app's own data folder.
    let host_profiles = Arc::new(providers::HostProfiles::new(Arc::clone(&store), providers::HostProfiles::default_root()));
    let profiles = Profiles::new(Arc::clone(&host_profiles) as Arc<dyn ProfileSource>);
    let codex = codex::CodexDomain::with_profiles(profiles.clone());
    let claude = claude::ClaudeDomain::enabled().then(|| claude::ClaudeDomain::with_profiles(profiles.clone()));
    let claude_agents = claude.as_ref().map(|domain| domain.agents().clone());
    // The chats engine runs its turns on the same Claude and Codex sessions.
    let runners = chats::Runners {
        claude: claude_agents.clone().map(|agents| Arc::new(chats::ClaudeRunner::new(agents)) as Arc<dyn chats::Runner>),
        codex: Some(Arc::new(chats::CodexRunner::new(codex.sessions()))),
    };
    let chats = Arc::new(chats::ChatsDomain::new(Arc::clone(&store), runners));
    let catalogs = providers::Catalogs::new(profiles.clone(), claude_agents.clone(), codex.queries());
    // A phone drives a shared chat through the same engine (T09).
    let remote = remote::RemoteDomain::new(remote::RemoteParts {
        chats: Arc::clone(&chats),
        catalogs: Arc::clone(&catalogs),
        host_profiles: Arc::clone(&host_profiles),
        tunnels: remote::tunnel::from_env(),
    });
    let accounts = providers::ProvidersDomain::new(providers::ProvidersParts {
        host_profiles,
        profiles: profiles.clone(),
        catalogs,
        chats: Arc::clone(&chats),
        claude: claude_agents,
        codex: codex.sessions(),
        codex_queries: codex.queries(),
    });
    let usage_db = crate::paths::app_data_root().map(|dir| dir.join("prism-usage.db"));
    // The turns a window still drives itself (SSH) are journaled by the desktop.
    let desktop_journal = crate::paths::electron_user_data().map(|dir| dir.join("prism-agents.db"));
    let mut all: Vec<Arc<dyn Domain>> = vec![
        Arc::new(fs::FsDomain::new()),
        Arc::new(search::SearchDomain::new()),
        Arc::new(git::GitDomain::new()),
        Arc::new(workspace::WorkspaceDomain),
        Arc::new(sessions::SessionsDomain::new()),
        Arc::new(commands::CommandsDomain::new()),
        Arc::new(terminal::TerminalDomain::new()),
        Arc::new(codex),
        Arc::new(store::StoreDomain::new(Arc::clone(&store))),
        chats,
        Arc::new(tasks::TasksDomain::new(Arc::clone(&store))),
        Arc::new(accounts),
        Arc::new(usage::UsageDomain::new(store, profiles, usage_db).with_desktop_journal(desktop_journal)),
        Arc::new(remote),
    ];
    if let Some(claude) = claude {
        all.push(Arc::new(claude));
    }
    all
}

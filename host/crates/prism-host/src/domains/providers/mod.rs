//! `providers.*` (T08): the accounts the agents run on. Plan:
//! `prism-rust-host/tickets/t08-contas-uso-limites/desenho` in the Traycer
//! epic; contract in `prism_protocol::providers`.

pub mod catalog;
pub mod domain;
pub mod login;
pub mod profiles;

pub use catalog::Catalogs;
pub use domain::{ProvidersDomain, ProvidersParts};
pub use profiles::HostProfiles;

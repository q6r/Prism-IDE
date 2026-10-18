//! `search.*`: text search over a folder, streamed as notifications, and
//! "Go to Definition" across files (`window.prism.nav.findDef`).
//!
//! `search.run` answers right away; matches arrive as `search.result`
//! notifications (one per file) and end with `search.done`, all carrying the
//! caller's `id`. A newer `search.run` from the same client, `search.cancel`
//! or a disconnect stops a search.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const SEARCH_RESULT: &str = "search.result";
pub const SEARCH_DONE: &str = "search.done";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchRunParams {
    #[ts(type = "number")]
    pub id: u64,
    pub root: String,
    pub query: String,
    #[serde(default)]
    pub case_sensitive: bool,
}

/// Without `id`, cancels every search of this client.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchCancelParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub id: Option<u64>,
}

/// 1-based line; 1-based column in UTF-16 units (what the editor uses).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchMatch {
    pub line: u32,
    pub col: u32,
    pub preview: String,
}

/// `search.result`: the matches of one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchFileResult {
    #[ts(type = "number")]
    pub id: u64,
    pub path: String,
    pub rel: String,
    pub name: String,
    pub matches: Vec<SearchMatch>,
}

/// `search.done`: totals of a search that ran to the end (a cancelled search
/// sends nothing more).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchDone {
    #[ts(type = "number")]
    pub id: u64,
    pub files: u32,
    pub matches: u32,
    pub truncated: bool,
}

/// `search.findDef`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FindDefParams {
    pub root: String,
    pub word: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DefinitionMatch {
    pub path: String,
    pub rel: String,
    pub name: String,
    pub line: u32,
    pub col: u32,
    pub preview: String,
}

/// Matches in scan order; the client puts the ones in `fromPath` first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FindDefResult {
    pub matches: Vec<DefinitionMatch>,
}

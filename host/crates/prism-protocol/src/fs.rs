//! `fs.*` and `workspace.*`: files and folders on the host's disk. Large
//! bytes (media previews, imports, pasted images) travel over `/files`
//! instead of JSON; see `FilesQuery`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One entry of `fs.readDir`. `isDir` is false for symlinks, as before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// One file of `fs.listFiles`: `rel` is relative to the root, with `/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FsListedFile {
    pub path: String,
    pub rel: String,
}

/// `fs.readDir`, `fs.listFiles`, `fs.readFile`, `fs.createFile`,
/// `fs.createDir`, `fs.duplicate`, `fs.delete`, `fs.trash`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FsPathParams {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FsWriteParams {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FsRenameParams {
    pub from: String,
    pub to: String,
}

/// `fs.move` and `fs.copyPath`: `src` lands inside `destDir`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FsTransferParams {
    pub src: String,
    pub dest_dir: String,
}

/// `fs.uniquePath`: a free path for `name` inside `dir` (`a copy.txt`,
/// `a copy 2.txt`…), used by imports before uploading.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FsUniqueParams {
    pub dir: String,
    pub name: String,
}

/// Query of `GET /files` (download `path`) and `PUT /files` (write the body
/// to `path`, or to a new temporary file with extension `temp`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FilesQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub temp: Option<String>,
}

/// What `PUT /files` answers: where the bytes were written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FilesWritten {
    pub path: String,
}

/// `workspace.read`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceReadParams {
    pub file: String,
}

/// `workspace.write`: saves a `.prism-workspace` listing `folders`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceWriteParams {
    pub file: String,
    pub folders: Vec<String>,
}

/// A workspace file and the folders of it that exist on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceInfo {
    pub file: String,
    pub folders: Vec<String>,
}

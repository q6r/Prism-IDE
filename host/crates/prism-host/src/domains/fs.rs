//! `fs.*`: the Explorer, the editor and QuickOpen on the host's disk, plus
//! the `/files` transfer for bytes too big for JSON (media previews, files
//! imported from the user's machine, pasted images). Same behavior and path
//! strings as the Electron main process had (`src/main/ipc/fs.ts`).

use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use axum::body::Body;
use axum::extract::Query;
use axum::http::{header, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::StreamExt;
use prism_protocol::fs::{
    FilesQuery, FilesWritten, FsEntry, FsListedFile, FsPathParams, FsRenameParams, FsTransferParams, FsUniqueParams,
    FsWriteParams,
};
use prism_protocol::{ErrorCode, HostError};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use super::node_path::{self, SEP};
use crate::domain::{params, CallContext, Domain, HandlerFuture};

/// Never walked by `fs.listFiles` (QuickOpen) or the searches.
pub const IGNORED_DIRS: &[&str] = &[
    "node_modules", ".git", "dist", "dist-app", "out", ".next", "build", ".cache", ".turbo", "coverage", ".svn", ".hg",
    ".idea", ".gradle", "target", "vendor", "__pycache__",
];

/// Most files `fs.listFiles` returns (and the searches look at).
pub const LIST_CAP: usize = 8000;

/// Sends a path to the OS trash (the Recycle Bin on Windows).
pub type TrashFn = fn(&Path) -> Result<(), String>;

pub fn os_trash(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|err| err.to_string())
}

pub struct FsDomain {
    trash: TrashFn,
}

impl FsDomain {
    pub fn new() -> Self {
        Self { trash: os_trash }
    }

    /// With a stand-in trash, so tests never touch the real one.
    pub fn with_trash(trash: TrashFn) -> Self {
        Self { trash }
    }
}

impl Default for FsDomain {
    fn default() -> Self {
        Self::new()
    }
}

impl Domain for FsDomain {
    fn name(&self) -> &'static str {
        "fs"
    }

    fn call(&self, method: &str, value: Value, _ctx: CallContext) -> Option<HandlerFuture> {
        let trash = self.trash;
        let handler: Box<dyn FnOnce(Value) -> Result<Value, HostError> + Send> = match method {
            "readDir" => Box::new(|v| to_json(read_dir(&params::<FsPathParams>(v)?.path)?)),
            "listFiles" => Box::new(|v| to_json(list_files(&params::<FsPathParams>(v)?.path, LIST_CAP, None))),
            "readFile" => Box::new(|v| to_json(read_file(&params::<FsPathParams>(v)?.path)?)),
            "writeFile" => Box::new(|v| {
                let p: FsWriteParams = params(v)?;
                fs::write(&p.path, p.content).map_err(|err| io_error(err, "gravar", &p.path))?;
                Ok(json!(true))
            }),
            "createFile" => Box::new(|v| to_json(create_file(&params::<FsPathParams>(v)?.path)?)),
            "createDir" => Box::new(|v| to_json(create_dir(&params::<FsPathParams>(v)?.path)?)),
            "rename" => Box::new(|v| {
                let p: FsRenameParams = params(v)?;
                fs::rename(&p.from, &p.to).map_err(|err| io_error(err, "renomear", &p.from))?;
                Ok(json!(true))
            }),
            "move" => Box::new(|v| {
                let p: FsTransferParams = params(v)?;
                to_json(move_into(&p.src, &p.dest_dir)?)
            }),
            "copyPath" => Box::new(|v| {
                let p: FsTransferParams = params(v)?;
                let dest = unique_path(&p.dest_dir, &node_path::basename(&p.src));
                copy_into(&p.src, &dest)?;
                to_json(dest)
            }),
            "duplicate" => Box::new(|v| {
                let src = params::<FsPathParams>(v)?.path;
                let dest = unique_path(&node_path::dirname(&src), &node_path::basename(&src));
                copy_into(&src, &dest)?;
                to_json(dest)
            }),
            "delete" => Box::new(|v| {
                let path = params::<FsPathParams>(v)?.path;
                remove(&path)?;
                Ok(json!(true))
            }),
            "trash" => Box::new(move |v| {
                let path = params::<FsPathParams>(v)?.path;
                if path.is_empty() {
                    return Err(HostError::new(ErrorCode::Invalid, "Caminho inválido."));
                }
                trash(Path::new(&path)).map_err(|err| {
                    HostError::new(ErrorCode::Internal, format!("Não foi possível mover {} para a lixeira: {err}", node_path::basename(&path)))
                })?;
                Ok(json!(true))
            }),
            "uniquePath" => Box::new(|v| {
                let p: FsUniqueParams = params(v)?;
                to_json(unique_path(&p.dir, &p.name))
            }),
            _ => return None,
        };
        Some(Box::pin(blocking(move || handler(value))))
    }
}

/// Runs blocking file work off the async workers.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, HostError> + Send + 'static,
) -> Result<T, HostError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| HostError::new(ErrorCode::Internal, "A operação foi interrompida."))?
}

pub(crate) fn to_json<T: Serialize>(value: T) -> Result<Value, HostError> {
    serde_json::to_value(value).map_err(|err| HostError::new(ErrorCode::Internal, format!("Resposta inválida: {err}")))
}

/// An I/O failure as a pt-BR error naming the item (`verb` is what failed:
/// "ler", "gravar"…).
pub(crate) fn io_error(err: io::Error, verb: &str, path: &str) -> HostError {
    let name = node_path::basename(path);
    let name = if name.is_empty() { path.to_string() } else { name };
    match err.kind() {
        io::ErrorKind::NotFound => HostError::new(ErrorCode::NotFound, format!("Não encontrado: {name}")),
        io::ErrorKind::AlreadyExists => HostError::new(ErrorCode::Invalid, format!("Já existe um item chamado {name}.")),
        io::ErrorKind::PermissionDenied => {
            HostError::new(ErrorCode::Internal, format!("Sem permissão para {verb} {name}."))
        }
        _ => HostError::new(ErrorCode::Internal, format!("Não foi possível {verb} {name}: {err}")),
    }
}

/// Folders first, then by name; the client re-sorts with the UI's collation.
pub fn read_dir(dir: &str) -> Result<Vec<FsEntry>, HostError> {
    let items = fs::read_dir(dir).map_err(|err| io_error(err, "ler a pasta", dir))?;
    let mut entries: Vec<FsEntry> = items
        .filter_map(Result::ok)
        .map(|item| {
            let name = item.file_name().to_string_lossy().into_owned();
            // Like Node's Dirent: a symlink (or junction) is not a folder.
            let is_dir = item.file_type().is_ok_and(|t| t.is_dir());
            FsEntry { path: node_path::join(&[dir, &name]), name, is_dir }
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

/// Every file under `root` (up to `cap`), depth first in directory order,
/// skipping `IGNORED_DIRS` and symlinks. Unreadable folders are skipped.
pub fn list_files(root: &str, cap: usize, cancel: Option<&AtomicBool>) -> Vec<FsListedFile> {
    let mut out = Vec::new();
    let root_path = Path::new(root);
    let walker = ignore::WalkBuilder::new(root_path)
        .standard_filters(false)
        .follow_links(false)
        .filter_entry(|entry| {
            entry.depth() == 0
                || !entry.file_type().is_some_and(|t| t.is_dir())
                || !IGNORED_DIRS.iter().any(|ignored| entry.file_name() == *ignored)
        })
        .build();
    for entry in walker {
        if out.len() >= cap || cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            break;
        }
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 || !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root_path) else { continue };
        let parts: Vec<String> = relative.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
        let rel = parts.join("/");
        out.push(FsListedFile { path: node_path::join(&[root, &parts.join(&SEP.to_string())]), rel });
    }
    out
}

pub fn read_file(path: &str) -> Result<String, HostError> {
    match fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            Err(HostError::new(ErrorCode::NotFound, format!("Arquivo não encontrado: {}", node_path::basename(path))))
        }
        Err(err) => Err(io_error(err, "ler", path)),
    }
}

pub fn create_file(path: &str) -> Result<FsEntry, HostError> {
    fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|err| io_error(err, "criar", path))?;
    Ok(FsEntry { name: node_path::basename(path), path: path.to_string(), is_dir: false })
}

pub fn create_dir(path: &str) -> Result<FsEntry, HostError> {
    fs::create_dir(path).map_err(|err| io_error(err, "criar a pasta", path))?;
    Ok(FsEntry { name: node_path::basename(path), path: path.to_string(), is_dir: true })
}

/// `src` into `dest_dir`, refusing to overwrite or to move a folder into
/// itself. Moving to where it already is answers `src` unchanged.
pub fn move_into(src: &str, dest_dir: &str) -> Result<String, HostError> {
    if node_path::dirname(src) == dest_dir {
        return Ok(src.to_string());
    }
    let inside = format!("{src}{SEP}");
    if src == dest_dir || dest_dir == inside || dest_dir.starts_with(&inside) {
        return Err(HostError::new(ErrorCode::Invalid, "Não é possível mover um item para dentro de si mesmo."));
    }
    let dest = node_path::join(&[dest_dir, &node_path::basename(src)]);
    if Path::new(&dest).exists() {
        return Err(HostError::new(ErrorCode::Invalid, "Já existe um item com esse nome no destino."));
    }
    fs::rename(src, &dest).map_err(|err| io_error(err, "mover", src))?;
    Ok(dest)
}

/// A free path for `name` in `dir`: `name`, `name copy`, `name copy 2`…
/// (before the extension).
pub fn unique_path(dir: &str, name: &str) -> String {
    let (base, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    let mut candidate = node_path::join(&[dir, name]);
    let mut i = 1;
    while Path::new(&candidate).exists() {
        let suffix = if i == 1 { " copy".to_string() } else { format!(" copy {i}") };
        candidate = node_path::join(&[dir, &format!("{base}{suffix}{ext}")]);
        i += 1;
    }
    candidate
}

/// Copies a file or a whole folder to `dest` (which must not exist).
pub fn copy_into(src: &str, dest: &str) -> Result<(), HostError> {
    if dest.starts_with(&format!("{src}{SEP}")) {
        return Err(HostError::new(ErrorCode::Invalid, "Não é possível copiar uma pasta para dentro dela mesma."));
    }
    copy_recursive(Path::new(src), Path::new(dest)).map_err(|err| io_error(err, "copiar", src))
}

fn copy_recursive(src: &Path, dest: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        return copy_symlink(src, dest);
    }
    if meta.is_dir() {
        fs::create_dir(dest)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dest.join(entry.file_name()))?;
        }
        return Ok(());
    }
    fs::copy(src, dest).map(|_| ())
}

/// A link stays a link; where links cannot be created (Windows without the
/// privilege) a file link is copied as the file it points to.
fn copy_symlink(src: &Path, dest: &Path) -> io::Result<()> {
    let target = fs::read_link(src)?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, dest)
    }
    #[cfg(windows)]
    {
        let to_dir = fs::metadata(src).is_ok_and(|m| m.is_dir());
        let linked =
            if to_dir { std::os::windows::fs::symlink_dir(&target, dest) } else { std::os::windows::fs::symlink_file(&target, dest) };
        match linked {
            Ok(()) => Ok(()),
            Err(_) if !to_dir => fs::copy(src, dest).map(|_| ()),
            Err(err) => Err(err),
        }
    }
}

/// `rm -rf`: a missing path is not an error; links are removed, not followed.
pub fn remove(path: &str) -> Result<(), HostError> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(io_error(err, "apagar", path)),
    };
    let result = if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path).or_else(|err| {
            if meta.file_type().is_symlink() {
                // A Windows directory link is removed as a directory.
                return fs::remove_dir(path);
            }
            if err.kind() == io::ErrorKind::PermissionDenied && meta.permissions().readonly() {
                let mut permissions = meta.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                permissions.set_readonly(false);
                fs::set_permissions(path, permissions)?;
                return fs::remove_file(path);
            }
            Err(err)
        })
    };
    result.map_err(|err| io_error(err, "apagar", path))
}

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// `GET /files?path=` streams a file; `PUT /files?path=` writes the body to
/// it (creating or replacing); `PUT /files?temp=<ext>` writes the body to a
/// new temporary file. A PUT answers `FilesWritten`. The caller is already
/// authenticated.
pub async fn serve_files(method: Method, uri: &Uri, body: Body) -> Response {
    let Ok(Query(query)) = Query::<FilesQuery>::try_from_uri(uri) else {
        return files_error(StatusCode::BAD_REQUEST, &HostError::new(ErrorCode::Invalid, "Consulta inválida."));
    };
    let result = match method {
        Method::GET => download(query).await,
        Method::PUT => upload(query, body).await,
        _ => Err(HostError::new(ErrorCode::Invalid, "Use GET ou PUT.")),
    };
    result.unwrap_or_else(|err| {
        let status = match err.code {
            ErrorCode::NotFound => StatusCode::NOT_FOUND,
            ErrorCode::Invalid => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        files_error(status, &err)
    })
}

fn files_error(status: StatusCode, err: &HostError) -> Response {
    (status, Json(json!({ "code": err.code, "message": err.message }))).into_response()
}

async fn download(query: FilesQuery) -> Result<Response, HostError> {
    let path = query.path.filter(|p| !p.is_empty()).ok_or_else(|| HostError::new(ErrorCode::Invalid, "Informe o caminho."))?;
    // Windows refuses to open a folder as a file, so ask first.
    if tokio::fs::metadata(&path).await.is_ok_and(|meta| meta.is_dir()) {
        return Err(HostError::new(ErrorCode::Invalid, "O caminho é uma pasta."));
    }
    let file = tokio::fs::File::open(&path).await.map_err(|err| io_error(err, "ler", &path))?;
    let meta = file.metadata().await.map_err(|err| io_error(err, "ler", &path))?;
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(file));
    Ok(([(header::CONTENT_TYPE, "application/octet-stream".to_string()), (header::CONTENT_LENGTH, meta.len().to_string())], body)
        .into_response())
}

async fn upload(query: FilesQuery, body: Body) -> Result<Response, HostError> {
    let path = match (query.path.filter(|p| !p.is_empty()), query.temp) {
        (Some(path), _) => path,
        (None, Some(ext)) => temp_path(&ext)?,
        (None, None) => return Err(HostError::new(ErrorCode::Invalid, "Informe o caminho ou a extensão temporária.")),
    };
    let mut file = tokio::fs::File::create(&path).await.map_err(|err| io_error(err, "gravar", &path))?;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| HostError::new(ErrorCode::Invalid, "O envio foi interrompido."))?;
        file.write_all(&chunk).await.map_err(|err| io_error(err, "gravar", &path))?;
    }
    file.flush().await.map_err(|err| io_error(err, "gravar", &path))?;
    Ok(Json(FilesWritten { path }).into_response())
}

/// `<tmp>/prism-img-<ms>-<n>.<ext>`, as `fs:saveTempImage` named them.
fn temp_path(ext: &str) -> Result<String, HostError> {
    let valid = !ext.is_empty() && ext.len() <= 16 && ext.bytes().all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(&b));
    if !valid || ext.starts_with('.') {
        return Err(HostError::new(ErrorCode::Invalid, "Extensão inválida."));
    }
    let name = format!("prism-img-{}-{}.{ext}", crate::now_ms(), TEMP_SEQ.fetch_add(1, Ordering::Relaxed));
    Ok(node_path::join(&[&std::env::temp_dir().to_string_lossy(), &name]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        (dir, path)
    }

    #[test]
    fn read_dir_lists_folders_first_with_node_paths() {
        let (_dir, root) = temp();
        fs::write(Path::new(&root).join("b.txt"), "").unwrap();
        fs::write(Path::new(&root).join("A.txt"), "").unwrap();
        fs::create_dir(Path::new(&root).join("z")).unwrap();
        let entries = read_dir(&root).unwrap();
        let names: Vec<_> = entries.iter().map(|e| (e.name.as_str(), e.is_dir)).collect();
        assert_eq!(names, [("z", true), ("A.txt", false), ("b.txt", false)]);
        assert_eq!(entries[0].path, node_path::join(&[&root, "z"]));
        assert_eq!(read_dir(&format!("{root}{SEP}missing")).unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn list_files_skips_ignored_folders_and_honors_the_cap() {
        let (_dir, root) = temp();
        for rel in ["src/a.ts", "src/deep/b.ts", "node_modules/x/index.js", ".git/HEAD", "target/out.bin", "README.md"] {
            let path = Path::new(&root).join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        }
        let mut rels: Vec<String> = list_files(&root, LIST_CAP, None).into_iter().map(|f| f.rel).collect();
        rels.sort();
        assert_eq!(rels, ["README.md", "src/a.ts", "src/deep/b.ts"]);
        let first = &list_files(&root, LIST_CAP, None)[0];
        assert_eq!(first.path, node_path::join(&[&root, &first.rel.replace('/', &SEP.to_string())]));
        assert_eq!(list_files(&root, 2, None).len(), 2);
        assert!(list_files(&format!("{root}{SEP}nope"), LIST_CAP, None).is_empty());
        // A file as the root lists nothing, like readdir failing on it.
        assert!(list_files(&node_path::join(&[&root, "README.md"]), LIST_CAP, None).is_empty());
    }

    #[test]
    fn read_file_is_lossy_utf8_and_names_missing_files() {
        let (_dir, root) = temp();
        let path = node_path::join(&[&root, "x.txt"]);
        fs::write(&path, b"\xEF\xBB\xBFol\xE1 \xff!").unwrap();
        assert_eq!(read_file(&path).unwrap(), "\u{feff}ol\u{fffd} \u{fffd}!");
        let err = read_file(&node_path::join(&[&root, "nada.txt"])).unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (ErrorCode::NotFound, "Arquivo não encontrado: nada.txt"));
    }

    #[test]
    fn create_never_overwrites() {
        let (_dir, root) = temp();
        let file = node_path::join(&[&root, "n.txt"]);
        assert_eq!(create_file(&file).unwrap(), FsEntry { name: "n.txt".into(), path: file.clone(), is_dir: false });
        assert!(create_file(&file).is_err());
        let dir = node_path::join(&[&root, "d"]);
        assert!(create_dir(&dir).unwrap().is_dir);
        assert!(create_dir(&dir).is_err());
        assert!(create_dir(&node_path::join(&[&root, "a", "b"])).is_err(), "not recursive");
    }

    #[test]
    fn unique_paths_add_copy_before_the_extension() {
        let (_dir, root) = temp();
        assert_eq!(unique_path(&root, "a.txt"), node_path::join(&[&root, "a.txt"]));
        fs::write(Path::new(&root).join("a.txt"), "").unwrap();
        assert_eq!(unique_path(&root, "a.txt"), node_path::join(&[&root, "a copy.txt"]));
        fs::write(Path::new(&root).join("a copy.txt"), "").unwrap();
        assert_eq!(unique_path(&root, "a.txt"), node_path::join(&[&root, "a copy 2.txt"]));
        fs::write(Path::new(&root).join(".env"), "").unwrap();
        assert_eq!(unique_path(&root, ".env"), node_path::join(&[&root, ".env copy"]));
    }

    #[test]
    fn move_copy_duplicate_and_delete() {
        let (_dir, root) = temp();
        let src = node_path::join(&[&root, "pasta"]);
        fs::create_dir_all(Path::new(&src).join("sub")).unwrap();
        fs::write(Path::new(&src).join("sub").join("f.txt"), "oi").unwrap();
        let dest_dir = node_path::join(&[&root, "destino"]);
        fs::create_dir(&dest_dir).unwrap();

        assert_eq!(move_into(&src, &root).unwrap(), src, "already there");
        let inside = node_path::join(&[&src, "sub"]);
        assert_eq!(move_into(&src, &inside).unwrap_err().message, "Não é possível mover um item para dentro de si mesmo.");

        let copied = unique_path(&dest_dir, "pasta");
        copy_into(&src, &copied).unwrap();
        assert_eq!(fs::read_to_string(Path::new(&copied).join("sub").join("f.txt")).unwrap(), "oi");
        assert!(copy_into(&src, &node_path::join(&[&src, "sub", "pasta"])).is_err(), "into itself");
        assert_eq!(move_into(&src, &dest_dir).unwrap_err().message, "Já existe um item com esse nome no destino.");

        let duplicate = unique_path(&node_path::dirname(&copied), &node_path::basename(&copied));
        assert_eq!(duplicate, node_path::join(&[&dest_dir, "pasta copy"]));
        copy_into(&copied, &duplicate).unwrap();

        let moved = move_into(&src, &node_path::join(&[&dest_dir, "pasta copy"])).unwrap();
        assert_eq!(moved, node_path::join(&[&dest_dir, "pasta copy", "pasta"]));
        assert!(!Path::new(&src).exists());

        remove(&dest_dir).unwrap();
        assert!(!Path::new(&dest_dir).exists());
        remove(&dest_dir).unwrap();
    }

    #[test]
    fn delete_removes_read_only_files() {
        let (_dir, root) = temp();
        let file = node_path::join(&[&root, "ro.txt"]);
        fs::write(&file, "x").unwrap();
        let mut permissions = fs::metadata(&file).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&file, permissions).unwrap();
        remove(&file).unwrap();
        assert!(!Path::new(&file).exists());
    }

    #[test]
    fn temp_names_follow_save_temp_image() {
        let path = temp_path("png").unwrap();
        assert!(node_path::basename(&path).starts_with("prism-img-") && path.ends_with(".png"));
        for bad in ["", "../x", "a/b", "a\\b", ".png", "x".repeat(17).as_str()] {
            assert!(temp_path(bad).is_err(), "{bad}");
        }
    }
}

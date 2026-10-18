use std::fmt;
use std::io;

/// A storage failure. The `Display` text is pt-BR, ready for the UI.
#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Io(io::Error),
    Json(serde_json::Error),
    /// The database was written by a newer host (schema `found` > `supported`).
    TooNew { found: u32, supported: u32 },
    Invalid(String),
}

pub type Result<T, E = StoreError> = std::result::Result<T, E>;

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Sqlite(err) => write!(f, "Erro no banco de dados do host: {err}"),
            StoreError::Io(err) => write!(f, "Erro de arquivo no armazenamento do host: {err}"),
            StoreError::Json(err) => write!(f, "Registro inválido no banco do host: {err}"),
            StoreError::TooNew { found, supported } => write!(
                f,
                "O banco do host foi criado por uma versão mais nova (esquema {found}; esta versão entende até {supported}). Atualize o Prism."
            ),
            StoreError::Invalid(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            StoreError::Sqlite(err) => Some(err),
            StoreError::Io(err) => Some(err),
            StoreError::Json(err) => Some(err),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(err: rusqlite::Error) -> Self {
        StoreError::Sqlite(err)
    }
}

impl From<io::Error> for StoreError {
    fn from(err: io::Error) -> Self {
        StoreError::Io(err)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(err: serde_json::Error) -> Self {
        StoreError::Json(err)
    }
}

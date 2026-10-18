use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

/// Daily-rotated `<data>/logs/host.*.log` (a week kept), filtered by
/// `PRISM_HOST_LOG` (default `info`); `--verbose` mirrors to stderr. The
/// returned guard flushes the file on drop, so keep it for the process life.
pub fn init(data_dir: &Path, verbose: bool) -> Option<WorkerGuard> {
    let filter = EnvFilter::try_from_env("PRISM_HOST_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let file = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("host")
        .filename_suffix("log")
        .max_log_files(7)
        .build(data_dir.join("logs"))
        .ok();
    let (file_layer, guard) = match file {
        Some(appender) => {
            let (writer, guard) = tracing_appender::non_blocking(appender);
            (Some(fmt::layer().with_writer(writer).with_ansi(false)), Some(guard))
        }
        None => (None, None),
    };
    let stderr_layer = (verbose || guard.is_none()).then(|| fmt::layer().with_writer(std::io::stderr));
    let _ = tracing_subscriber::registry().with(filter).with(file_layer).with(stderr_layer).try_init();
    guard
}

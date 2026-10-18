use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use prism_host::{logging, paths, Config, Outcome, VERSION};

const USAGE: &str = "prism-host [--data-dir <pasta>] [--port <porta>] [--idle-timeout <segundos>] [--verbose] [--version]

  --data-dir      onde o host guarda estado, logs e host-instance.json
                  (padrão: %APPDATA%\\prism-ide\\host ou ~/.local/share/prism-host)
  --port          porta no 127.0.0.1 (padrão: escolhida pelo sistema)
  --idle-timeout  encerra após N segundos sem clientes nem trabalho (padrão: 900; 0 desliga)
  --verbose       também escreve o log no stderr";

/// Exit codes: 0 stopped, 1 error, 2 bad arguments, 3 another host already
/// owns this data directory.
fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let parsed = match parse(&args) {
        Ok(Parsed::Version) => {
            println!("{VERSION}");
            return ExitCode::SUCCESS;
        }
        Ok(Parsed::Help) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Ok(Parsed::Run(parsed)) => parsed,
        Err(message) => {
            eprintln!("{message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let (config, verbose) = parsed;
    if let Err(err) = std::fs::create_dir_all(&config.data_dir) {
        eprintln!("não foi possível criar {}: {err}", config.data_dir.display());
        return ExitCode::from(1);
    }
    let _log = logging::init(&config.data_dir, verbose);
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(err) => {
            tracing::error!(%err, "falha ao iniciar o runtime");
            return ExitCode::from(1);
        }
    };
    match runtime.block_on(prism_host::run(config)) {
        Ok(Outcome::Stopped) => ExitCode::SUCCESS,
        Ok(Outcome::AlreadyRunning) => {
            eprintln!("outro prism-host já está rodando neste diretório de dados");
            ExitCode::from(3)
        }
        Err(err) => {
            tracing::error!(%err, "o host parou com erro");
            eprintln!("prism-host: {err}");
            ExitCode::from(1)
        }
    }
}

enum Parsed {
    Run((Config, bool)),
    Version,
    Help,
}

fn parse(args: &[String]) -> Result<Parsed, String> {
    let mut config = Config { data_dir: paths::default_data_dir(), port: 0, idle_timeout: Some(Duration::from_secs(900)) };
    let mut verbose = false;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| it.next().cloned().ok_or_else(|| format!("{name} precisa de um valor"));
        match arg.as_str() {
            "--version" | "-V" => return Ok(Parsed::Version),
            "--help" | "-h" => return Ok(Parsed::Help),
            "--verbose" => verbose = true,
            "--data-dir" => config.data_dir = PathBuf::from(value("--data-dir")?),
            "--port" => config.port = value("--port")?.parse().map_err(|_| "--port inválido".to_string())?,
            "--idle-timeout" => {
                let secs: u64 = value("--idle-timeout")?.parse().map_err(|_| "--idle-timeout inválido".to_string())?;
                config.idle_timeout = (secs > 0).then(|| Duration::from_secs(secs));
            }
            other => return Err(format!("argumento desconhecido: {other}")),
        }
    }
    Ok(Parsed::Run((config, verbose)))
}

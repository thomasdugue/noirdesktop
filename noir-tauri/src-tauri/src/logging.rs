// logging.rs — Logs persistants sur disque pour debug post-mortem
//
// Sentry capture les crashes mais pas les bugs non-fatals (audio qui se coupe,
// scan SMB qui freeze, etc). Pour ceux-là, l'utilisateur a besoin de joindre
// les logs récents au feedback. Cette infra écrit dans :
//   ~/.local/share/noir/logs/noir-YYYY-MM-DD.log
// Rotation journalière, garde 7 jours.
//
// Le `WorkerGuard` retourné par init() doit rester en scope pour toute la
// durée de l'app — sinon le buffer non-bloquant n'est pas flushé à l'arrêt.

use std::fs;
use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

const MAX_LOGS_KEPT: usize = 7;

fn logs_dir() -> PathBuf {
    let base = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("noir")
        .join("logs");
    let _ = fs::create_dir_all(&base);
    base
}

/// Initialise la pipeline de logs : `tracing` macros → fichier journalier + stderr.
/// Le guard doit être conservé pour toute la durée de l'app (flush à l'arrêt).
/// Si l'init échoue (cas extrême : pas de droits d'écriture), on retourne None
/// et l'app continue sans logs persistés (stderr only).
pub fn init() -> Option<WorkerGuard> {
    let dir = logs_dir();
    cleanup_old_logs(&dir);

    let appender = RollingFileAppender::new(Rotation::DAILY, &dir, "noir.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(appender);

    // En release : info+ vers fichier, warn+ vers stderr (peu verbeux)
    // En debug : debug+ vers les deux (tracing dev)
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| {
            if cfg!(debug_assertions) {
                EnvFilter::new("noir_tauri_lib=debug,info")
            } else {
                EnvFilter::new("noir_tauri_lib=info,warn")
            }
        });

    let file_layer = fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(false);

    let stderr_layer = fmt::layer()
        .with_writer(std::io::stderr)
        .with_ansi(true)
        .with_target(false);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer)
        .with(stderr_layer)
        .try_init()
        .ok()?;

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        "logging initialized — file: {:?}",
        dir
    );

    Some(guard)
}

/// Supprime les fichiers de log au-delà de MAX_LOGS_KEPT (~7 jours).
/// Tracing-appender ne fait PAS de cleanup — c'est à nous de le gérer.
fn cleanup_old_logs(dir: &PathBuf) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("log")
                && !p.file_name().and_then(|s| s.to_str()).is_some_and(|s| s.contains("noir.log"))
            {
                return None;
            }
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((p, modified))
        })
        .collect();

    if files.len() <= MAX_LOGS_KEPT {
        return;
    }

    // Tri par date décroissante : on garde les MAX_LOGS_KEPT plus récents
    files.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in files.iter().skip(MAX_LOGS_KEPT) {
        let _ = fs::remove_file(path);
    }
}

/// Lit les logs récents (jusqu'à `max_bytes` depuis la fin), tronqués au début
/// pour ne pas dépasser la limite. Concatène les 2 derniers fichiers de log
/// si nécessaire (transition de jour). Utilisé par la commande `get_recent_logs`.
pub fn read_recent_logs(max_bytes: usize) -> String {
    let dir = logs_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return String::from("[no logs available]");
    };

    let mut files: Vec<(PathBuf, std::time::SystemTime)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?;
            if !name.starts_with("noir.log") {
                return None;
            }
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((p, modified))
        })
        .collect();

    if files.is_empty() {
        return String::from("[no logs available]");
    }

    // Tri date décroissante : plus récent d'abord
    files.sort_by(|a, b| b.1.cmp(&a.1));

    let mut out = String::new();
    let mut budget = max_bytes;

    for (path, _) in files.iter().take(2) {
        if budget == 0 {
            break;
        }
        let content = fs::read_to_string(path).unwrap_or_default();
        // Garde les `budget` derniers octets (tail) pour avoir les logs les plus récents
        let slice = if content.len() > budget {
            // Coupe au prochain saut de ligne pour ne pas casser une ligne au milieu
            let start = content.len() - budget;
            let snip = &content[start..];
            match snip.find('\n') {
                Some(nl) => &snip[nl + 1..],
                None => snip,
            }
        } else {
            &content[..]
        };
        let header = format!("=== {} ===\n", path.file_name().unwrap_or_default().to_string_lossy());
        out.push_str(&header);
        out.push_str(slice);
        out.push('\n');
        budget = budget.saturating_sub(slice.len() + header.len());
    }

    if out.is_empty() {
        String::from("[logs empty]")
    } else {
        out
    }
}

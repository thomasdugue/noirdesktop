// sentry_init.rs — Initialisation Sentry (Rust + forwarder JS)
//
// DSN injecté au compile-time via option_env!("HEAN_SENTRY_DSN").
// Sans DSN (dev local) : init() retourne None — aucun overhead.
//
// Le ClientInitGuard renvoyé doit être gardé en scope pour toute la durée
// de l'app (sinon les events ne sont pas flushés à l'arrêt). On l'attache
// donc à pub fn run() via `let _sentry_guard = sentry_init::init();`.

use std::borrow::Cow;
use std::sync::atomic::{AtomicBool, Ordering};
use sentry::protocol::Event;

/// Toggle runtime contrôlé par l'utilisateur (Settings → Privacy).
/// Lu par `before_send` à chaque event : si false, l'event est blackholé
/// même quand Sentry est init. Permet de désactiver immédiatement sans
/// redémarrage. Initialisé au boot depuis config.json.
pub static SENTRY_ENABLED: AtomicBool = AtomicBool::new(true);

/// Initialise Sentry si HEAN_SENTRY_DSN est défini au build ET si l'utilisateur
/// n'a pas désactivé le crash reporting dans Settings → Privacy.
/// Retourne le guard à garder en vie pour toute la durée de l'app.
pub fn init(enabled: bool) -> Option<sentry::ClientInitGuard> {
    SENTRY_ENABLED.store(enabled, Ordering::Relaxed);

    if !enabled {
        // L'utilisateur a explicitement désactivé Sentry. Aucun network call,
        // aucun event capturé, aucun panic hook installé.
        return None;
    }

    let dsn = option_env!("HEAN_SENTRY_DSN").unwrap_or("");
    if dsn.is_empty() {
        // Pas de DSN injecté → no-op silencieux (build dev ou release sans Sentry)
        return None;
    }

    let guard = sentry::init((
        dsn,
        sentry::ClientOptions {
            release: Some(Cow::Borrowed(env!("CARGO_PKG_VERSION"))),
            environment: Some(Cow::Borrowed("beta")),
            // Capture tous les events (pas de sampling pour la beta)
            sample_rate: 1.0,
            // Anonymisation des paths utilisateur + check du toggle runtime
            before_send: Some(std::sync::Arc::new(scrub_event)),
            // Strip /Users/<x>/... des stacktraces côté Sentry également
            send_default_pii: false,
            ..Default::default()
        },
    ));

    // Le panic hook est auto-enregistré par la feature "panic"
    Some(guard)
}

/// Remplace les paths utilisateur (`/Users/<name>/...`, `/home/<name>/...`)
/// par `<HOME>/...` dans message + breadcrumbs + exception values.
/// Évite de fuiter le nom d'utilisateur macOS via Sentry.
/// Drop l'event si l'utilisateur a désactivé le crash reporting.
fn scrub_event(mut event: Event<'static>) -> Option<Event<'static>> {
    // Toggle runtime — si désactivé, drop l'event sans envoi
    if !SENTRY_ENABLED.load(Ordering::Relaxed) {
        return None;
    }

    if let Some(msg) = event.message.as_mut() {
        *msg = scrub_paths(msg);
    }

    for exc in event.exception.values.iter_mut() {
        if let Some(val) = exc.value.as_mut() {
            *val = scrub_paths(val);
        }
    }

    for bc in event.breadcrumbs.iter_mut() {
        if let Some(msg) = bc.message.as_mut() {
            *msg = scrub_paths(msg);
        }
    }

    Some(event)
}

fn scrub_paths(s: &str) -> String {
    // /Users/foo/... → <HOME>/...
    let re_macos = regex_replace(s, "/Users/", "<HOME>");
    // /home/foo/... → <HOME>/...
    regex_replace(&re_macos, "/home/", "<HOME>")
}

/// Remplace `<prefix><name>/<rest>` par `<replacement>/<rest>`.
/// Implémentation manuelle (pas de regex en dépendance) — suffit pour
/// /Users/<name>/ et /home/<name>/ qui sont les seuls cas qui nous intéressent.
fn regex_replace(input: &str, prefix: &str, replacement: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find(prefix) {
        out.push_str(&rest[..pos]);
        out.push_str(replacement);
        let after_prefix = &rest[pos + prefix.len()..];
        // Skip jusqu'au prochain '/' ou fin de chaîne (= le username)
        match after_prefix.find('/') {
            Some(slash) => {
                rest = &after_prefix[slash..]; // garde le '/'
            }
            None => {
                // Pas de slash → le username était le dernier segment
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// True si Sentry a été initialisé pendant cette session (DSN présent + enabled au boot).
/// Si false : activer le toggle dans Settings ne prend effet qu'au prochain redémarrage.
pub fn is_initialized() -> bool {
    sentry::Hub::current().client().is_some()
}

/// Met à jour le toggle runtime. Si Sentry n'est pas init, ce changement
/// n'aura d'effet qu'au prochain redémarrage de l'app (cf. is_initialized).
pub fn set_enabled(enabled: bool) {
    SENTRY_ENABLED.store(enabled, Ordering::Relaxed);
}

/// Lit l'état runtime du toggle.
pub fn is_enabled() -> bool {
    SENTRY_ENABLED.load(Ordering::Relaxed)
}

/// Capture une erreur JS (forwardée depuis le frontend via window.onerror /
/// unhandledrejection). Appelée par la commande Tauri `report_js_error`.
pub fn capture_js_error(message: &str, source: Option<&str>, line: Option<u32>, stack: Option<&str>) {
    use sentry::protocol::{Event, Exception, Level};

    let mut formatted = scrub_paths(message);
    if let (Some(src), Some(ln)) = (source, line) {
        formatted = format!("{} (at {}:{})", formatted, scrub_paths(src), ln);
    } else if let Some(src) = source {
        formatted = format!("{} (at {})", formatted, scrub_paths(src));
    }

    let mut event = Event {
        level: Level::Error,
        message: Some(formatted.clone()),
        ..Default::default()
    };

    event.exception.values.push(Exception {
        ty: "JavaScriptError".to_string(),
        value: Some(formatted),
        ..Default::default()
    });

    if let Some(stk) = stack {
        event.extra.insert(
            "js_stack".into(),
            serde_json::Value::String(scrub_paths(stk)),
        );
    }

    sentry::capture_event(event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrubs_macos_user_path() {
        assert_eq!(
            scrub_paths("/Users/thomas/Documents/foo.flac failed"),
            "<HOME>/Documents/foo.flac failed"
        );
    }

    #[test]
    fn scrubs_linux_user_path() {
        assert_eq!(
            scrub_paths("error at /home/jdoe/music/x.mp3"),
            "error at <HOME>/music/x.mp3"
        );
    }

    #[test]
    fn handles_multiple_paths_in_one_message() {
        assert_eq!(
            scrub_paths("copy /Users/a/x to /Users/b/y"),
            "copy <HOME>/x to <HOME>/y"
        );
    }

    #[test]
    fn leaves_other_paths_alone() {
        assert_eq!(
            scrub_paths("/var/log/system.log /tmp/foo"),
            "/var/log/system.log /tmp/foo"
        );
    }

    #[test]
    fn handles_path_at_end_of_string() {
        assert_eq!(scrub_paths("at /Users/thomas"), "at <HOME>");
    }
}

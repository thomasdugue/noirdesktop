// network/credentials.rs — Gestion des credentials via macOS Keychain

#[cfg(target_os = "macos")]
use security_framework::passwords::{
    set_generic_password, get_generic_password, delete_generic_password,
};

use std::collections::HashMap;
use std::sync::Mutex;
use once_cell::sync::Lazy;

const KEYCHAIN_SERVICE: &str = "com.tdugue.noir.smb";

/// Cache mémoire session des mots de passe (évite les dialogs Keychain répétées)
/// Peuplé à la première récupération Keychain, invalidé à la suppression
static PASSWORD_CACHE: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| {
    Mutex::new(HashMap::new())
});

/// Vérifie si un mot de passe est en cache mémoire de session (SANS toucher au Keychain).
/// Utilisé pour décider si une connexion SMB peut être tentée sans provoquer de dialog.
pub fn has_password_in_session(source_id: &str) -> bool {
    PASSWORD_CACHE.lock()
        .map(|c| c.contains_key(source_id))
        .unwrap_or(false)
}

/// Stocke un mot de passe SMB dans le Keychain macOS + dans le cache mémoire session
pub fn store_password(source_id: &str, password: &str) -> Result<(), String> {
    // Met en cache mémoire en même temps → future retrieve_password évite le Keychain
    if let Ok(mut cache) = PASSWORD_CACHE.lock() {
        cache.insert(source_id.to_string(), password.to_string());
    }

    #[cfg(target_os = "macos")]
    {
        set_generic_password(KEYCHAIN_SERVICE, source_id, password.as_bytes())
            .map_err(|e| format!("Keychain store failed: {}", e))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (source_id, password);
        Err("Keychain not available on this platform".to_string())
    }
}

/// Récupère un mot de passe SMB — cache mémoire d'abord, Keychain en fallback.
/// Tient le Mutex pendant l'intégralité de l'opération (check + fetch + store) pour éviter
/// la race condition où deux threads voient simultanément "cache miss" et déclenchent
/// chacun une dialog Keychain macOS.
pub fn retrieve_password(source_id: &str) -> Result<String, String> {
    // Acquire once — tenu pendant tout l'appel Keychain (bloquant mais atomique)
    let mut cache = PASSWORD_CACHE.lock().map_err(|e| e.to_string())?;

    // 1. Cache mémoire (accès instantané, sans dialog)
    if let Some(pw) = cache.get(source_id) {
        return Ok(pw.clone());
    }

    // 2. Fallback : Keychain macOS (dialog uniquement la 1ère fois par source par session)
    //    Le Mutex est toujours tenu → un seul appel Keychain possible à la fois
    #[cfg(target_os = "macos")]
    {
        let bytes = get_generic_password(KEYCHAIN_SERVICE, source_id)
            .map_err(|e| format!("Keychain retrieve failed: {}", e))?;
        let password = String::from_utf8(bytes)
            .map_err(|e| format!("Password UTF-8 error: {}", e))?;
        cache.insert(source_id.to_string(), password.clone());
        Ok(password)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = source_id;
        Err("Keychain not available on this platform".to_string())
    }
}

/// Supprime un mot de passe SMB du Keychain macOS + du cache mémoire session
pub fn delete_password(source_id: &str) -> Result<(), String> {
    // Invalider le cache mémoire
    if let Ok(mut cache) = PASSWORD_CACHE.lock() {
        cache.remove(source_id);
    }

    #[cfg(target_os = "macos")]
    {
        delete_generic_password(KEYCHAIN_SERVICE, source_id)
            .map_err(|e| format!("Keychain delete failed: {}", e))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = source_id;
        Err("Keychain not available on this platform".to_string())
    }
}

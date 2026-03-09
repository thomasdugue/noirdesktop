// network/smb.rs — Connexion SMB, navigation shares/dossiers via pavao

use pavao::{SmbClient, SmbCredentials, SmbDirentType, SmbOpenOptions, SmbOptions};
use super::{SmbShare, SmbEntry};
use std::sync::Mutex;
use once_cell::sync::Lazy;
use std::io::Read;

/// Connexion SMB active (pavao utilise un contexte global singleton)
struct ActiveConnection {
    client: SmbClient,
    host: String,
    share: String,
}

/// Credentials stockées pour pouvoir se reconnecter au bon share dans browse()
#[derive(Clone)]
struct StoredCredentials {
    username: String,
    password: String,
    workgroup: Option<String>,
    is_guest: bool,
}

/// Construit une URL SMB correcte — wrap les adresses IPv6 dans des crochets
fn smb_url(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        // IPv6 brut → smb://[addr]
        format!("smb://[{}]", host)
    } else {
        format!("smb://{}", host)
    }
}

/// Une seule connexion SMB active à la fois (limitation pavao: contexte global)
static CONNECTION: Lazy<Mutex<Option<ActiveConnection>>> = Lazy::new(|| {
    Mutex::new(None)
});

/// Credentials de la dernière connexion, pour reconnexion automatique par share
static LAST_CREDENTIALS: Lazy<Mutex<Option<StoredCredentials>>> = Lazy::new(|| {
    Mutex::new(None)
});

/// Helper interne : s'assure que la connexion est share-level pour (host, share).
/// Opère sur un MutexGuard **déjà acquis** → pas de double-lock, pas de race condition.
/// Appelé par browse(), read_file(), read_file_head() qui tiennent le lock pendant toute l'op.
fn ensure_connection_with_guard(
    conn: &mut Option<ActiveConnection>,
    host: &str,
    share: &str,
    username: &str,
    password: &str,
    workgroup: Option<&str>,
    is_guest: bool,
) -> Result<(), String> {
    // Réutiliser connexion existante si même host/share
    if let Some(ref active) = *conn {
        if active.host == host && active.share == share {
            return Ok(());
        }
    }

    // Drop l'ancienne connexion
    *conn = None;

    // Nouvelle connexion share-level
    let smb_server = smb_url(host);
    let share_path = if share.starts_with('/') {
        share.to_string()
    } else if share.is_empty() {
        String::new()  // niveau serveur
    } else {
        format!("/{}", share)
    };

    let mut creds = SmbCredentials::default()
        .server(&smb_server)
        .share(&share_path);

    if !is_guest {
        creds = creds.username(username).password(password);
        if let Some(wg) = workgroup {
            creds = creds.workgroup(wg);
        }
    }

    let client = SmbClient::new(creds, SmbOptions::default().one_share_per_server(true))
        .map_err(|e| format!("SMB connection failed to {}: {}", host, e))?;

    *conn = Some(ActiveConnection {
        client,
        host: host.to_string(),
        share: share.to_string(),
    });

    Ok(())
}

/// Crée ou récupère une connexion SMB vers un host/share (wrapper public)
/// Utilisé par scan_network_source_cmd pour la connexion initiale avant scan.
fn ensure_connection(
    host: &str,
    share: &str,
    username: &str,
    password: &str,
    workgroup: Option<&str>,
    is_guest: bool,
) -> Result<(), String> {
    let mut conn = CONNECTION.lock().map_err(|e| format!("Lock error: {}", e))?;
    ensure_connection_with_guard(&mut *conn, host, share, username, password, workgroup, is_guest)
}

/// Teste la connexion SMB à un host
pub fn connect(
    host: &str,
    username: &str,
    password: &str,
    workgroup: Option<&str>,
    is_guest: bool,
) -> Result<bool, String> {
    let smb_server = smb_url(host);

    // share vide = niveau serveur (smb://host/), évite le double slash smb://host//
    let mut creds = SmbCredentials::default()
        .server(&smb_server)
        .share("");

    if !is_guest {
        creds = creds.username(username).password(password);
        if let Some(wg) = workgroup {
            creds = creds.workgroup(wg);
        }
    }

    // Acquérir le lock une seule fois pour toute l'opération
    let mut conn = CONNECTION.lock().map_err(|e| format!("Lock error: {}", e))?;
    *conn = None;

    let client = SmbClient::new(creds, SmbOptions::default().one_share_per_server(true))
        .map_err(|e| format!("SMB connection failed to {}: {}", host, e))?;

    // Tester la connexion en listant les shares (chemin "" = racine serveur)
    match client.list_dir("") {
        Ok(_) => {
            *conn = Some(ActiveConnection {
                client,
                host: host.to_string(),
                share: String::new(),
            });
            // Stocker les credentials pour permettre la reconnexion par share dans browse()
            let mut last_creds = LAST_CREDENTIALS.lock().map_err(|e| format!("Lock error: {}", e))?;
            *last_creds = Some(StoredCredentials {
                username: username.to_string(),
                password: password.to_string(),
                workgroup: workgroup.map(|s| s.to_string()),
                is_guest,
            });
            Ok(true)
        }
        Err(e) => Err(format!("SMB connection test failed: {}", e)),
    }
}

/// Stocke les credentials sans créer de connexion (pour ensure_connection aval)
/// Permet à get_cover_smb et audio_play de ne pas dropper la connexion SMB existante
pub fn store_credentials(
    username: &str,
    password: &str,
    workgroup: Option<&str>,
    is_guest: bool,
) {
    if let Ok(mut creds) = LAST_CREDENTIALS.lock() {
        *creds = Some(StoredCredentials {
            username: username.to_string(),
            password: password.to_string(),
            workgroup: workgroup.map(|s| s.to_string()),
            is_guest,
        });
    }
}

/// Liste les shares disponibles sur un host SMB
pub fn list_shares(host: &str) -> Result<Vec<SmbShare>, String> {
    let stored = {
        let creds = LAST_CREDENTIALS.lock().map_err(|e| format!("Lock error: {}", e))?;
        creds.clone().ok_or_else(|| format!("No credentials stored for {}", host))?
    };

    // Acquérir le lock une seule fois — pas de double-lock
    let mut conn = CONNECTION.lock().map_err(|e| format!("Lock error: {}", e))?;

    // Reconnecter au niveau serveur (share = "") si nécessaire
    let needs_server = match conn.as_ref() {
        Some(active) => !(active.host == host && active.share.is_empty()),
        None => true,
    };

    if needs_server {
        ensure_connection_with_guard(
            &mut *conn, host, "",
            &stored.username, &stored.password,
            stored.workgroup.as_deref(), stored.is_guest,
        )?;
    }

    let active = conn.as_ref()
        .ok_or_else(|| format!("No active connection to {}", host))?;

    let entries = active.client.list_dir("")
        .map_err(|e| format!("Failed to list shares on {}: {}", host, e))?;

    let shares: Vec<SmbShare> = entries
        .into_iter()
        .filter(|e| matches!(e.get_type(), SmbDirentType::FileShare))
        .map(|e| SmbShare {
            name: e.name().to_string(),
            share_type: "Disk".to_string(),
        })
        .collect();

    Ok(shares)
}

/// Browse un dossier dans un share SMB
/// Tient le CONNECTION lock pour toute l'opération (évite la race condition)
pub fn browse(host: &str, share: &str, path: &str) -> Result<Vec<SmbEntry>, String> {
    // Récupérer les credentials stockées (lock séparé — pas de deadlock)
    let stored = {
        let creds = LAST_CREDENTIALS.lock().map_err(|e| format!("Lock error: {}", e))?;
        creds.clone().ok_or_else(|| format!("No credentials stored for {}", host))?
    };

    // Acquérir le lock CONNECTION UNIQUE pour toute l'opération
    // ensure_connection_with_guard opère sur le guard directement → pas de double-lock
    let mut conn = CONNECTION.lock().map_err(|e| format!("Lock error: {}", e))?;

    ensure_connection_with_guard(
        &mut *conn,
        host, share,
        &stored.username, &stored.password,
        stored.workgroup.as_deref(), stored.is_guest,
    )?;

    let active = conn.as_ref()
        .ok_or_else(|| format!("No active connection to {}", host))?;

    // Avec une connexion share-level, le chemin est relatif à la racine du share
    let browse_path = if path.is_empty() || path == "/" {
        "/".to_string()
    } else {
        path.to_string()
    };

    let entries = active.client.list_dir(&browse_path)
        .map_err(|e| format!("Failed to browse {}/{}{}: {}", host, share, browse_path, e))?;

    let result: Vec<SmbEntry> = entries
        .into_iter()
        .filter(|e| {
            let name = e.name();
            name != "." && name != ".."
                && !name.starts_with("@")  // @eaDir, @tmp, etc.
                && !name.starts_with("#")  // #recycle, #snapshot, etc.
                && name != "$RECYCLE.BIN"
        })
        .map(|e| {
            let is_dir = matches!(e.get_type(), SmbDirentType::Dir);
            SmbEntry {
                name: e.name().to_string(),
                is_dir,
                size: 0,
                modified: 0,
            }
        })
        .collect();

    Ok(result)
}

/// Lit un fichier depuis un share SMB et retourne son contenu
/// Tient le CONNECTION lock pour toute l'opération (évite la race condition SIGSEGV)
pub fn read_file(host: &str, share: &str, path: &str) -> Result<Vec<u8>, String> {
    // ── [TIMING SMB-0] Entrée read_file ───────────────────────────────────
    let t_smb = std::time::Instant::now();
    println!("[SMB TIMING] SMB+0ms   — read_file start: {}/{}{}", host, share, path);

    let stored = {
        let creds = LAST_CREDENTIALS.lock().map_err(|e| format!("Lock error: {}", e))?;
        creds.clone().ok_or_else(|| format!("No credentials stored for {}", host))?
    };
    // ── [TIMING SMB-1] Credentials lus ────────────────────────────────────
    println!("[SMB TIMING] SMB+{}ms — credentials read from cache",
        t_smb.elapsed().as_millis());

    // Acquérir le lock CONNECTION UNIQUE — pas de double-lock
    let mut conn = CONNECTION.lock().map_err(|e| format!("Lock error: {}", e))?;
    // ── [TIMING SMB-2] Lock CONNECTION acquis ─────────────────────────────
    println!("[SMB TIMING] SMB+{}ms — CONNECTION lock acquired",
        t_smb.elapsed().as_millis());

    // Détecte si la connexion est réutilisée ou nouvelle
    let conn_reused = conn.as_ref().map(|c| c.host == host && c.share == share).unwrap_or(false);
    println!("[SMB TIMING] SMB+{}ms — ensure_connection START (reuse={})",
        t_smb.elapsed().as_millis(), conn_reused);

    ensure_connection_with_guard(
        &mut *conn,
        host, share,
        &stored.username, &stored.password,
        stored.workgroup.as_deref(), stored.is_guest,
    )?;
    // ── [TIMING SMB-3] Connexion SMB établie/réutilisée ───────────────────
    println!("[SMB TIMING] SMB+{}ms — ensure_connection DONE ({})",
        t_smb.elapsed().as_millis(),
        if conn_reused { "REUSED" } else { "NEW HANDSHAKE" });

    let active = conn.as_ref()
        .ok_or_else(|| format!("No active connection to {}", host))?;

    let clean_path = path.trim_start_matches('/');
    let file_path = format!("/{}", clean_path);

    // ── [TIMING SMB-4] Ouverture du fichier distant ────────────────────────
    let t_open = std::time::Instant::now();
    let mut file = active.client.open_with(
        &file_path,
        SmbOpenOptions::default().read(true),
    ).map_err(|e| format!("Failed to open SMB file {}: {}", file_path, e))?;
    println!("[SMB TIMING] SMB+{}ms — open_with DONE: {}ms",
        t_smb.elapsed().as_millis(), t_open.elapsed().as_millis());

    // ── [TIMING SMB-5] Début transfert (read_to_end) ───────────────────────
    let t_read = std::time::Instant::now();
    println!("[SMB TIMING] SMB+{}ms — read_to_end START",
        t_smb.elapsed().as_millis());

    let mut data = Vec::new();
    file.read_to_end(&mut data)
        .map_err(|e| format!("Failed to read SMB file {}: {}", file_path, e))?;

    // ── [TIMING SMB-6] Transfert terminé ──────────────────────────────────
    let bytes = data.len();
    let read_ms = t_read.elapsed().as_millis();
    let speed_kbps = if read_ms > 0 { bytes as u128 / read_ms } else { 0 };
    println!("[SMB TIMING] SMB+{}ms — read_to_end DONE: {} bytes in {}ms (~{} KB/s)",
        t_smb.elapsed().as_millis(), bytes, read_ms, speed_kbps);

    Ok(data)
}

/// Lit les premiers N bytes d'un fichier SMB (pour extraction metadata)
/// Tient le CONNECTION lock pour toute l'opération (évite la race condition SIGSEGV)
pub fn read_file_head(host: &str, share: &str, path: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    let stored = {
        let creds = LAST_CREDENTIALS.lock().map_err(|e| format!("Lock error: {}", e))?;
        creds.clone().ok_or_else(|| format!("No credentials stored for {}", host))?
    };

    // Acquérir le lock CONNECTION UNIQUE — pas de double-lock
    let mut conn = CONNECTION.lock().map_err(|e| format!("Lock error: {}", e))?;

    ensure_connection_with_guard(
        &mut *conn,
        host, share,
        &stored.username, &stored.password,
        stored.workgroup.as_deref(), stored.is_guest,
    )?;

    let active = conn.as_ref()
        .ok_or_else(|| format!("No active connection to {}", host))?;

    let clean_path = path.trim_start_matches('/');
    let file_path = format!("/{}", clean_path);

    let mut file = active.client.open_with(
        &file_path,
        SmbOpenOptions::default().read(true),
    ).map_err(|e| format!("Failed to open SMB file {}: {}", file_path, e))?;

    let mut data = vec![0u8; max_bytes];
    let bytes_read = file.read(&mut data)
        .map_err(|e| format!("Failed to read SMB file {}: {}", file_path, e))?;
    data.truncate(bytes_read);

    Ok(data)
}

/// Lit un fichier SMB et écrit son contenu progressivement dans un fichier temporaire local.
/// Écrit en chunks de 64KB et met à jour `bytes_written` après chaque chunk.
/// Tient le CONNECTION lock pour toute l'opération (même modèle que read_file).
/// Conçu pour être appelé depuis un thread OS dédié (pas depuis un async executor).
///
/// `cancel` : mis à `true` par un nouveau download pour interrompre celui-ci au chunk suivant.
/// Cela libère le CONNECTION mutex en ~2ms pour que le nouveau download puisse démarrer.
pub fn read_file_to_temp_progressive(
    host: &str,
    share: &str,
    path: &str,
    temp_path: &std::path::Path,
    bytes_written: &std::sync::Arc<std::sync::atomic::AtomicU64>,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    use std::io::Write;
    use std::sync::atomic::Ordering;

    let stored = {
        let creds = LAST_CREDENTIALS.lock().map_err(|e| format!("Lock error: {}", e))?;
        creds.clone().ok_or_else(|| format!("No credentials stored for {}", host))?
    };

    // Acquérir le lock CONNECTION UNIQUE — même pattern que read_file
    let mut conn = CONNECTION.lock().map_err(|e| format!("Lock error: {}", e))?;

    ensure_connection_with_guard(
        &mut *conn,
        host, share,
        &stored.username, &stored.password,
        stored.workgroup.as_deref(), stored.is_guest,
    )?;

    let active = conn.as_ref()
        .ok_or_else(|| format!("No active connection to {}", host))?;

    let clean_path = path.trim_start_matches('/');
    let file_path = format!("/{}", clean_path);

    let mut smb_file = active.client.open_with(
        &file_path,
        SmbOpenOptions::default().read(true),
    ).map_err(|e| format!("Failed to open SMB file {}: {}", file_path, e))?;

    // Créer ou tronquer le fichier temporaire local
    let mut tmp = std::fs::File::create(temp_path)
        .map_err(|e| format!("Failed to create temp file {:?}: {}", temp_path, e))?;

    // Lire en chunks de 64KB — vérifier le flag d'annulation avant chaque chunk.
    // Si cancel=true : sortir du loop → CONNECTION mutex relâché → nouveau download peut démarrer.
    let mut buf = vec![0u8; 65536];
    let mut total = 0u64;
    loop {
        if cancel.load(Ordering::Acquire) {
            println!("[SMB Progressive] Download annulé après {} bytes: {:?}", total, temp_path);
            break;
        }
        let n = smb_file.read(&mut buf)
            .map_err(|e| format!("SMB read error: {}", e))?;
        if n == 0 { break; }

        tmp.write_all(&buf[..n])
            .map_err(|e| format!("Temp file write error: {}", e))?;

        total += n as u64;
        bytes_written.store(total, Ordering::Release);
    }

    println!("[SMB Progressive] Download terminé: {} bytes → {:?}", total, temp_path);
    Ok(())
}

/// Télécharge un fichier SMB vers un fichier temporaire en utilisant un SmbClient DÉDIÉ.
/// Contrairement à `read_file_to_temp_progressive`, cette fonction ne touche PAS au
/// CONNECTION mutex partagé → plusieurs downloads peuvent tourner en parallèle sans blocage.
/// Conçu pour être appelé depuis un thread OS dédié.
///
/// `bytes_written` est mis à jour après chaque chunk de 64KB.
/// Le caller est responsable de mettre `download_done = true` en cas de succès OU d'erreur.
pub fn download_fresh(
    host: &str,
    share: &str,
    path: &str,
    username: &str,
    password: &str,
    workgroup: Option<&str>,
    is_guest: bool,
    temp_path: &std::path::Path,
    bytes_written: &std::sync::Arc<std::sync::atomic::AtomicU64>,
) -> Result<(), String> {
    use std::io::Write;
    use std::sync::atomic::Ordering;

    let smb_server = smb_url(host);

    // Share path (même logique que ensure_connection_with_guard)
    let share_path = if share.is_empty() {
        String::new()
    } else if share.starts_with('/') {
        share.to_string()
    } else {
        format!("/{}", share)
    };

    // Credentials pour ce client dédié
    let mut creds = SmbCredentials::default()
        .server(&smb_server)
        .share(&share_path);

    if !is_guest {
        creds = creds.username(username).password(password);
        if let Some(wg) = workgroup {
            creds = creds.workgroup(wg);
        }
    }

    // Client FRAIS — totalement indépendant de CONNECTION, pas de verrou partagé
    let client = SmbClient::new(creds, SmbOptions::default().one_share_per_server(true))
        .map_err(|e| format!("Fresh SMB client failed to {}/{}: {}", host, share, e))?;

    let clean_path = path.trim_start_matches('/');
    let file_path = format!("/{}", clean_path);

    let mut smb_file = client.open_with(&file_path, SmbOpenOptions::default().read(true))
        .map_err(|e| format!("Failed to open SMB file {}: {}", file_path, e))?;

    // Créer ou tronquer le fichier temporaire local
    let mut tmp = std::fs::File::create(temp_path)
        .map_err(|e| format!("Failed to create temp file {:?}: {}", temp_path, e))?;

    // Lire en chunks de 64KB et écrire progressivement
    let mut buf = vec![0u8; 65536];
    let mut total = 0u64;
    loop {
        let n = smb_file.read(&mut buf)
            .map_err(|e| format!("SMB read error: {}", e))?;
        if n == 0 { break; }
        tmp.write_all(&buf[..n])
            .map_err(|e| format!("Temp file write error: {}", e))?;
        total += n as u64;
        bytes_written.store(total, Ordering::Release);
    }

    println!("[SMB Fresh] Download complete: {} bytes → {:?}", total, temp_path);
    Ok(())
}

/// Ferme la connexion active
pub fn disconnect(_host: &str) {
    let mut conn = CONNECTION.lock().unwrap_or_else(|e| e.into_inner());
    *conn = None;
}

/// Vérifie si une connexion est active
pub fn is_connected(host: &str) -> bool {
    let conn = CONNECTION.lock().unwrap_or_else(|e| e.into_inner());
    conn.as_ref().map_or(false, |c| c.host == host)
}

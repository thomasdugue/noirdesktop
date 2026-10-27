---
name: hean-smb
description: Sous-système NAS/SMB de Hean — pavao/libsmbclient singleton, URI smb://, téléchargement progressif, SmbProgressiveFile, gapless SMB, Keychain/password cache, discovery mDNS, scan différentiel. Charger avant de toucher src-tauri/src/network/, audio_play/audio_preload_next côté SMB, ou network.js.
---

# hean-smb — NAS, SMB & streaming réseau

## Network/NAS subsystem (`src-tauri/src/network/`)

```
network/
├── mod.rs          — NetworkSource, SmbCredentials types; load/save network_sources.json
├── smb.rs          — SMB client (pavao wrapper); CONNECTION mutex; browse/read_file/read_file_head
├── scanner.rs      — Differential scan; start_progressive_download; extract_smb_metadata_and_cover
├── credentials.rs  — macOS Keychain + PASSWORD_CACHE (session-level in-memory cache)
└── discovery.rs    — mDNS/Bonjour discovery (_smb._tcp.local., 5s timeout)
```

**SMB URI format:** `smb://{source_id}/{share}/{remote_path}`
- `source_id` = UUID of `NetworkSource` — used to look up host + credentials
- `remote_path` starts with `/`

**Progressive download (`scanner.rs` + `audio_decoder.rs`):**
- `start_progressive_download(source, share, remote_path, cancel_previous: bool)` — spawns OS thread that downloads in 64KB chunks, writes to `smb_buffer/{hash}.tmp`, updates `PROGRESSIVE_DOWNLOADS` registry
- `cancel_previous = true` for `audio_play` (cancel old download), `false` for `audio_preload_next` (don't interrupt current track)
- `audio_play` waits for 4MB threshold (≈111ms at 36 MB/s) before starting the engine, with 15s timeout
- `SmbProgressiveFile` (in `audio_decoder.rs`) implements `Read + Seek + MediaSource` with blocking wait loops
- **`byte_len()` must return `Some(bytes_written)` at all times** — returning `None` makes Symphonia treat the stream as non-seekable

**`add_network_source` returns a `NetworkSource` object** (not a string ID). Callers must use `result.id` to get the UUID for subsequent commands like `scan_network_source_cmd`. See `network.js` line 876 for the canonical pattern: `invoke('scan_network_source_cmd', { sourceId: result.id })`.

**Critical SMB constraint:** `libsmbclient` (via pavao) is a **process-level singleton**. Two concurrent `SmbClient` instances cause EINVAL (os error 22). All SMB operations share a single `CONNECTION: Lazy<Mutex<Option<ActiveConnection>>>` — concurrent access is serialized through this lock.

**Gapless with SMB:** `audio_preload_next` is `async` and SMB-aware — it parses `smb://`, calls `start_progressive_download(cancel_previous=false)`, waits 4MB, then calls `engine.preload_next(temp_path)`. Triggered at 60s remaining (vs. 10s for local files) to cover NAS latency.

**Gapless transition + seek:** `CallbackData` in `coreaudio_stream.rs` carries `current_path: Arc<Mutex<Option<String>>>` + `next_path: Arc<Mutex<Option<String>>>`. During gapless transition: `*data.current_path.lock() = data.next_path.lock().take()`. Without this, seek-restart after gapless opens the wrong file.

**Password cache:** `credentials.rs` keeps `PASSWORD_CACHE: Lazy<Mutex<HashMap<String,String>>>` — Keychain accessed at most once per source per session. `get_cover_smb()` checks this cache and skips the SMB connection if no session password is present (avoids Keychain dialogs at startup).

## DAP Sync — feature archivée

La feature DAP Sync (synchronisation vers Digital Audio Player via Mass Storage / MTP / SMB) a été retirée du build actif le 2026-04-22 à cause de bugs d'instabilité non résolus. Le code est conservé sur la branche `archive/dap-sync-v1` et le tag `dap-sync-archive-2026-04`. Voir [`docs/archive/dap-sync/`](../docs/archive/dap-sync/) pour le rapport complet (architecture, décisions, bugs connus, procédure de réintégration).

**Reste encore actif** : `network/smb_utils.rs` (résolution `smb://` → chemin local), utilisé par le streaming audio SMB.

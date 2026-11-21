// wifi_sync/db.rs — SQLite tracking of synced files per device
//
// Lives in the same `dap_sync.db` SQLite file as the DAP sync subsystem
// (we just open a second connection — SQLite handles concurrency fine for
// the access patterns we have here: a few writes per album, occasional reads).
//
// The table is keyed by (device_uuid, dest_relative_path) so that multiple
// DAPs syncing from the same desktop don't collide and so the path used as
// the key is the *post-sanitization* destination path — stable across
// SMB sessions where source paths can change UUIDs between mounts.

use once_cell::sync::Lazy;
use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

static DB: Lazy<Mutex<Connection>> = Lazy::new(|| {
    let path = db_path();
    let conn = Connection::open(&path).expect("Failed to open wifi_sync database");
    init_tables(&conn);
    Mutex::new(conn)
});

fn db_path() -> PathBuf {
    let dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.noir.app");
    std::fs::create_dir_all(&dir).ok();
    dir.join("dap_sync.db")
}

fn init_tables(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS wifi_sync_synced (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_uuid TEXT NOT NULL,
            dest_relative_path TEXT NOT NULL,
            quick_hash TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            synced_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(device_uuid, dest_relative_path)
        );

        CREATE INDEX IF NOT EXISTS idx_wifi_sync_device
            ON wifi_sync_synced(device_uuid);",
    )
    .expect("Failed to initialize wifi_sync tables");
}

/// Force the database connection (and table) to exist. Called once at app
/// startup so the migration runs even if no client has touched the table yet.
pub fn ensure_initialized() {
    drop(DB.lock());
}

/// One row representing a file we already streamed to a given device.
#[derive(Clone, Debug)]
pub struct SyncedEntry {
    pub dest_relative_path: String,
    pub quick_hash: String,
    pub size_bytes: i64,
}

/// Return the set of `dest_relative_path`s already synced to `device_uuid`.
/// Used by `/status` to mark albums as `alreadySynced` when *all* their
/// files are present in this set.
pub fn get_synced_paths(device_uuid: &str) -> Result<HashSet<String>, String> {
    let conn = DB.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT dest_relative_path FROM wifi_sync_synced WHERE device_uuid = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![device_uuid], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = HashSet::new();
    for r in rows {
        if let Ok(p) = r {
            out.insert(p);
        }
    }
    Ok(out)
}

/// Mark a batch of files as synced for a given device. Idempotent — uses
/// `INSERT OR REPLACE` so re-syncs just refresh the hash and timestamp.
pub fn mark_synced(device_uuid: &str, files: &[SyncedEntry]) -> Result<(), String> {
    let mut conn = DB.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO wifi_sync_synced
                    (device_uuid, dest_relative_path, quick_hash, size_bytes, synced_at)
                 VALUES (?1, ?2, ?3, ?4, datetime('now'))
                 ON CONFLICT(device_uuid, dest_relative_path) DO UPDATE SET
                    quick_hash = excluded.quick_hash,
                    size_bytes = excluded.size_bytes,
                    synced_at  = excluded.synced_at",
            )
            .map_err(|e| e.to_string())?;
        for f in files {
            stmt.execute(params![
                device_uuid,
                f.dest_relative_path,
                f.quick_hash,
                f.size_bytes
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Wipe all sync state for a single device. Used by the "Reset sync state"
/// admin button — the next /status will report every album as un-synced.
pub fn clear_device(device_uuid: &str) -> Result<usize, String> {
    let conn = DB.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "DELETE FROM wifi_sync_synced WHERE device_uuid = ?1",
            params![device_uuid],
        )
        .map_err(|e| e.to_string())?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    // We can't easily isolate the global DB in tests, so we use a unique
    // device_uuid per test to avoid collisions when running in parallel.
    fn unique_uuid(suffix: &str) -> String {
        format!(
            "test-{}-{}",
            suffix,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    #[test]
    fn test_mark_and_query_synced() {
        let uuid = unique_uuid("mark");
        let files = vec![
            SyncedEntry {
                dest_relative_path: "Artist/Album/01 - Track.flac".to_string(),
                quick_hash: "abc123".to_string(),
                size_bytes: 12345,
            },
            SyncedEntry {
                dest_relative_path: "Artist/Album/02 - Track.flac".to_string(),
                quick_hash: "def456".to_string(),
                size_bytes: 67890,
            },
        ];
        mark_synced(&uuid, &files).unwrap();

        let set = get_synced_paths(&uuid).unwrap();
        assert!(set.contains("Artist/Album/01 - Track.flac"));
        assert!(set.contains("Artist/Album/02 - Track.flac"));
        assert_eq!(set.len(), 2);
    }

    #[test]
    fn test_mark_synced_idempotent() {
        let uuid = unique_uuid("idem");
        let f = vec![SyncedEntry {
            dest_relative_path: "A/B/c.flac".to_string(),
            quick_hash: "h1".to_string(),
            size_bytes: 1,
        }];
        mark_synced(&uuid, &f).unwrap();
        mark_synced(&uuid, &f).unwrap(); // should not error
        let set = get_synced_paths(&uuid).unwrap();
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn test_clear_device() {
        let uuid = unique_uuid("clear");
        let f = vec![SyncedEntry {
            dest_relative_path: "X/Y/z.flac".to_string(),
            quick_hash: "h".to_string(),
            size_bytes: 10,
        }];
        mark_synced(&uuid, &f).unwrap();
        let n = clear_device(&uuid).unwrap();
        assert_eq!(n, 1);
        let set = get_synced_paths(&uuid).unwrap();
        assert!(set.is_empty());
    }
}

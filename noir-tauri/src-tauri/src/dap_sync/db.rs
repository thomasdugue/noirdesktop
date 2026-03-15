use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use once_cell::sync::Lazy;

static DB: Lazy<Mutex<Connection>> = Lazy::new(|| {
    let path = db_path();
    let conn = Connection::open(&path).expect("Failed to open DAP sync database");
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
        "CREATE TABLE IF NOT EXISTS dap_destinations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            volume_name TEXT,
            folder_structure TEXT NOT NULL DEFAULT 'artist_album_track',
            mirror_mode INTEGER NOT NULL DEFAULT 1,
            show_in_sidebar INTEGER NOT NULL DEFAULT 1,
            last_sync_at TEXT,
            last_sync_albums_count INTEGER DEFAULT 0,
            last_sync_size_bytes INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS dap_sync_selection (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            destination_id INTEGER NOT NULL REFERENCES dap_destinations(id) ON DELETE CASCADE,
            album_id INTEGER NOT NULL,
            selected INTEGER NOT NULL DEFAULT 1,
            UNIQUE(destination_id, album_id)
        );

        CREATE INDEX IF NOT EXISTS idx_dap_selection_dest ON dap_sync_selection(destination_id);
        CREATE INDEX IF NOT EXISTS idx_dap_selection_album ON dap_sync_selection(album_id);",
    )
    .expect("Failed to initialize DAP sync tables");
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DapDestination {
    pub id: Option<i64>,
    pub name: String,
    pub path: String,
    pub volume_name: Option<String>,
    pub folder_structure: String,
    pub mirror_mode: bool,
    pub show_in_sidebar: bool,
    pub last_sync_at: Option<String>,
    pub last_sync_albums_count: Option<i64>,
    pub last_sync_size_bytes: Option<i64>,
}

pub fn save_destination(dest: &DapDestination) -> Result<i64, String> {
    let conn = DB.lock().map_err(|e| e.to_string())?;
    match dest.id {
        Some(id) if id > 0 => {
            conn.execute(
                "UPDATE dap_destinations SET name=?1, path=?2, volume_name=?3, folder_structure=?4, mirror_mode=?5, show_in_sidebar=?6 WHERE id=?7",
                params![dest.name, dest.path, dest.volume_name, dest.folder_structure, dest.mirror_mode as i32, dest.show_in_sidebar as i32, id],
            ).map_err(|e| e.to_string())?;
            Ok(id)
        }
        _ => {
            conn.execute(
                "INSERT INTO dap_destinations (name, path, volume_name, folder_structure, mirror_mode, show_in_sidebar) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![dest.name, dest.path, dest.volume_name, dest.folder_structure, dest.mirror_mode as i32, dest.show_in_sidebar as i32],
            ).map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

pub fn get_destinations() -> Result<Vec<DapDestination>, String> {
    let conn = DB.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, path, volume_name, folder_structure, mirror_mode, show_in_sidebar, last_sync_at, last_sync_albums_count, last_sync_size_bytes FROM dap_destinations ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DapDestination {
                id: Some(row.get(0)?),
                name: row.get(1)?,
                path: row.get(2)?,
                volume_name: row.get(3)?,
                folder_structure: row.get(4)?,
                mirror_mode: row.get::<_, i32>(5)? != 0,
                show_in_sidebar: row.get::<_, i32>(6)? != 0,
                last_sync_at: row.get(7)?,
                last_sync_albums_count: row.get(8)?,
                last_sync_size_bytes: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut dests = Vec::new();
    for row in rows {
        dests.push(row.map_err(|e| e.to_string())?);
    }
    Ok(dests)
}

pub fn get_destination(id: i64) -> Result<Option<DapDestination>, String> {
    let conn = DB.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, path, volume_name, folder_structure, mirror_mode, show_in_sidebar, last_sync_at, last_sync_albums_count, last_sync_size_bytes FROM dap_destinations WHERE id=?1")
        .map_err(|e| e.to_string())?;
    let result = stmt
        .query_row(params![id], |row| {
            Ok(DapDestination {
                id: Some(row.get(0)?),
                name: row.get(1)?,
                path: row.get(2)?,
                volume_name: row.get(3)?,
                folder_structure: row.get(4)?,
                mirror_mode: row.get::<_, i32>(5)? != 0,
                show_in_sidebar: row.get::<_, i32>(6)? != 0,
                last_sync_at: row.get(7)?,
                last_sync_albums_count: row.get(8)?,
                last_sync_size_bytes: row.get(9)?,
            })
        });
    match result {
        Ok(d) => Ok(Some(d)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn delete_destination(id: i64) -> Result<(), String> {
    let conn = DB.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM dap_destinations WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn save_selection(destination_id: i64, album_id: i64, selected: bool) -> Result<(), String> {
    let conn = DB.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO dap_sync_selection (destination_id, album_id, selected) VALUES (?1, ?2, ?3) ON CONFLICT(destination_id, album_id) DO UPDATE SET selected=?3",
        params![destination_id, album_id, selected as i32],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn save_selections_batch(destination_id: i64, selections: &[(i64, bool)]) -> Result<(), String> {
    let conn = DB.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("INSERT INTO dap_sync_selection (destination_id, album_id, selected) VALUES (?1, ?2, ?3) ON CONFLICT(destination_id, album_id) DO UPDATE SET selected=?3")
            .map_err(|e| e.to_string())?;
        for (album_id, selected) in selections {
            stmt.execute(params![destination_id, album_id, *selected as i32])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_selections(destination_id: i64) -> Result<Vec<(i64, bool)>, String> {
    let conn = DB.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT album_id, selected FROM dap_sync_selection WHERE destination_id=?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![destination_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i32>(1)? != 0))
        })
        .map_err(|e| e.to_string())?;
    let mut sels = Vec::new();
    for row in rows {
        sels.push(row.map_err(|e| e.to_string())?);
    }
    Ok(sels)
}

pub fn update_destination_sync_stats(id: i64, albums_count: i64, size_bytes: i64) -> Result<(), String> {
    let conn = DB.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE dap_destinations SET last_sync_at=datetime('now'), last_sync_albums_count=?1, last_sync_size_bytes=?2 WHERE id=?3",
        params![albums_count, size_bytes, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn);
        conn
    }

    #[test]
    fn test_init_tables() {
        let _conn = test_db();
    }

    #[test]
    fn test_save_and_get_destination() {
        // Uses the global DB but tests the logic
        let dest = DapDestination {
            id: None,
            name: "Test DAP".into(),
            path: "/tmp/test-dap-1234".into(),
            volume_name: Some("TEST_VOL".into()),
            folder_structure: "artist_album_track".into(),
            mirror_mode: true,
            show_in_sidebar: true,
            last_sync_at: None,
            last_sync_albums_count: None,
            last_sync_size_bytes: None,
        };
        let id = save_destination(&dest).unwrap();
        assert!(id > 0);

        let loaded = get_destination(id).unwrap().unwrap();
        assert_eq!(loaded.name, "Test DAP");
        assert_eq!(loaded.path, "/tmp/test-dap-1234");
        assert!(loaded.mirror_mode);

        // Cleanup
        delete_destination(id).unwrap();
    }

    #[test]
    fn test_selections() {
        let dest = DapDestination {
            id: None,
            name: "Sel Test".into(),
            path: "/tmp/test-sel-9876".into(),
            volume_name: None,
            folder_structure: "flat".into(),
            mirror_mode: false,
            show_in_sidebar: true,
            last_sync_at: None,
            last_sync_albums_count: None,
            last_sync_size_bytes: None,
        };
        let id = save_destination(&dest).unwrap();

        save_selection(id, 100, true).unwrap();
        save_selection(id, 200, true).unwrap();
        save_selection(id, 300, false).unwrap();

        let sels = get_selections(id).unwrap();
        assert_eq!(sels.len(), 3);

        // Toggle
        save_selection(id, 100, false).unwrap();
        let sels2 = get_selections(id).unwrap();
        let s100 = sels2.iter().find(|(a, _)| *a == 100).unwrap();
        assert!(!s100.1);

        delete_destination(id).unwrap();
    }
}

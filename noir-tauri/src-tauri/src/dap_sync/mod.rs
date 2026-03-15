// === DAP SYNC MODULE ===
// Synchronisation de la bibliothèque musicale vers un Digital Audio Player (carte SD / USB).
// Phase 1: db + volumes + watcher
// Phase 2: manifest + sync_plan
// Phase 3: sync_engine

pub mod db;
pub mod volumes;
pub mod watcher;
pub mod manifest;
pub mod smb_utils;
pub mod sync_plan;
pub mod sync_engine;

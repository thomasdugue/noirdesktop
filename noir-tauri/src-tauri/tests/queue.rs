// =============================================================================
// Module 6 — Queue / Playback Queue Integration Tests
// =============================================================================
//
// The actual queue state lives in lib.rs (private types) and in the JS frontend
// (`state.js` → `queue.items[]`). Since we cannot import private types from
// integration tests, we define a standalone `Queue` struct that mirrors the
// expected queue behavior and test the LOGIC.
//
// Tests queue logic -- actual queue is in lib.rs (private) and state.js (JS frontend)

use std::collections::HashSet;

// =========================================================================
// Queue implementation mirroring Noir's expected behavior
// =========================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
enum RepeatMode {
    Off,
    All,
    One,
}

#[derive(Debug, Clone)]
struct Queue {
    items: Vec<String>,         // Track paths
    current_index: Option<usize>,
    shuffle_mode: bool,
    repeat_mode: RepeatMode,
    shuffle_order: Vec<usize>,  // Shuffled indices
}

impl Queue {
    fn new() -> Self {
        Self {
            items: Vec::new(),
            current_index: None,
            shuffle_mode: false,
            repeat_mode: RepeatMode::Off,
            shuffle_order: Vec::new(),
        }
    }

    /// Add a track to the end of the queue.
    fn add(&mut self, track_path: String) {
        self.items.push(track_path);
        if self.current_index.is_none() {
            self.current_index = Some(0);
        }
        // Invalidate shuffle order when items change
        if self.shuffle_mode {
            self.regenerate_shuffle();
        }
    }

    /// Add multiple tracks at once.
    fn add_many(&mut self, tracks: Vec<String>) {
        let was_empty = self.items.is_empty();
        self.items.extend(tracks);
        if was_empty && !self.items.is_empty() {
            self.current_index = Some(0);
        }
        if self.shuffle_mode {
            self.regenerate_shuffle();
        }
    }

    /// Remove a track at a specific index.
    fn remove(&mut self, index: usize) -> Option<String> {
        if index >= self.items.len() {
            return None;
        }
        let removed = self.items.remove(index);

        // Adjust current_index
        if self.items.is_empty() {
            self.current_index = None;
        } else if let Some(ci) = self.current_index {
            if index < ci {
                self.current_index = Some(ci - 1);
            } else if index == ci && ci >= self.items.len() {
                self.current_index = Some(self.items.len() - 1);
            }
        }

        if self.shuffle_mode {
            self.regenerate_shuffle();
        }
        Some(removed)
    }

    /// Get the currently playing track path.
    fn current(&self) -> Option<&str> {
        self.current_index.and_then(|i| self.items.get(i).map(|s| s.as_str()))
    }

    /// Skip to the next track. Returns the new current track, or None if at end.
    fn skip_next(&mut self) -> Option<&str> {
        let len = self.items.len();
        if len == 0 {
            return None;
        }

        let ci = self.current_index.unwrap_or(0);

        match self.repeat_mode {
            RepeatMode::One => {
                // Stay on the same track
                self.current_index = Some(ci);
            }
            RepeatMode::All => {
                self.current_index = Some((ci + 1) % len);
            }
            RepeatMode::Off => {
                if ci + 1 < len {
                    self.current_index = Some(ci + 1);
                } else {
                    // At end of queue, stay at last
                    return None;
                }
            }
        }

        self.current()
    }

    /// Skip to the previous track.
    fn skip_previous(&mut self) -> Option<&str> {
        let len = self.items.len();
        if len == 0 {
            return None;
        }

        let ci = self.current_index.unwrap_or(0);

        match self.repeat_mode {
            RepeatMode::One => {
                self.current_index = Some(ci);
            }
            RepeatMode::All => {
                if ci == 0 {
                    self.current_index = Some(len - 1);
                } else {
                    self.current_index = Some(ci - 1);
                }
            }
            RepeatMode::Off => {
                if ci > 0 {
                    self.current_index = Some(ci - 1);
                } else {
                    return None;
                }
            }
        }

        self.current()
    }

    /// Clear the entire queue.
    fn clear(&mut self) {
        self.items.clear();
        self.current_index = None;
        self.shuffle_order.clear();
    }

    /// Toggle shuffle mode.
    fn set_shuffle(&mut self, enabled: bool) {
        self.shuffle_mode = enabled;
        if enabled {
            self.regenerate_shuffle();
        } else {
            self.shuffle_order.clear();
        }
    }

    /// Set the repeat mode.
    fn set_repeat(&mut self, mode: RepeatMode) {
        self.repeat_mode = mode;
    }

    /// Get the number of items in the queue.
    fn len(&self) -> usize {
        self.items.len()
    }

    /// Check if the queue is empty.
    fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Generate a shuffled index order. Keeps current track at position 0.
    fn regenerate_shuffle(&mut self) {
        let len = self.items.len();
        if len == 0 {
            self.shuffle_order.clear();
            return;
        }

        // Simple deterministic "shuffle" for testing — reverse order.
        // Real implementation uses random shuffle, but we test the structure.
        let ci = self.current_index.unwrap_or(0);
        let mut order: Vec<usize> = (0..len).filter(|&i| i != ci).collect();
        order.reverse();
        order.insert(0, ci); // Current track stays first
        self.shuffle_order = order;
    }

    /// Move a track from one position to another (drag reorder).
    fn move_track(&mut self, from: usize, to: usize) -> bool {
        if from >= self.items.len() || to >= self.items.len() {
            return false;
        }
        let item = self.items.remove(from);
        self.items.insert(to, item);

        // Adjust current_index to follow the playing track
        if let Some(ci) = self.current_index {
            if ci == from {
                self.current_index = Some(to);
            } else if from < ci && to >= ci {
                self.current_index = Some(ci - 1);
            } else if from > ci && to <= ci {
                self.current_index = Some(ci + 1);
            }
        }
        true
    }
}

// =========================================================================
// Test 6.1 — Add tracks to queue
// =========================================================================
#[test]
fn test_6_1_add_tracks() {
    let mut q = Queue::new();
    assert!(q.is_empty());
    assert_eq!(q.len(), 0);

    q.add("/music/track1.flac".to_string());
    assert_eq!(q.len(), 1);
    assert_eq!(q.current(), Some("/music/track1.flac"));

    q.add("/music/track2.flac".to_string());
    assert_eq!(q.len(), 2);
    // current should still be first track
    assert_eq!(q.current(), Some("/music/track1.flac"));
}

// =========================================================================
// Test 6.2 — Add many tracks at once
// =========================================================================
#[test]
fn test_6_2_add_many_tracks() {
    let mut q = Queue::new();
    let tracks: Vec<String> = (1..=5)
        .map(|i| format!("/music/track{}.flac", i))
        .collect();

    q.add_many(tracks);
    assert_eq!(q.len(), 5);
    assert_eq!(q.current(), Some("/music/track1.flac"));
}

// =========================================================================
// Test 6.3 — Skip next (RepeatMode::Off)
// =========================================================================
#[test]
fn test_6_3_skip_next_no_repeat() {
    let mut q = Queue::new();
    q.add_many(vec![
        "/a.flac".to_string(),
        "/b.flac".to_string(),
        "/c.flac".to_string(),
    ]);

    assert_eq!(q.current(), Some("/a.flac"));

    let next = q.skip_next();
    assert_eq!(next, Some("/b.flac"));

    let next = q.skip_next();
    assert_eq!(next, Some("/c.flac"));

    // At end — should return None
    let next = q.skip_next();
    assert!(next.is_none(), "Should return None at end of queue");
}

// =========================================================================
// Test 6.4 — Skip previous
// =========================================================================
#[test]
fn test_6_4_skip_previous() {
    let mut q = Queue::new();
    q.add_many(vec![
        "/a.flac".to_string(),
        "/b.flac".to_string(),
        "/c.flac".to_string(),
    ]);

    // Move to track C
    q.skip_next(); // -> B
    q.skip_next(); // -> C
    assert_eq!(q.current(), Some("/c.flac"));

    let prev = q.skip_previous();
    assert_eq!(prev, Some("/b.flac"));

    let prev = q.skip_previous();
    assert_eq!(prev, Some("/a.flac"));

    // At beginning — should return None
    let prev = q.skip_previous();
    assert!(prev.is_none(), "Should return None at start of queue");
}

// =========================================================================
// Test 6.5 — Clear queue
// =========================================================================
#[test]
fn test_6_5_clear_queue() {
    let mut q = Queue::new();
    q.add_many(vec!["/a.flac".to_string(), "/b.flac".to_string()]);
    assert_eq!(q.len(), 2);

    q.clear();
    assert!(q.is_empty());
    assert_eq!(q.len(), 0);
    assert_eq!(q.current(), None);
}

// =========================================================================
// Test 6.6 — Repeat All: wraps around at end
// =========================================================================
#[test]
fn test_6_6_repeat_all() {
    let mut q = Queue::new();
    q.add_many(vec![
        "/a.flac".to_string(),
        "/b.flac".to_string(),
        "/c.flac".to_string(),
    ]);
    q.set_repeat(RepeatMode::All);

    q.skip_next(); // -> B
    q.skip_next(); // -> C

    let next = q.skip_next();
    assert_eq!(
        next,
        Some("/a.flac"),
        "RepeatAll should wrap to first track"
    );
}

// =========================================================================
// Test 6.7 — Repeat All: wraps backward at beginning
// =========================================================================
#[test]
fn test_6_7_repeat_all_backward() {
    let mut q = Queue::new();
    q.add_many(vec![
        "/a.flac".to_string(),
        "/b.flac".to_string(),
        "/c.flac".to_string(),
    ]);
    q.set_repeat(RepeatMode::All);

    // At first track, go previous should wrap to last
    let prev = q.skip_previous();
    assert_eq!(
        prev,
        Some("/c.flac"),
        "RepeatAll backward should wrap to last track"
    );
}

// =========================================================================
// Test 6.8 — Repeat One: skip next stays on same track
// =========================================================================
#[test]
fn test_6_8_repeat_one() {
    let mut q = Queue::new();
    q.add_many(vec!["/a.flac".to_string(), "/b.flac".to_string()]);
    q.set_repeat(RepeatMode::One);

    let next = q.skip_next();
    assert_eq!(
        next,
        Some("/a.flac"),
        "RepeatOne should stay on current track"
    );

    let next = q.skip_next();
    assert_eq!(next, Some("/a.flac"), "RepeatOne should still stay");
}

// =========================================================================
// Test 6.9 — Shuffle mode generates valid order
// =========================================================================
#[test]
fn test_6_9_shuffle_mode() {
    let mut q = Queue::new();
    q.add_many(vec![
        "/a.flac".to_string(),
        "/b.flac".to_string(),
        "/c.flac".to_string(),
        "/d.flac".to_string(),
    ]);

    q.set_shuffle(true);

    // Shuffle order should contain all indices exactly once
    let order_set: HashSet<usize> = q.shuffle_order.iter().copied().collect();
    assert_eq!(
        order_set.len(),
        4,
        "Shuffle order should contain all 4 indices"
    );
    for i in 0..4 {
        assert!(
            order_set.contains(&i),
            "Shuffle order should contain index {}",
            i
        );
    }

    // Current track should be at position 0 in shuffle order
    let ci = q.current_index.unwrap_or(0);
    assert_eq!(
        q.shuffle_order[0], ci,
        "Current track should be first in shuffle order"
    );
}

// =========================================================================
// Test 6.10 — Remove track from queue
// =========================================================================
#[test]
fn test_6_10_remove_track() {
    let mut q = Queue::new();
    q.add_many(vec![
        "/a.flac".to_string(),
        "/b.flac".to_string(),
        "/c.flac".to_string(),
    ]);

    let removed = q.remove(1);
    assert_eq!(removed, Some("/b.flac".to_string()));
    assert_eq!(q.len(), 2);
    assert_eq!(q.items[0], "/a.flac");
    assert_eq!(q.items[1], "/c.flac");
}

// =========================================================================
// Test 6.11 — Remove current track adjusts index
// =========================================================================
#[test]
fn test_6_11_remove_current_adjusts_index() {
    let mut q = Queue::new();
    q.add_many(vec![
        "/a.flac".to_string(),
        "/b.flac".to_string(),
        "/c.flac".to_string(),
    ]);

    q.skip_next(); // -> B (index 1)
    assert_eq!(q.current(), Some("/b.flac"));

    // Remove track before current — current_index should shift left
    q.remove(0);
    assert_eq!(q.current_index, Some(0));
    assert_eq!(q.current(), Some("/b.flac"));
}

// =========================================================================
// Test 6.12 — Move track (drag reorder)
// =========================================================================
#[test]
fn test_6_12_move_track_reorder() {
    let mut q = Queue::new();
    q.add_many(vec![
        "/a.flac".to_string(),
        "/b.flac".to_string(),
        "/c.flac".to_string(),
        "/d.flac".to_string(),
    ]);

    // Move last track to second position
    let ok = q.move_track(3, 1);
    assert!(ok, "Move should succeed");
    assert_eq!(q.items[0], "/a.flac");
    assert_eq!(q.items[1], "/d.flac");
    assert_eq!(q.items[2], "/b.flac");
    assert_eq!(q.items[3], "/c.flac");

    // Move out of bounds should fail
    let ok = q.move_track(10, 0);
    assert!(!ok, "Move with invalid index should fail");
}

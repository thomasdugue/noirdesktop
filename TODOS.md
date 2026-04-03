# TODOS

## MTP Sync — Architecture Refactor (deferred)

### Frontend-driven split sync
**What:** Replace wave-break-inside-sync architecture with frontend-driven N×250-file syncs. Frontend runs sync(0..200), shows replug modal, runs sync(200..400), etc.
**Why:** Eliminates ~200 lines of Rust-side replug detection, 5-min MTP_LOCK hold, emergency replug path. Manifest already supports incremental resume.
**Pros:** Simpler architecture, shorter lock holds, easier to test.
**Cons:** Requires frontend batching logic, multiple MTP connection open/close cycles.
**Context:** Identified by outside voice during eng review (2026-04-03). Current wave-break-inside-sync works but is complex. This refactor would remove the 2-phase replug detection, emergency replug handler, and the no-app-handle fallback from mtp.rs.
**Depends on:** Validate current wave break approach with real hardware first.

### DRY: Extract replug detection helpers
**What:** Extract `wait_for_device_unplug()` and `wait_for_device_replug()` from mtp_sync_batch.
**Why:** Same polling logic duplicated in wave break handler and emergency replug handler (~80 lines).
**Pros:** DRY, easier maintenance.
**Cons:** Minor refactor inside a 500+ line function.
**Context:** Accepted during eng review (2026-04-03), implementation deferred to after hardware validation.
**Depends on:** Nothing. Can be done anytime.

### MTP firmware operation counter accuracy
**What:** Track total MTP operations (including session open/close, failed uploads, deletes) instead of just successful copies for wave break triggering.
**Why:** The `copied` counter undercounts firmware operations. Session cycling adds ~2 MTP ops per cycle (25 cycles per wave = 50 extra ops). Failed uploads still stress the firmware. Safety margin is thinner than WAVE_SIZE suggests.
**Pros:** More accurate safety margin.
**Cons:** Requires understanding exactly which MTP operations count toward firmware fatigue.
**Context:** Outside voice finding (2026-04-03). Mitigated by reducing WAVE_SIZE from 250 to 200.
**Depends on:** Real-world testing to validate whether session open/close operations actually contribute to firmware fatigue.

### Inline retry timing consistency
**What:** Increase inline retry delay from 500ms to match INTER_FILE_DELAY_MS (1500ms).
**Why:** If firmware needs breathing room between writes (which the entire design assumes), the inline retry is 3x more aggressive than normal uploads.
**Pros:** Consistent firmware stress management.
**Cons:** Slightly slower error recovery.
**Context:** Outside voice finding (2026-04-03).
**Depends on:** Nothing.

### ptpcamerad suppressor during replug detection
**What:** Investigate whether killing ptpcamerad during Phase 2 (wait for replug) interferes with macOS MTP device initialization.
**Why:** ptpcamerad is what macOS uses to initialize MTP devices. Killing it during firmware init after replug could delay or prevent device enumeration.
**Pros:** Potentially faster/more reliable replug detection.
**Cons:** May need ptpcamerad alive briefly during init, then killed before opening our own session.
**Context:** Outside voice finding (2026-04-03). The 5s firmware init wait may already cover this.
**Depends on:** Real-world testing.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Hean** — a macOS audiophile desktop music player built with Tauri v2 (Rust backend + vanilla JS frontend). Supports local files, NAS/SMB streaming, and bit-perfect playback via CoreAudio.

DAP sync (SD card / USB / MTP) was archived on 2026-04-22 before the beta launch — see [`docs/archive/dap-sync/`](docs/archive/dap-sync/).

## Repository structure

```
noir-tauri/          Main app (all development happens here)
  src/               Frontend — 17 vanilla ES6 modules, no bundler
  src-tauri/         Rust backend — Tauri commands, audio engine
  src-tauri/src/     Core Rust source (lib.rs = Tauri commands, audio/, network/)
  scripts/           Build scripts, .env.local (tokens for compile-time injection)
  CLAUDE.md          ⚠️ DETAILED architecture guide — READ THIS FIRST for any code work
docs/                Specs, beta launch guide, archived features
research/            Market analysis, feature assessments
```

**The detailed CLAUDE.md is at `noir-tauri/CLAUDE.md`.** It contains architecture, state management patterns, critical invariants, audio pipeline details, and session history. Always read it before making changes.

## Build commands

All commands run from `noir-tauri/`:

```bash
# Development
npm run tauri dev                    # Full app (Rust + native macOS window)

# Rust only (from noir-tauri/src-tauri/)
cargo check                          # Type-check (fast)
cargo clippy                         # Lints
cargo test                           # Unit tests
cargo build --release                # Optimized build (LTO + strip)

# JS syntax check (no linter/bundler)
for f in src/*.js; do node --check "$f" && echo "OK: $f"; done

# JS tests (Jest)
npm test -- --watchAll=false                                    # All
npm test -- --watchAll=false --testPathPattern=FormatDisplay     # Single file

# Release build with secrets (compile-time injection)
HEAN_SENTRY_DSN="..." NOIR_GITHUB_FEEDBACK_TOKEN="..." npm run tauri build
```

## Key technical decisions

- **No bundler** — frontend served as-is from `src/` via Tauri
- **macOS only** — CoreAudio backend with bit-perfect/hog mode support
- **Compile-time secrets** — `option_env!()` for Sentry DSN and feedback token; must be set before `cargo build`
- **App mediator pattern** — modules communicate through `app.js` slots, never direct imports
- **State by reference** — `state.js` objects are shared; mutate properties, never reassign
- **No `fs::metadata` in sync plan** — SMB I/O is ~12ms/file; use JS-estimated sizes instead

## Language

Respond in French (project owner preference). Code comments mix French and English.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review

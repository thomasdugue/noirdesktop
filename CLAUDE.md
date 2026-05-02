# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Hean** — a macOS audiophile desktop music player built with Tauri v2 (Rust backend + vanilla JS frontend). Supports local files, NAS/SMB streaming, and bit-perfect playback via CoreAudio.

**Beta v0.2.0-beta.1** published 2026-05-02 on GitHub Releases (signed + notarized DMG). DAP sync (SD card / USB / MTP) was archived on 2026-04-22 — see [`docs/archive/dap-sync/`](docs/archive/dap-sync/).

## Repository structure

```
noir-tauri/             Main app (all development happens here)
  src/                  Frontend — 18 vanilla ES6 modules, no bundler
  src-tauri/            Rust backend — Tauri commands, audio engine, observability
  src-tauri/src/        Core Rust source (lib.rs = Tauri commands, audio/, network/, sentry_init.rs, logging.rs)
  scripts/              Build scripts (dev.sh, release.sh, cloudflare-worker.js), .env.local (gitignored — compile-time secrets)
  CLAUDE.md             ⚠️ DETAILED architecture guide — READ THIS FIRST for any code work
docs/                   Specs, beta launch guide, archived features, BETA_TESTERS_GUIDE.md, BETA_KNOWN_ISSUES.md
docs/index.html         Dev dashboard (GitHub Pages → thomasdugue.github.io/noirdesktop/) — Sentry + GitHub issues mergées avec workflows Plan détaillé
.github/workflows/      feedback-agent.yml, sprint-plan.yml, sprint-synthesis.yml (utilisent secret repo NOIR_GITHUB_TOKEN)
.github/ISSUE_TEMPLATE/ beta-bug-report.md
research/               Market analysis, feature assessments
```

**The detailed CLAUDE.md is at `noir-tauri/CLAUDE.md`.** It contains architecture, state management patterns, critical invariants, audio pipeline details, observability stack (Sentry + tracing), Apple signing pipeline, and session history. Always read it before making changes.

## Build commands

All commands run from `noir-tauri/`:

```bash
# Dev (avec env vars Sentry/Worker auto-sourcées depuis scripts/.env.local)
./scripts/dev.sh                     # Wrapper recommandé — gère option_env! correctement
npm run tauri dev                    # À nu — risque que les secrets compile-time ne soient pas injectés

# Release signé + notarisé (recommandé pour distribution)
./scripts/release.sh                 # Valide les 6 env vars requises, signe, notarise app+DMG, vérifie spctl
                                     # Étapes manuelles APRÈS : dylibbundler + fix LC_RPATH + tarball updater
                                     # (voir noir-tauri/CLAUDE.md → "Release pipeline")

# Rust only (from noir-tauri/src-tauri/)
cargo check                          # Type-check (fast)
cargo clippy                         # Lints
cargo test                           # Unit tests
cargo test --lib sentry_init         # Tests anonymisation paths Sentry (5 tests)

# JS syntax check (no linter/bundler)
for f in src/*.js; do node --check "$f" && echo "OK: $f"; done

# JS tests (Jest)
npm test -- --watchAll=false                                    # All
npm test -- --watchAll=false --testPathPattern=FormatDisplay     # Single file

# Worker Cloudflare (proxy feedback + Sentry)
cd scripts && wrangler deploy        # Re-deploy après modif cloudflare-worker.js
wrangler secret put SENTRY_AUTH_TOKEN # Set/update les secrets côté Cloudflare (idem GITHUB_TOKEN, NOIR_SECRET)
```

## Key technical decisions

- **No bundler** — frontend served as-is from `src/` via Tauri
- **macOS only** — CoreAudio backend with bit-perfect/hog mode support
- **Compile-time secrets via `option_env!()`** — `HEAN_SENTRY_DSN`, `NOIR_WORKER_URL`, `NOIR_WORKER_SECRET` must be set before `cargo build` (utiliser `release.sh` qui valide leur présence)
- **App mediator pattern** — modules communicate through `app.js` slots, never direct imports
- **State by reference** — `state.js` objects are shared; mutate properties, never reassign
- **Observability** — Sentry pour les panics Rust + erreurs JS forwardées (1 seul DSN, pas de `@sentry/browser`), tracing pour les logs persistés (rotation journalière). Toggle RGPD opt-out dans Settings → Privacy.
- **No GitHub token in binary** — feedback passe par un Cloudflare Worker proxy qui détient le `GITHUB_TOKEN` côté serveur
- **Dylib bundling obligatoire** — `libsmbclient` a ~92 deps Samba transitives ; sans bundling l'app crash chez les Macs sans Homebrew
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

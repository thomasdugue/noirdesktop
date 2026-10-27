---
name: hean-ops
description: Outillage hors-app de Hean — feedback via Cloudflare Worker → GitHub Issues, Sentry (panics Rust + erreurs JS forwardées, anonymisation, toggle RGPD), logs tracing persistés, dashboard dev GitHub Pages, sprint-planner, tokens GitHub des workflows. Charger avant de toucher feedback.js, error-tracking.js, sentry_init.rs, logging.rs, scripts/cloudflare-worker.js, scripts/sprint-planner.js, docs/index.html ou .github/workflows/.
---

# hean-ops — feedback, observabilité & dashboard

## External APIs (called from Rust via reqwest)

MusicBrainz + CoverArtArchive (album art), Deezer (artist images + genre enrichment), WikiMedia.

## Feedback → Cloudflare Worker → GitHub Issues

Architecture mise en place 2026-04 → l'app NE contient PLUS le token GitHub. Tout passe par un worker Cloudflare proxy qui détient le secret côté serveur.

```
Hean app → POST $NOIR_WORKER_URL → Cloudflare Worker → GitHub Issues API
                                  ↑                    ↑
                                  vit côté Cloudflare  GITHUB_TOKEN secret côté CF
```

- `submit_feedback` (Tauri command, [lib.rs:4084](src-tauri/src/lib.rs)) : sauvegarde locale **toujours** dans `~/Library/Application Support/noir/feedback/` (backup) + POST vers le worker si `NOIR_WORKER_URL` + `NOIR_WORKER_SECRET` sont injectés au compile-time
- Worker : [scripts/cloudflare-worker.js](scripts/cloudflare-worker.js) — 2 routes :
  - `POST /feedback` (ou racine, legacy) : valide `X-Noir-Secret`, forward à GitHub Issues avec `GITHUB_TOKEN` (secret CF)
  - `GET /sentry/issues` + `/sentry/issue/{shortId}` : proxy Sentry pour le dashboard (contourne CORS browser-side, voir Dashboard ci-dessous)
- Déploiement : `cd noir-tauri/scripts && wrangler deploy` (1 fois) puis `wrangler secret put GITHUB_TOKEN` + `NOIR_SECRET` + `SENTRY_AUTH_TOKEN`
- Sans worker configuré (env vars absents au build) → feedback sauvé en local seulement
- **Piège** : env vars sont `NOIR_WORKER_URL` + `NOIR_WORKER_SECRET` (pas `FEEDBACK_*`). `option_env!` retourne `None` sinon, et le code fait fallback "local-only" silencieusement.

## Observabilité — Sentry + logs persistés

**Stack** :
- Sentry pour les **panics Rust** (panic hook auto via feature `panic`) + **erreurs JS** (`window.error` + `unhandledrejection` → `report_js_error` Tauri command → `sentry::capture_event` côté Rust)
- Tracing pour les **logs persistés** (`tracing-appender`, rotation journalière, `~/Library/Application Support/noir/logs/`)

**Anonymisation** : `before_send` dans `sentry_init::scrub_event` remplace `/Users/<name>/...` → `<HOME>/...` dans message + breadcrumbs + exception values. `send_default_pii: false` pour ne pas stocker les IPs côté Sentry.

**RGPD opt-out** : Settings → Privacy → "Send error reports" toggle.
- Persisté dans `Config.sentry_enabled: Option<bool>` (config.json)
- Lu au boot par `pub fn run()` AVANT init Sentry
- Toggle runtime via `AtomicBool` SENTRY_ENABLED checké dans `before_send` → désactivation immédiate sans redémarrage si Sentry était init au boot
- Si toggle activé alors que Sentry n'a pas été init au boot (`enabled=false` au démarrage) → message "Restart Hean to enable error reporting" affiché dans le hint

**Bouton "Attach recent logs" du modal feedback** : appelle `get_recent_logs(maxKb: 200)` qui retourne les 1-2 derniers fichiers de log concaténés et tronqués au tail. Préfixé à la description avant POST au worker.

**DSN compile-time** : injecté via `option_env!("HEAN_SENTRY_DSN")` (project Sentry `hean-app/rust`, région EU `https://de.sentry.io`). Sans DSN → `sentry_init::init()` retourne `None`, no-op total.

## Dev dashboard (`docs/index.html` → GitHub Pages)

[`thomasdugue.github.io/noirdesktop/`](https://thomasdugue.github.io/noirdesktop/) — cockpit du dev qui affiche :
- **Issues GitHub** (de `noir-feedback`) avec checkbox de sélection
- **Crashs Sentry** (via worker proxy `/sentry/issues`) **dans la même liste**, avec icône éclair violette + checkbox
- Filtres 2D : Source (All/GitHub/Sentry) × Type (All/Bugs/UX/Sprint/High)
- 4 actions : Feedback Agent, Synthèse Sprint, Plan détaillé, Debug

**Plan détaillé** ([`scripts/sprint-planner.js --plan <ids>`](scripts/sprint-planner.js)) :
- Accepte mix de numéros GitHub (`12`) et Sentry shortIds (`RUST-1`)
- Sentry shortIds → fetch via worker `/sentry/issue/{shortId}` (qui résout le shortId → groupId puis fetch issue + last event avec stack trace)
- Modèle : **`claude-opus-4-7`** (pas 4-5 ni 4-6)
- Adaptive thinking + effort `xhigh` (recommandé Anthropic pour coding/agentic)
- **Charge 583 KB de codebase main** dans le prompt (16 fichiers JS + 13 fichiers Rust prioritaires, cap 60KB par fichier, total 600KB)
- **Prompt caching** : `cache_control: ephemeral` sur le bloc codebase → ~90% économie sur les appels 2/N dans la même fenêtre 5min
- Génère `SPRINT.md` qui est **upload comme artifact** GitHub Actions (pas commit dans le repo — l'ancien commit a été supprimé pour ne plus polluer les nouveaux runs)

**Tokens GitHub côté repo** :
- Secret repo `NOIR_GITHUB_TOKEN` : utilisé par les workflows CI (`feedback-agent.yml`, `sprint-plan.yml`, `sprint-synthesis.yml`) pour fetch les issues. Doit avoir `Issues:Read` sur `thomasdugue/noir-feedback`.
- PAT du dashboard browser (localStorage) : pour fetch issues + déclencher les workflows. Doit avoir `Issues:RW` + `Actions:RW` sur `noirdesktop` ET `noir-feedback`.

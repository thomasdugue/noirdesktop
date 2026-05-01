#!/usr/bin/env node
/**
 * sprint-planner.js — Analyse & planification des sprint candidates Noir
 *
 * MODE 1 — Synthèse (défaut) :
 *   node scripts/sprint-planner.js
 *   → Génère SPRINT.md avec coût / impact / risques pour chaque issue
 *   → Utilisé pour prendre la décision de priorisation
 *
 * MODE 2 — Plan détaillé :
 *   node scripts/sprint-planner.js --plan 8,12,13
 *   → Génère un plan d'implémentation complet pour les issues spécifiées
 *   → Ajoute les sections détaillées dans SPRINT.md
 */

import Anthropic from '@anthropic-ai/sdk'
import { Octokit } from '@octokit/rest'
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const FEEDBACK_REPO = process.env.NOIR_FEEDBACK_REPO || 'tdugue/noir-feedback'
// Worker proxy pour Sentry — tient le token côté serveur, pas besoin de secret côté script.
const SENTRY_WORKER = process.env.NOIR_WORKER_URL || 'https://noir-feedback.thomas-dugue.workers.dev'

if (!GITHUB_TOKEN)  { console.error('❌ Missing GITHUB_TOKEN');      process.exit(1) }
if (!ANTHROPIC_KEY) { console.error('❌ Missing ANTHROPIC_API_KEY'); process.exit(1) }

const [REPO_OWNER, REPO_NAME] = FEEDBACK_REPO.split('/')
const octokit   = new Octokit({ auth: GITHUB_TOKEN })
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

// Lire les args CLI : --plan accepte un mix de numéros GitHub (`12`) et de Sentry
// shortIds (`RUST-1`). Format en sortie : [{ source, number|shortId }, ...]
const args     = process.argv.slice(2)
const planFlag = args.indexOf('--plan')
const planMode = planFlag !== -1

function parsePlanIds(raw) {
  if (!raw) return []
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(token => {
    if (/^\d+$/.test(token))                     return { source: 'github', number: parseInt(token, 10) }
    if (/^[A-Z][A-Z0-9]*-\d+$/i.test(token))     return { source: 'sentry', shortId: token.toUpperCase() }
    console.warn(`⚠️  ignoré (format non reconnu) : ${token}`)
    return null
  }).filter(Boolean)
}
const planIssues = planMode ? parsePlanIds(args[planFlag + 1]) : []

// ── Contexte codebase ─────────────────────────────────────────────────────────

const CODEBASE_CONTEXT = `
Stack : Tauri v2 + Rust (CPAL/CoreAudio) + Vanilla JS ES6 (pas de bundler)

Modules JS (src/) :
- renderer.js (737L) — orchestrateur, settings panel
- app.js (104L) — médiateur cross-module (évite imports circulaires)
- state.js (197L) — état mutable partagé par référence : playback{}, library{}, ui{}, queue[]
- views.js (2864L) — home, albums, artists, virtual scroll
- playback.js (1493L) — audio Rust, gapless, interpolation 60fps, repeat/shuffle, queue
- playlists.js (1217L) — playlists CRUD, favoris
- panels.js (1018L) — queue panel, track info, context menu
- library.js (817L) — covers, metadata, scan
- shortcuts.js (564L) — raccourcis locaux + globaux Tauri (F7/F8/F9)
- search.js (337L) — index inversé, résultats
- drag.js (182L) — drag & drop custom

Rust (src-tauri/src/) :
- lib.rs — commandes Tauri : play_track, pause, seek, set_volume, etc.
- audio_engine.rs — CPAL/CoreAudio, Hog Mode, gapless decoding

Règles : state.js toujours muté (jamais réassigné) · app.js médiateur pour cross-module · invoke('cmd', {}) pour JS→Rust
`.trim()

// ── Utilitaires GitHub ────────────────────────────────────────────────────────

async function fetchIssues(labels = null) {
  const opts = {
    owner: REPO_OWNER, repo: REPO_NAME,
    state: 'open', per_page: 100,
  }
  if (labels) opts.labels = labels
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, opts)
  // Enrichir avec le commentaire de classification de l'agent
  for (const issue of issues) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner: REPO_OWNER, repo: REPO_NAME, issue_number: issue.number,
    })
    issue._agentComment = comments.find(c => c.body.includes('🤖 Agent Classification'))?.body ?? null
  }
  return issues
}

function getLabel(issue, prefix) {
  return issue.labels.find(l => l.name.startsWith(prefix))?.name.replace(prefix, '') ?? '?'
}

// ── Chargement de la codebase (utilisé pour les plans détaillés) ────────────
//
// Le mode --plan injecte les fichiers source dans le prompt pour qu'Opus
// raisonne sur du vrai code (pas juste une description). Cap à 200 KB par
// fichier pour rester sous la limite de contexte d'Opus 4.5 (200k tokens).

const REPO_ROOT    = join(__dirname, '..')              // = noir-tauri/
const FRONTEND_DIR = join(REPO_ROOT, 'src')              // src/*.js (frontend)
const BACKEND_DIR  = join(REPO_ROOT, 'src-tauri/src')    // *.rs (backend)
const PER_FILE_CAP = 60_000                              // octets max par fichier (~15k tokens)
const TOTAL_CAP    = 600_000                             // budget total (~150k tokens, laisse marge pour Opus 200k)

// Whitelist des fichiers Rust prioritaires (les plus structurants pour comprendre
// l'architecture). On évite de walker récursivement tout src-tauri/src/ qui dépasserait
// largement le budget.
const RUST_PRIORITY = [
  'lib.rs',                          // toutes les commandes Tauri + setup
  'audio_engine.rs',                 // moteur audio principal
  'audio_decoder.rs',                // décodage Symphonia + SmbProgressiveFile
  'audio/coreaudio_backend.rs',      // CoreAudio HAL (backend macOS)
  'audio/coreaudio_stream.rs',       // streaming + gapless
  'media_controls.rs',               // media keys (souvlaki)
  'eq.rs',                           // EQ paramétrique
  'resampler.rs',                    // resampling
  'network/smb.rs',                  // SMB client
  'network/scanner.rs',              // SMB scan + progressive download
  'network/mod.rs',                  // types réseau
  'sentry_init.rs',                  // error tracking
  'logging.rs',                      // logs persistés
]

function loadCodebase() {
  const files = []
  let totalBytes = 0

  function tryAdd(fullPath, lang) {
    if (!existsSync(fullPath)) return
    if (!statSync(fullPath).isFile()) return
    const content = readFileSync(fullPath, 'utf-8')
    const truncated = content.length > PER_FILE_CAP
    const usable = truncated ? content.slice(0, PER_FILE_CAP) + '\n// [...truncated]' : content
    if (totalBytes + usable.length > TOTAL_CAP) return false
    files.push({ path: relative(REPO_ROOT, fullPath), lang, content: usable, truncated })
    totalBytes += usable.length
    return true
  }

  // Frontend JS — on prend tout (16 fichiers ~ 400 KB après cap)
  if (existsSync(FRONTEND_DIR)) {
    for (const entry of readdirSync(FRONTEND_DIR).sort()) {
      if (!entry.endsWith('.js')) continue
      tryAdd(join(FRONTEND_DIR, entry), 'js')
    }
  }

  // Backend Rust — whitelist priorisée (les plus structurants en premier)
  for (const rel of RUST_PRIORITY) {
    tryAdd(join(BACKEND_DIR, rel), 'rust')
  }

  return { files, totalBytes }
}

function formatCodebaseForPrompt(files) {
  return files.map(({ path, lang, content, truncated }) =>
    `### \`${path}\`${truncated ? ' (truncated)' : ''}\n\`\`\`${lang}\n${content}\n\`\`\``
  ).join('\n\n')
}

// Cache : on charge la codebase une seule fois par run
let _codebaseCache = null
function getCodebase() {
  if (!_codebaseCache) {
    _codebaseCache = loadCodebase()
    console.log(`📚 Codebase loaded: ${_codebaseCache.files.length} files, ${(_codebaseCache.totalBytes / 1024).toFixed(0)} KB`)
  }
  return _codebaseCache
}

// ── Utilitaires Sentry (via worker proxy, le token est côté serveur) ─────────

async function fetchSentryIssue(shortId) {
  const url = `${SENTRY_WORKER}/sentry/issue/${shortId}`
  const res = await fetch(url)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Sentry ${shortId} fetch failed (${res.status}): ${detail.slice(0, 200)}`)
  }
  return res.json()
}

/** Normalise une issue Sentry au même format qu'une issue GitHub pour le prompt
 *  (fields: number, title, body, _agentComment, _isSentry). */
function sentryToIssueLike(s) {
  const stack = s.stackTrace ? `\n\nStack trace (10 dernières frames) :\n\`\`\`\n${s.stackTrace}\n\`\`\`` : ''
  const tags = (s.eventTags || []).slice(0, 8).map(t => `${t.key}=${t.value}`).join(', ')
  const meta = `\n\n— Source: Sentry · Level: ${s.level} · Type: ${s.type} · Affected: ${s.userCount} user(s), ${s.count} event(s) · Last seen: ${s.lastSeen}`
  return {
    number:        s.shortId,                                    // utilisé comme identifiant
    title:         s.title,
    body:          (s.eventMessage || s.culprit || '') + meta + (tags ? `\nTags: ${tags}` : '') + stack,
    _agentComment: null,
    _isSentry:     true,
    _permalink:    s.permalink,
    labels:        [],                                           // pas de labels GitHub côté Sentry
  }
}

// ── MODE 1 : Analyse rapide (coût / impact / risques) ────────────────────────

async function quickAnalysis(issue) {
  const prompt = `Tu es expert du codebase Noir Desktop (${CODEBASE_CONTEXT}).

Issue #${issue.number} : ${issue.title}
${issue.body ? `\nDescription :\n${issue.body}` : ''}
${issue._agentComment ? `\nClassification agent :\n${issue._agentComment.slice(0, 600)}` : ''}

Réponds UNIQUEMENT en JSON strict (sans markdown) :
{
  "cost": "estimation effort réaliste (ex: 2h, 1 jour, 3 jours)",
  "cost_detail": "pourquoi ce coût — 1 phrase",
  "impact": "impact utilisateur — 1 phrase (quelles features, % users affectés)",
  "impact_score": <1-5>,
  "risks": "risques de régression — 1 phrase (quoi pourrait casser)",
  "risk_score": <1-5>,
  "modules": ["module1.js"],
  "verdict": "quick-win | standard | complex | needs-investigation"
}`

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    })
    let raw = msg.content[0].text.trim()
    // Extraire uniquement le bloc JSON (ignore tout texte avant/après)
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON object found')
    return JSON.parse(match[0])
  } catch (err) {
    console.error(`    ⚠️  Analyse #${issue.number} :`, err.message)
    return null
  }
}

// ── MODE 2 : Plan d'implémentation détaillé ───────────────────────────────────

async function detailedPlan(issue) {
  const idLine = issue._isSentry
    ? `Crash Sentry [${issue.number}] : ${issue.title}`
    : `Issue #${issue.number} : ${issue.title}`
  const sourceHint = issue._isSentry
    ? `\nNB : C'est un crash réel remonté par Sentry (avec stack trace ci-dessous). Concentre-toi sur le diagnostic à partir de la pile d'appels et propose un fix défensif.`
    : ''

  const codebase = getCodebase()
  const codebaseSection = formatCodebaseForPrompt(codebase.files)

  // Le prompt est découpé en 2 blocs :
  //   1. Le bloc CODEBASE (gros, identique entre toutes les issues du run) → caché via prompt caching.
  //      Premier appel = full price. Appels suivants dans la même fenêtre 5min = 90% moins cher.
  //   2. Le bloc ISSUE (petit, spécifique à chaque issue) → pas de cache.
  const codebaseBlock = `Tu es ingénieur senior du codebase Noir Desktop.
Tu vas recevoir l'INTÉGRALITÉ du code source ci-dessous, puis une issue à analyser. Ton plan doit être ancré dans le code RÉEL — cite les fonctions, lignes, patterns existants. N'invente rien.

## Contexte général
${CODEBASE_CONTEXT}

## Code source actuel (\`main\` branch)
${codebaseSection}`

  const issueBlock = `## Issue à analyser

${idLine}${sourceHint}
${issue.body ? `\nDescription :\n${issue.body}` : ''}
${issue._agentComment ? `\nClassification :\n${issue._agentComment.slice(0, 800)}` : ''}

## Format de réponse

Réponds UNIQUEMENT en JSON strict (pas de markdown, pas de texte avant/après).

{
  "root_cause": "cause racine identifiée à partir du code réel — 2-3 phrases techniques précises (cite fonction/fichier exact)",
  "modules": ["chemin/exact/fichier.js"],
  "rust_involved": false,
  "steps": [
    {
      "n": 1,
      "file": "noir-tauri/src/playback.js",
      "where": "fonction X ligne ~Y, dans le bloc Z",
      "what": "modification précise — ce qui change exactement",
      "hint": "// snippet de code concret (pas du pseudo)"
    }
  ],
  "edge_cases": ["cas limite vraisemblable au vu du code", "..."],
  "tests": ["scénario de test concret avec inputs précis", "..."],
  "regressions": "ce qui pourrait casser ailleurs (cite les call sites concernés)",
  "effort": "Xh analyse + Xh implem + Xh test (justifié)"
}`

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 16000,
      // Adaptive thinking : Opus 4.7 décide quand/combien réfléchir.
      // Sur 4.7, c'est le seul mode supporté (budget_tokens = 400).
      thinking: { type: 'adaptive' },
      // xhigh = recommandé par Anthropic pour les tâches de coding/agentic
      // (entre high et max). Effort matters more sur 4.7 que sur tout Opus précédent.
      output_config: { effort: 'xhigh' },
      messages: [{
        role: 'user',
        content: [
          // Bloc codebase identique entre toutes les issues du run → cache 90% off
          // sur les appels 2/3/N dans la fenêtre 5 min. Min cacheable sur Opus 4.7 = 4096 tokens.
          { type: 'text', text: codebaseBlock, cache_control: { type: 'ephemeral' } },
          // Bloc spécifique à chaque issue — pas de cache.
          { type: 'text', text: issueBlock },
        ],
      }],
    })
    let raw = msg.content[0].text.trim()
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    try {
      return JSON.parse(raw)
    } catch (_) {
      // JSON tronqué — tenter de sauver la partie valide
      const cut = raw.lastIndexOf('"regressions"')
      if (cut > 0) {
        try { return JSON.parse(raw.slice(0, cut) + '","regressions":"(tronqué)","effort":"(tronqué)"}') } catch (_2) {}
      }
      return { root_cause: '(parse error)', modules: [], rust_involved: false, steps: [], edge_cases: [], tests: [], regressions: raw.slice(0, 200), effort: '?' }
    }
  } catch (err) {
    console.error(`    ⚠️  Plan #${issue.number} :`, err.message)
    return null
  }
}

// ── Formaters markdown ────────────────────────────────────────────────────────

const VERDICT_ICON = { 'quick-win': '⚡', standard: '🔧', complex: '🏗', 'needs-investigation': '🔍' }
const IMPACT_BAR   = n => '█'.repeat(n) + '░'.repeat(5 - n)
const RISK_BAR     = n => '█'.repeat(n) + '░'.repeat(5 - n)

function formatSummaryRow(issue, a) {
  if (!a) return `| [#${issue.number}](https://github.com/${FEEDBACK_REPO}/issues/${issue.number}) | ${issue.title.slice(0,45)} | ? | ? | ? | ? | ? |`
  const icon = VERDICT_ICON[a.verdict] ?? '•'
  return `| [#${issue.number}](https://github.com/${FEEDBACK_REPO}/issues/${issue.number}) | ${issue.title.slice(0,45)} | ${a.cost} | ${IMPACT_BAR(a.impact_score)} ${a.impact_score}/5 | ${RISK_BAR(a.risk_score)} ${a.risk_score}/5 | ${icon} ${a.verdict} | ${a.modules.map(m=>`\`${m}\``).join(', ')} |`
}

function formatSummaryDetail(issue, a) {
  if (!a) return ''
  return `
<details>
<summary><strong>#${issue.number}</strong> — ${issue.title}</summary>

- **Coût :** ${a.cost} — ${a.cost_detail}
- **Impact :** ${a.impact}
- **Risques :** ${a.risks}

</details>`
}

function formatDetailedPlan(issue, plan) {
  const idLabel = issue._isSentry ? `\`${issue.number}\`` : `#${issue.number}`
  const sourceLink = issue._isSentry
    ? `🔗 [Sentry](${issue._permalink || '#'})`
    : `🔗 [GitHub](https://github.com/${FEEDBACK_REPO}/issues/${issue.number})`

  if (!plan) return `### ${idLabel} — ${issue.title}\n\n> ❌ Plan non généré.\n\n---\n`

  const steps = plan.steps.map(s => `
#### Étape ${s.n} — \`${s.file}\`
> **Où :** ${s.where}

${s.what}

\`\`\`js
${s.hint}
\`\`\``).join('\n')

  return `### ${idLabel} — ${issue.title}

${sourceLink} · modules : ${plan.modules.map(m=>`\`${m}\``).join(', ')}${plan.rust_involved ? ' · 🦀 Rust' : ''}

**Cause racine :** ${plan.root_cause}

#### Plan d'implémentation
${steps}

#### Cas limites
${plan.edge_cases.map(e => `- ${e}`).join('\n')}

#### Tests
${plan.tests.map(t => `- [ ] ${t}`).join('\n')}

#### Risques de régression
${plan.regressions}

#### Effort
${plan.effort}

---
`
}

// ── Génération SPRINT.md ──────────────────────────────────────────────────────

function writeSynthesis(issues, analyses) {
  const date = new Date().toLocaleDateString('fr-FR', { weekday:'long', year:'numeric', month:'long', day:'numeric' })

  const tableRows  = issues.map((iss, i) => formatSummaryRow(iss, analyses[i])).join('\n')
  const detailRows = issues.map((iss, i) => formatSummaryDetail(iss, analyses[i])).join('\n')

  const quickWins = issues.filter((_, i) => analyses[i]?.verdict === 'quick-win')
  const complex   = issues.filter((_, i) => analyses[i]?.verdict === 'complex' || analyses[i]?.verdict === 'needs-investigation')

  const doc = `# Sprint Plan — Noir Beta
> ${date} · ${issues.length} issues analysées · \`feedback-agent.js\` + \`sprint-planner.js\`

---

## Vue d'ensemble

| Issue | Titre | Coût | Impact | Risque | Verdict | Modules |
|---|---|---|---|---|---|---|
${tableRows}

---

## Détail rapide par issue

${detailRows}

---

## 👉 Prochaines étapes

Pour générer le plan d'implémentation détaillé des issues que tu choisis :

\`\`\`bash
node scripts/sprint-planner.js --plan ${issues.slice(0,3).map(i=>i.number).join(',')}
\`\`\`

**Quick wins suggérés :** ${quickWins.length > 0 ? quickWins.map(i=>`#${i.number}`).join(', ') : 'aucun identifié'}
**À investiguer d'abord :** ${complex.length > 0 ? complex.map(i=>`#${i.number}`).join(', ') : 'aucun'}

---
*Généré par sprint-planner.js — ${new Date().toISOString()}*
`

  const outPath = join(__dirname, 'SPRINT.md')
  writeFileSync(outPath, doc, 'utf-8')
  console.log(`\n📄 SPRINT.md écrit (synthèse)`)
  return outPath
}

function appendDetailedPlans(planResults) {
  const outPath = join(__dirname, 'SPRINT.md')
  const existing = existsSync(outPath) ? readFileSync(outPath, 'utf-8') : ''
  const date = new Date().toLocaleDateString('fr-FR', { weekday:'long', year:'numeric', month:'long', day:'numeric' })

  const plansContent = planResults.map(({issue, plan}) => formatDetailedPlan(issue, plan)).join('\n')

  let updated
  if (!existing.trim()) {
    // Pas de SPRINT.md existant — créer un document complet
    updated = `# 🛠 Plans d'implémentation détaillés
> ${date} · ${planResults.length} issues · \`sprint-planner.js --plan\`

---

${plansContent}

---
*Généré par sprint-planner.js — ${new Date().toISOString()}*
`
  } else {
    const section = `\n---\n\n## 🛠 Plans d'implémentation détaillés\n\n${plansContent}`
    const marker = '## 🛠 Plans d\'implémentation détaillés'
    updated = existing.includes(marker)
      ? existing.slice(0, existing.indexOf('\n---\n\n' + marker)) + section
      : existing.trimEnd() + '\n' + section
  }

  writeFileSync(outPath, updated, 'utf-8')
  console.log(`\n📄 Plans détaillés écrits dans SPRINT.md`)
  return outPath
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (planMode) {
    // ── MODE 2 : Plans détaillés pour issues spécifiques (GitHub + Sentry) ──
    const ghIds     = planIssues.filter(p => p.source === 'github').map(p => p.number)
    const sentryIds = planIssues.filter(p => p.source === 'sentry').map(p => p.shortId)
    console.log(`🛠  Mode plan détaillé — GitHub : ${ghIds.length}, Sentry : ${sentryIds.length}`)

    const targets = []

    // Fetch les issues GitHub demandées
    if (ghIds.length > 0) {
      const allIssues = await fetchIssues()
      for (const id of ghIds) {
        const found = allIssues.find(i => i.number === id)
        if (found) targets.push(found)
        else console.warn(`⚠️  GitHub #${id} introuvable`)
      }
    }

    // Fetch les Sentry issues demandées via le worker proxy
    for (const shortId of sentryIds) {
      try {
        console.log(`  ⏳ Fetch Sentry ${shortId} via worker…`)
        const sentry = await fetchSentryIssue(shortId)
        targets.push(sentryToIssueLike(sentry))
      } catch (err) {
        console.error(`⚠️  Sentry ${shortId} :`, err.message)
      }
    }

    if (targets.length === 0) {
      console.error('❌ Aucune issue (GitHub ou Sentry) récupérée.')
      process.exit(1)
    }

    console.log(`\n🧠 Plans détaillés (claude-sonnet) pour ${targets.length} issues...`)
    const planResults = []
    for (const issue of targets) {
      const tag = issue._isSentry ? `[Sentry ${issue.number}]` : `#${issue.number}`
      console.log(`  → ${tag} : ${issue.title.slice(0,60)}`)
      const plan = await detailedPlan(issue)
      planResults.push({ issue, plan })
      if (plan) console.log(`    ✅ ${plan.steps.length} étapes`)
      await new Promise(r => setTimeout(r, 500))
    }

    const outPath = appendDetailedPlans(planResults)
    try { const { execSync } = await import('child_process'); execSync(`open "${outPath}"`) } catch (_) {}
    console.log('\n✅ Terminé !')

  } else {
    // ── MODE 1 : Synthèse rapide ──
    console.log('📊 Mode synthèse — analyse coût / impact / risques')
    console.log(`   Repo : ${FEEDBACK_REPO}`)

    const issues = await fetchIssues('sprint-candidate')
    if (issues.length === 0) {
      console.log('⚠️  Aucune sprint candidate. Lance d\'abord feedback-agent.js')
      return
    }
    console.log(`   ${issues.length} sprint candidates trouvées\n`)

    console.log('🧠 Analyse rapide (claude-haiku)...')
    const analyses = []
    for (const issue of issues) {
      process.stdout.write(`  → #${issue.number} ${issue.title.slice(0,50)}... `)
      const a = await quickAnalysis(issue)
      analyses.push(a)
      console.log(a ? `${a.verdict} · ${a.cost}` : '⚠️  échec')
      await new Promise(r => setTimeout(r, 300))
    }

    const outPath = writeSynthesis(issues, analyses)
    try { const { execSync } = await import('child_process'); execSync(`open "${outPath}"`) } catch (_) {}
    console.log('\n✅ Terminé ! Lis SPRINT.md puis lance :')
    console.log(`   node scripts/sprint-planner.js --plan <numéros séparés par virgule>\n`)
  }
}

main().catch(err => { console.error('❌', err); process.exit(1) })

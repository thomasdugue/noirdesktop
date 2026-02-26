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
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const FEEDBACK_REPO = process.env.NOIR_FEEDBACK_REPO || 'tdugue/noir-feedback'

if (!GITHUB_TOKEN)  { console.error('❌ Missing GITHUB_TOKEN');      process.exit(1) }
if (!ANTHROPIC_KEY) { console.error('❌ Missing ANTHROPIC_API_KEY'); process.exit(1) }

const [REPO_OWNER, REPO_NAME] = FEEDBACK_REPO.split('/')
const octokit   = new Octokit({ auth: GITHUB_TOKEN })
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

// Lire les args CLI
const args       = process.argv.slice(2)
const planFlag   = args.indexOf('--plan')
const planMode   = planFlag !== -1
const planIssues = planMode
  ? args[planFlag + 1]?.split(',').map(n => parseInt(n.trim())).filter(Boolean) ?? []
  : []

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
  const prompt = `Tu es ingénieur senior du codebase Noir Desktop.

${CODEBASE_CONTEXT}

---
Issue #${issue.number} : ${issue.title}
${issue.body ? `\nDescription :\n${issue.body}` : ''}
${issue._agentComment ? `\nClassification :\n${issue._agentComment.slice(0, 800)}` : ''}

Génère un plan d'implémentation précis en JSON strict (sans markdown) :
{
  "root_cause": "cause racine hypothétique — 2-3 phrases techniques",
  "modules": ["fichier.js"],
  "rust_involved": false,
  "steps": [
    {
      "n": 1,
      "file": "src/playback.js",
      "where": "fonction ou zone du code",
      "what": "ce qu'il faut faire — précis",
      "hint": "// pseudo-code court"
    }
  ],
  "edge_cases": ["cas limite 1", "cas limite 2"],
  "tests": ["scénario de test 1", "scénario de test 2"],
  "regressions": "ce qui pourrait casser ailleurs",
  "effort": "décomposition : Xh analyse + Xh implem + Xh test"
}`

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
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
  if (!plan) return `### #${issue.number} — ${issue.title}\n\n> ❌ Plan non généré.\n\n---\n`

  const steps = plan.steps.map(s => `
#### Étape ${s.n} — \`${s.file}\`
> **Où :** ${s.where}

${s.what}

\`\`\`js
${s.hint}
\`\`\``).join('\n')

  return `### #${issue.number} — ${issue.title}

🔗 [GitHub](https://github.com/${FEEDBACK_REPO}/issues/${issue.number}) · modules : ${plan.modules.map(m=>`\`${m}\``).join(', ')}${plan.rust_involved ? ' · 🦀 Rust' : ''}

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
    // ── MODE 2 : Plans détaillés pour issues spécifiques ──
    console.log(`🛠  Mode plan détaillé — issues : #${planIssues.join(', #')}`)

    // En mode plan, récupérer TOUTES les issues (pas seulement sprint-candidate)
    const allIssues = await fetchIssues()
    const targets   = allIssues.filter(i => planIssues.includes(i.number))

    if (targets.length === 0) {
      console.error('❌ Aucune issue trouvée parmi les sprint candidates avec ces numéros.')
      process.exit(1)
    }

    console.log(`\n🧠 Plans détaillés (claude-sonnet) pour ${targets.length} issues...`)
    const planResults = []
    for (const issue of targets) {
      console.log(`  → #${issue.number} : ${issue.title.slice(0,60)}`)
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

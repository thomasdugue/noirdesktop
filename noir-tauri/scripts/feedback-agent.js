#!/usr/bin/env node
/**
 * feedback-agent.js — Agent de traitement des feedbacks beta Noir
 *
 * Usage :
 *   ANTHROPIC_API_KEY=xxx GITHUB_TOKEN=xxx node scripts/feedback-agent.js
 *
 * Ce que fait ce script :
 *   1. Lit tous les GitHub Issues du repo noir-feedback labelisés "beta"
 *   2. Pour chaque issue sans label "processed", appelle Claude pour classifier
 *   3. Ajoute un commentaire de classification + labels sur chaque issue
 *   4. Génère/met à jour scripts/feedback-report.md
 */

import Anthropic from '@anthropic-ai/sdk'
import { Octokit } from '@octokit/rest'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// === CONFIGURATION ===

const GITHUB_TOKEN   = process.env.GITHUB_TOKEN
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY
const FEEDBACK_REPO  = process.env.NOIR_FEEDBACK_REPO || 'tdugue/noir-feedback'

if (!GITHUB_TOKEN)  { console.error('❌ Missing GITHUB_TOKEN env var'); process.exit(1) }
if (!ANTHROPIC_KEY) { console.error('❌ Missing ANTHROPIC_API_KEY env var'); process.exit(1) }

const [REPO_OWNER, REPO_NAME] = FEEDBACK_REPO.split('/')

const octokit = new Octokit({ auth: GITHUB_TOKEN })
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

// === ÉTAPE 1 : Collecte des issues GitHub ===

async function fetchUnprocessedIssues() {
  console.log(`\n📥 Fetching issues from ${FEEDBACK_REPO}...`)

  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    labels: 'beta',
    state: 'open',
    per_page: 100,
  })

  const unprocessed = issues.filter(issue =>
    !issue.labels.some(l => l.name === 'processed')
  )

  console.log(`  Found ${issues.length} beta issues, ${unprocessed.length} unprocessed`)
  return unprocessed
}

// === ÉTAPE 2 : Classification Claude ===

const SYSTEM_PROMPT = `Tu es un analyste produit expert pour Noir, un lecteur audio audiophile macOS.
Tu analyses les feedbacks beta et retournes une classification JSON structurée.
Réponds UNIQUEMENT avec du JSON valide, sans markdown, sans texte avant ou après.`

async function classifyIssue(issue) {
  const prompt = `Classifie ce feedback beta de Noir Desktop (lecteur audio audiophile macOS / Tauri + Rust) :

Titre : ${issue.title}
Corps :
${issue.body || '(vide)'}

Retourne un objet JSON avec exactement ces champs :
{
  "category": "bug" | "feature" | "ux" | "performance" | "limitation" | "other",
  "importance": <1-10, impact sur l'expérience utilisateur>,
  "complexity": <1-10, 1=quick fix, 10=refactoring majeur>,
  "priority_score": <importance / complexity, arrondi à 2 décimales>,
  "resolution_method": "css_fix" | "js_logic" | "rust_backend" | "architecture" | "wont_fix" | "by_design" | "needs_investigation",
  "estimated_effort": "1h" | "half_day" | "1_day" | "1_week" | "2_weeks+",
  "affected_users_ratio": <0.0-1.0, estimation proportion des betas affectés>,
  "suggested_action": "<max 100 chars, prochaine action concrète>",
  "sprint_candidate": <true si importance>=7 ET complexity<=5>,
  "reasoning": "<2-3 phrases expliquant la classification>"
}`

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    })

    // Nettoyer les éventuels blocs markdown (```json ... ```)
    let raw = msg.content[0].text.trim()
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    return JSON.parse(raw)
  } catch (err) {
    console.error(`  ⚠️  Classification failed for #${issue.number}:`, err.message)
    return null
  }
}

// === ÉTAPE 3 : Mise à jour GitHub ===

async function updateIssue(issue, classification) {
  const { category, importance, complexity, priority_score, resolution_method,
          estimated_effort, affected_users_ratio, suggested_action, sprint_candidate, reasoning } = classification

  // Commentaire de classification
  const comment = `## 🤖 Agent Classification

| Field | Value |
|---|---|
| **Category** | ${category} |
| **Importance** | ${importance}/10 |
| **Complexity** | ${complexity}/10 |
| **Priority score** | ${priority_score} (importance/complexity) |
| **Resolution method** | \`${resolution_method}\` |
| **Estimated effort** | ${estimated_effort} |
| **Affected users** | ~${Math.round(affected_users_ratio * 100)}% of beta testers |
| **Sprint candidate** | ${sprint_candidate ? '✅ Yes' : '❌ No'} |

**Suggested action:** ${suggested_action}

**Reasoning:** ${reasoning}

---
*Processed by feedback-agent.js — ${new Date().toISOString()}*`

  await octokit.rest.issues.createComment({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issue.number,
    body: comment,
  })

  // Labels à ajouter
  const newLabels = [
    'processed',
    `category:${category}`,
    `effort:${estimated_effort.replace(/_/g, '-')}`,
  ]
  if (importance >= 8)     newLabels.push('priority:high')
  else if (importance >= 5) newLabels.push('priority:medium')
  else                      newLabels.push('priority:low')
  if (sprint_candidate)    newLabels.push('sprint-candidate')

  // Créer les labels manquants (ignore les erreurs si déjà existants)
  for (const labelName of newLabels) {
    try {
      await octokit.rest.issues.createLabel({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        name: labelName,
        color: getLabelColor(labelName),
      })
    } catch (_) { /* label existe déjà */ }
  }

  await octokit.rest.issues.addLabels({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issue.number,
    labels: newLabels,
  })

  console.log(`  ✅ #${issue.number} processed — importance:${importance} complexity:${complexity} sprint:${sprint_candidate}`)
}

function getLabelColor(name) {
  if (name.startsWith('priority:high'))    return 'e07050'
  if (name.startsWith('priority:medium'))  return 'e09050'
  if (name.startsWith('priority:low'))     return '888888'
  if (name.startsWith('category:bug'))     return 'c0392b'
  if (name.startsWith('category:feature')) return '2980b9'
  if (name.startsWith('sprint'))           return '27ae60'
  if (name === 'processed')                return '555555'
  return 'aaaaaa'
}

// === ÉTAPE 4 : Rapport hebdomadaire ===

async function generateReport(allIssues, processedResults) {
  const now = new Date()
  const weekStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  // Enrichir les issues avec leur classification (récupérée depuis les commentaires)
  const enriched = processedResults.filter(Boolean)

  if (enriched.length === 0) {
    console.log('\n📊 No new issues to report.')
    return
  }

  // Stats globales
  const bugs     = enriched.filter(r => r.cls.category === 'bug')
  const features = enriched.filter(r => r.cls.category === 'feature')
  const ux       = enriched.filter(r => r.cls.category === 'ux')
  const other    = enriched.filter(r => !['bug','feature','ux'].includes(r.cls.category))

  const avgImportance = (enriched.reduce((s, r) => s + r.cls.importance, 0) / enriched.length).toFixed(1)
  const quickWins = enriched.filter(r => r.cls.sprint_candidate)
  const critical  = bugs.filter(r => r.cls.importance >= 8).sort((a,b) => b.cls.importance - a.cls.importance)

  // Trier par priority_score desc
  const byPriority = [...enriched].sort((a,b) => b.cls.priority_score - a.cls.priority_score)
  const sprintList  = enriched.filter(r => r.cls.sprint_candidate)
                              .sort((a,b) => b.cls.priority_score - a.cls.priority_score)

  const featureRequests = features.sort((a,b) => b.cls.importance - a.cls.importance)

  function issueRow(r) {
    return `| [#${r.issue.number}](https://github.com/${FEEDBACK_REPO}/issues/${r.issue.number}) | ${r.issue.title.slice(0,50)} | ${r.cls.importance}/10 | ${r.cls.estimated_effort} | ${r.cls.suggested_action.slice(0,60)} |`
  }

  const report = `# Noir Beta Feedback — Week of ${weekStr}

## Summary

- **${enriched.length}** new feedbacks processed (${bugs.length} bugs, ${features.length} features, ${ux.length} UX, ${other.length} other)
- Average importance score: **${avgImportance}/10**
- Quick wins identified (importance ≥ 7, complexity ≤ 5): **${quickWins.length}**

---

## 🔴 Critical Bugs (importance ≥ 8)

${critical.length === 0 ? '*None this week.*' : `| Issue | Title | Importance | Effort | Action |
|---|---|---|---|---|
${critical.map(issueRow).join('\n')}`}

---

## ⚡ Quick Wins — Best Impact/Effort Ratio

${sprintList.length === 0 ? '*None this week.*' : `| Issue | Title | Importance | Effort | Action |
|---|---|---|---|---|
${sprintList.slice(0, 10).map(issueRow).join('\n')}`}

---

## 💡 Most Requested Features

${featureRequests.length === 0 ? '*None this week.*' : `| Issue | Title | Importance | Effort | Action |
|---|---|---|---|---|
${featureRequests.slice(0, 8).map(issueRow).join('\n')}`}

---

## 📊 All Issues — Priority Ranking

| Issue | Title | Category | Importance | Complexity | Score | Sprint |
|---|---|---|---|---|---|---|
${byPriority.map(r => `| [#${r.issue.number}](https://github.com/${FEEDBACK_REPO}/issues/${r.issue.number}) | ${r.issue.title.slice(0,40)} | ${r.cls.category} | ${r.cls.importance} | ${r.cls.complexity} | ${r.cls.priority_score} | ${r.cls.sprint_candidate ? '✅' : ''} |`).join('\n')}

---

## 🎯 Recommended Sprint (next v0.x)

Actions in priority order:
${sprintList.slice(0, 8).map((r, i) => `${i+1}. [#${r.issue.number}](https://github.com/${FEEDBACK_REPO}/issues/${r.issue.number}) — ${r.issue.title} (${r.cls.importance}/10 importance, ${r.cls.estimated_effort})`).join('\n')}

---
*Generated by feedback-agent.js — ${now.toISOString()}*
`

  const reportPath = join(__dirname, 'feedback-report.md')
  writeFileSync(reportPath, report, 'utf-8')
  console.log(`\n📄 Report written to scripts/feedback-report.md`)
  console.log(`   ${enriched.length} issues | ${critical.length} critical | ${sprintList.length} sprint candidates`)
}

// === MAIN ===

async function main() {
  console.log('🎛  Noir Feedback Agent starting...')
  console.log(`   Repo: ${FEEDBACK_REPO}`)
  console.log(`   Date: ${new Date().toISOString()}`)

  const unprocessed = await fetchUnprocessedIssues()

  if (unprocessed.length === 0) {
    console.log('\n✅ All issues already processed. Nothing to do.')
    return
  }

  console.log(`\n🧠 Classifying ${unprocessed.length} issues with Claude...`)

  const results = []

  for (const issue of unprocessed) {
    console.log(`  → #${issue.number}: ${issue.title.slice(0, 60)}`)
    const cls = await classifyIssue(issue)
    if (cls) {
      await updateIssue(issue, cls)
      results.push({ issue, cls })
    } else {
      results.push(null)
    }
    // Rate limiting poli
    await new Promise(r => setTimeout(r, 300))
  }

  await generateReport(unprocessed, results)

  console.log('\n✅ Done!')
}

main().catch(err => {
  console.error('❌ Fatal error:', err)
  process.exit(1)
})

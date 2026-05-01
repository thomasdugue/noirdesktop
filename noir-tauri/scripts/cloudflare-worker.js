/**
 * Noir Worker — Cloudflare proxy multi-route.
 *
 * Routes :
 *   POST /            (legacy, racine) → feedback in-app → GitHub Issue (noir-feedback)
 *   POST /feedback    → identique (alias propre, recommandé)
 *   GET  /sentry/issues → proxy vers Sentry API (contourne CORS browser-side)
 *
 * Déploiement initial :
 *   cd scripts
 *   npm install -g wrangler
 *   wrangler login
 *   wrangler deploy
 *
 * Configuration des secrets (à ne JAMAIS commiter — uniquement via wrangler) :
 *   wrangler secret put GITHUB_TOKEN        ← PAT GitHub avec issues:write sur noir-feedback
 *   wrangler secret put NOIR_SECRET         ← random openssl rand -hex 32 (auth feedback)
 *   wrangler secret put SENTRY_AUTH_TOKEN   ← User Auth Token Sentry (event:read + project:read)
 *
 * Après déploiement, mets à jour scripts/.env.local de l'app desktop :
 *   NOIR_WORKER_URL    = https://noir-feedback.<sub>.workers.dev
 *   NOIR_WORKER_SECRET = le secret openssl
 *
 * Côté dashboard browser : pas de token côté client — le worker s'auth tout seul.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Noir-Secret',
  'Access-Control-Max-Age': '86400',
}

const SENTRY_ORG = 'hean-app'
const SENTRY_PROJECT = 'rust'
const SENTRY_API_BASE = 'https://de.sentry.io/api/0'

export default {
  async fetch(request, env) {
    // CORS preflight global
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS })
    }

    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') // trim trailing slash

    // ── Route : GET /sentry/issues ──
    if (request.method === 'GET' && path === '/sentry/issues') {
      return handleSentryIssues(request, env)
    }

    // ── Route : GET /sentry/issue/{shortId} ──
    // Récupère le détail d'une issue Sentry (metadata + dernière stack trace)
    // Utilisé par sprint-planner.js pour générer un plan d'implémentation.
    const issueMatch = path.match(/^\/sentry\/issue\/([A-Z][A-Z0-9]*-\d+)$/i)
    if (request.method === 'GET' && issueMatch) {
      return handleSentryIssueDetail(request, env, issueMatch[1].toUpperCase())
    }

    // ── Route : POST /feedback (ou racine, legacy) ──
    if (request.method === 'POST' && (path === '' || path === '/feedback')) {
      return handleFeedback(request, env)
    }

    return new Response('Not found', { status: 404, headers: CORS_HEADERS })
  }
}

// ────────────────────────────────────────────────────────────────────
// Sentry proxy : forwarde GET vers Sentry's REST API avec le token
// stocké côté serveur. Évite le CORS "Invalid origin" depuis le browser.
// ────────────────────────────────────────────────────────────────────
async function handleSentryIssues(request, env) {
  if (!env.SENTRY_AUTH_TOKEN) {
    return jsonError(500, 'SENTRY_AUTH_TOKEN secret not configured on worker')
  }

  // Whitelist des params transmis (anti-injection / anti-misuse)
  const incoming = new URL(request.url).searchParams
  const allowed = new URLSearchParams()
  const passthrough = ['statsPeriod', 'query', 'limit', 'cursor', 'environment', 'sort']
  for (const k of passthrough) {
    const v = incoming.get(k)
    if (v) allowed.set(k, v)
  }
  // Defaults sensés si rien n'est passé
  if (!allowed.has('statsPeriod')) allowed.set('statsPeriod', '14d')
  if (!allowed.has('query'))       allowed.set('query', 'is:unresolved')
  if (!allowed.has('limit'))       allowed.set('limit', '50')

  const sentryUrl = `${SENTRY_API_BASE}/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/issues/?${allowed}`

  let upstream
  try {
    upstream = await fetch(sentryUrl, {
      headers: {
        'Authorization': `Bearer ${env.SENTRY_AUTH_TOKEN}`,
        'Accept': 'application/json',
        'User-Agent': 'Noir-Worker/1.0',
      },
    })
  } catch (e) {
    return jsonError(502, `Sentry fetch failed: ${e.message}`)
  }

  const body = await upstream.text()
  return new Response(body, {
    status: upstream.status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

// ────────────────────────────────────────────────────────────────────
// Sentry issue detail : pour un shortId (ex. RUST-1), retourne l'issue
// + le dernier event (avec stack trace). Utilisé pour générer des plans
// d'implémentation à partir de crashes Sentry.
// ────────────────────────────────────────────────────────────────────
async function handleSentryIssueDetail(request, env, shortId) {
  if (!env.SENTRY_AUTH_TOKEN) {
    return jsonError(500, 'SENTRY_AUTH_TOKEN secret not configured on worker')
  }

  const headers = {
    'Authorization': `Bearer ${env.SENTRY_AUTH_TOKEN}`,
    'Accept': 'application/json',
    'User-Agent': 'Noir-Worker/1.0',
  }

  // 1. Résoudre le shortId → numeric group ID
  const lookupUrl = `${SENTRY_API_BASE}/organizations/${SENTRY_ORG}/shortids/${shortId}/`
  let lookup
  try {
    const lookupRes = await fetch(lookupUrl, { headers })
    if (!lookupRes.ok) {
      const detail = await lookupRes.text()
      return jsonError(lookupRes.status, `Sentry shortId lookup failed: ${detail.slice(0, 200)}`)
    }
    lookup = await lookupRes.json()
  } catch (e) {
    return jsonError(502, `Sentry shortId lookup network error: ${e.message}`)
  }

  const groupId = lookup.groupId || lookup.group?.id
  if (!groupId) {
    return jsonError(404, `Sentry issue ${shortId} not found`)
  }

  // 2. Fetch issue detail + latest event en parallèle
  let issue, latestEvent
  try {
    const [issueRes, eventRes] = await Promise.all([
      fetch(`${SENTRY_API_BASE}/issues/${groupId}/`, { headers }),
      fetch(`${SENTRY_API_BASE}/issues/${groupId}/events/latest/`, { headers }),
    ])
    issue = issueRes.ok ? await issueRes.json() : null
    latestEvent = eventRes.ok ? await eventRes.json() : null
  } catch (e) {
    return jsonError(502, `Sentry detail fetch error: ${e.message}`)
  }

  if (!issue) {
    return jsonError(404, `Sentry issue ${shortId} (group ${groupId}) not accessible`)
  }

  // Extraire la stack trace la plus parlante du latestEvent
  let stackTrace = null
  if (latestEvent?.entries) {
    const exceptionEntry = latestEvent.entries.find(e => e.type === 'exception')
    if (exceptionEntry?.data?.values?.[0]?.stacktrace?.frames) {
      stackTrace = exceptionEntry.data.values[0].stacktrace.frames
        .slice(-10) // 10 dernières frames (les plus pertinentes)
        .map(f => `  at ${f.function || '?'} (${f.filename || '?'}:${f.lineNo || '?'})`)
        .join('\n')
    }
  }

  // Réponse compacte pour l'agent (pas tout le payload Sentry brut)
  return new Response(JSON.stringify({
    shortId: issue.shortId,
    title: issue.title,
    culprit: issue.culprit,
    level: issue.level,
    type: issue.type,
    status: issue.status,
    count: issue.count,
    userCount: issue.userCount,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    permalink: issue.permalink,
    metadata: issue.metadata,
    stackTrace,
    eventMessage: latestEvent?.message || null,
    eventTags: latestEvent?.tags || [],
    platform: latestEvent?.platform || null,
  }), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

// ────────────────────────────────────────────────────────────────────
// Feedback : POST → GitHub Issue (logic existante, inchangée)
// ────────────────────────────────────────────────────────────────────
async function handleFeedback(request, env) {
  // Valider le secret partagé
  const secret = request.headers.get('X-Noir-Secret')
  if (!secret || secret !== env.NOIR_SECRET) {
    console.error('Unauthorized feedback attempt')
    return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS })
  }

  let payload
  try {
    payload = await request.json()
  } catch {
    return new Response('Invalid JSON', { status: 400, headers: CORS_HEADERS })
  }

  if (!payload.title || typeof payload.title !== 'string') {
    return new Response('Missing title', { status: 400, headers: CORS_HEADERS })
  }

  const repo = env.FEEDBACK_REPO || 'thomasdugue/noir-feedback'

  const ghResponse = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'Noir-Feedback-Worker/1.0',
    },
    body: JSON.stringify({
      title: payload.title,
      body: payload.body,
      labels: payload.labels || ['beta'],
    }),
  })

  if (!ghResponse.ok) {
    const error = await ghResponse.text()
    console.error('GitHub API error:', error)
    return new Response(`GitHub error: ${ghResponse.status}`, { status: 502, headers: CORS_HEADERS })
  }

  return new Response('OK', {
    status: 200,
    headers: CORS_HEADERS,
  })
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

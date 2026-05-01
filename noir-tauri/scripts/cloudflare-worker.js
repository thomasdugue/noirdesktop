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

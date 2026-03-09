/**
 * Noir Feedback — Cloudflare Worker proxy
 *
 * Ce Worker sert d'intermédiaire entre l'app Noir et GitHub Issues API.
 * Le GitHub token N'est JAMAIS dans le binaire de l'app — uniquement dans
 * les secrets du Worker (côté Cloudflare).
 *
 * Déploiement (une seule fois) :
 *   cd scripts
 *   npm install -g wrangler
 *   wrangler login
 *   wrangler deploy
 *   wrangler secret put GITHUB_TOKEN   ← colle ton github_pat_...
 *   wrangler secret put NOIR_SECRET    ← génère un secret aléatoire (ex: openssl rand -hex 32)
 *
 * Après déploiement, récupère l'URL Worker (ex: https://noir-feedback.TON_USER.workers.dev)
 * et mets à jour launch.json :
 *   NOIR_WORKER_URL = https://noir-feedback.TON_USER.workers.dev
 *   NOIR_WORKER_SECRET = le secret que tu as défini
 *
 * Variables d'environnement (Worker secrets) :
 *   GITHUB_TOKEN   — ton fine-grained PAT GitHub (issues:write sur noir-feedback)
 *   NOIR_SECRET    — secret partagé app↔worker pour authentifier les requêtes
 *   FEEDBACK_REPO  — optionnel, défaut: thomasdugue/noir-feedback
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type, X-Noir-Secret',
        }
      })
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    // Valider le secret partagé
    const secret = request.headers.get('X-Noir-Secret')
    if (!secret || secret !== env.NOIR_SECRET) {
      console.error('Unauthorized feedback attempt')
      return new Response('Unauthorized', { status: 401 })
    }

    // Parser le payload
    let payload
    try {
      payload = await request.json()
    } catch {
      return new Response('Invalid JSON', { status: 400 })
    }

    // Valider le minimum requis
    if (!payload.title || typeof payload.title !== 'string') {
      return new Response('Missing title', { status: 400 })
    }

    const repo = env.FEEDBACK_REPO || 'thomasdugue/noir-feedback'

    // Transmettre à GitHub Issues API
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
      return new Response(`GitHub error: ${ghResponse.status}`, { status: 502 })
    }

    return new Response('OK', {
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*' }
    })
  }
}

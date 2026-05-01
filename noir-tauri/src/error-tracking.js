// error-tracking.js — Forwarder d'erreurs JS vers Sentry (côté Rust)
//
// Pas de SDK @sentry/browser embarqué (Hean n'a pas de bundler, et le SDK
// fait ~30KB minifié). À la place : on capture window.onerror et
// unhandledrejection, puis on forwarde vers la commande Tauri report_js_error
// qui appelle sentry::capture_event() côté Rust.
//
// Avantage : 1 seul DSN à configurer, 1 seul projet Sentry, 0 dépendance JS.

import { invoke } from './state.js'

// Anti-spam : ne pas envoyer 100 fois la même erreur (ex. si un setInterval
// boucle sur une exception). On dédoublonne par signature `message+source+line`
// pendant une fenêtre glissante de 5 secondes.
const RECENT_ERRORS = new Map() // signature → timestamp
const DEDUP_WINDOW_MS = 5000

function shouldReport(signature) {
  const now = Date.now()
  // Cleanup des anciennes entrées
  for (const [sig, ts] of RECENT_ERRORS) {
    if (now - ts > DEDUP_WINDOW_MS) RECENT_ERRORS.delete(sig)
  }
  if (RECENT_ERRORS.has(signature)) return false
  RECENT_ERRORS.set(signature, now)
  return true
}

function report(message, source, line, stack) {
  const signature = `${message}|${source || ''}|${line || 0}`
  if (!shouldReport(signature)) return

  // fire-and-forget — pas d'await, pas de toast utilisateur (silent)
  invoke('report_js_error', {
    message: String(message).slice(0, 1000),
    source: source ? String(source).slice(0, 500) : null,
    line: typeof line === 'number' ? line : null,
    stack: stack ? String(stack).slice(0, 4000) : null,
  }).catch((e) => {
    // Si invoke lui-même échoue (Tauri pas prêt, etc.) → log local seulement.
    // Surtout PAS de re-throw, sinon boucle infinie via unhandledrejection.
    console.error('[ERROR_TRACKING] forward failed:', e)
  })
}

export function initErrorTracking() {
  // Erreurs synchrones (script errors, throw dans un event handler, etc.)
  window.addEventListener('error', (event) => {
    const err = event.error
    const message = err?.message || event.message || 'Unknown error'
    const stack = err?.stack || null
    report(message, event.filename, event.lineno, stack)
  })

  // Promesses rejetées sans .catch()
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    let message
    let stack = null
    if (reason instanceof Error) {
      message = `Unhandled promise rejection: ${reason.message}`
      stack = reason.stack
    } else if (typeof reason === 'string') {
      message = `Unhandled promise rejection: ${reason}`
    } else {
      try {
        message = `Unhandled promise rejection: ${JSON.stringify(reason)}`
      } catch {
        message = 'Unhandled promise rejection: <unserializable>'
      }
    }
    report(message, null, null, stack)
  })

  console.log('[ERROR_TRACKING] window.onerror + unhandledrejection wired')
}

// Permet de logger manuellement une erreur applicative sans qu'elle remonte
// jusqu'à window.onerror. Utile pour les catch() où on swallow l'erreur mais
// on veut quand même savoir qu'elle se produit.
export function reportManualError(error, contextLabel = 'manual') {
  const message = error?.message || String(error)
  const stack = error?.stack || null
  report(`[${contextLabel}] ${message}`, null, null, stack)
}

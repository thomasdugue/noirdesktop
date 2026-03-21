// feedback.js — Système de feedback beta intégré
// Bouton flottant + modal + envoi vers GitHub Issues via commande Tauri

import { library, ui, playback } from './state.js'
import { invoke } from './state.js'
import { showToast } from './utils.js'

// === ÉTAT DU MODULE ===
let feedbackModalAbort = null
let isSending = false

// Lit la version de l'app dynamiquement via Tauri (même pattern que auto-update.js)
async function getAppVersion() {
  try {
    return await window.__TAURI__.app.getVersion()
  } catch {
    return '0.1.0'
  }
}

// === INIT ===

export function initFeedbackButton() {
  const btn = document.getElementById('feedback-btn')
  const modal = document.getElementById('feedback-modal')
  if (!btn || !modal) return

  btn.addEventListener('click', openFeedbackModal)
  initFeedbackForm()
}

// === OPEN / CLOSE ===

export function openFeedbackModal() {
  const modal = document.getElementById('feedback-modal')
  if (!modal) return

  resetFeedbackForm()
  modal.classList.remove('hidden')

  setTimeout(() => {
    const titleInput = document.getElementById('feedback-title')
    if (titleInput) titleInput.focus()
  }, 50)

  if (feedbackModalAbort) feedbackModalAbort.abort()
  feedbackModalAbort = new AbortController()
  const { signal } = feedbackModalAbort

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFeedbackModal()
  }, { signal })

  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) closeFeedbackModal()
  }, { signal })
}

export function closeFeedbackModal() {
  const modal = document.getElementById('feedback-modal')
  if (!modal) return

  modal.classList.add('hidden')

  if (feedbackModalAbort) {
    feedbackModalAbort.abort()
    feedbackModalAbort = null
  }
}

// === FORM HELPERS ===

function resetFeedbackForm() {
  const typeBug = document.getElementById('fb-type-bug')
  if (typeBug) typeBug.checked = true

  const title = document.getElementById('feedback-title')
  if (title) title.value = ''

  const titleCounter = document.getElementById('feedback-title-counter')
  if (titleCounter) titleCounter.textContent = '0/80'

  const desc = document.getElementById('feedback-description')
  if (desc) desc.value = ''

  const sevHigh = document.getElementById('fb-sev-high')
  if (sevHigh) sevHigh.checked = true

  const email = document.getElementById('feedback-email')
  if (email) email.value = ''

  updateSeverityVisibility('bug')
  setSendingState(false)
}

function updateSeverityVisibility(type) {
  const severityRow = document.getElementById('feedback-severity-row')
  if (!severityRow) return
  severityRow.style.display = (type === 'bug' || type === 'ux') ? 'flex' : 'none'
}

function setSendingState(sending) {
  isSending = sending
  const submitBtn = document.getElementById('feedback-submit')
  if (!submitBtn) return
  submitBtn.disabled = sending
  submitBtn.textContent = sending ? 'Sending...' : 'Send →'
}

// === SUBMIT ===

async function submitFeedback() {
  if (isSending) return

  const typeEl  = document.querySelector('input[name="fb-type"]:checked')
  const titleEl = document.getElementById('feedback-title')
  const descEl  = document.getElementById('feedback-description')
  const sevEl   = document.querySelector('input[name="fb-severity"]:checked')
  const emailEl = document.getElementById('feedback-email')

  const type        = typeEl?.value || 'bug'
  const title       = titleEl?.value.trim() || ''
  const description = descEl?.value.trim() || ''
  const severity    = sevEl?.value || 'high'
  const email       = emailEl?.value.trim() || ''

  // Validation
  if (!title) {
    titleEl?.focus()
    shake(titleEl)
    return
  }
  if (description.length < 10) {
    descEl?.focus()
    shake(descEl)
    return
  }

  // Contexte automatique capturé (version dynamique)
  const context = {
    app_version: await getAppVersion(),
    current_view: ui.currentView || 'unknown',
    library_size: library.tracks?.length || 0,
    is_playing: playback.audioIsPlaying || false,
    timestamp: new Date().toISOString(),
  }

  setSendingState(true)

  try {
    const result = await invoke('submit_feedback', {
      payload: {
        type,
        title,
        description,
        severity: type === 'bug' ? severity : null,
        email: email || null,
        context,
      }
    })
    closeFeedbackModal()
    const sentRemotely = result && !result.startsWith('Feedback saved locally')
    showToast(sentRemotely ? 'Feedback sent ✓' : 'Feedback saved ✓')
  } catch (err) {
    console.error('[FEEDBACK] submit error:', err)
    // Si l'erreur contient "saved locally but GitHub upload failed", le feedback
    // a quand même été enregistré — c'est un avertissement, pas une erreur fatale.
    const savedLocally = String(err).includes('saved locally')
    closeFeedbackModal()
    showToast(savedLocally ? 'Feedback saved (offline mode)' : `Error: ${err}`)
    if (!savedLocally) setSendingState(false)
  }
}

function shake(el) {
  if (!el) return
  el.classList.remove('feedback-shake')
  // Forcer le reflow pour que l'animation se rejoue
  void el.offsetWidth
  el.classList.add('feedback-shake')
  setTimeout(() => el.classList.remove('feedback-shake'), 500)
}

// === WIRING DOM ===

function initFeedbackForm() {
  // Type radio → toggle sévérité
  const typeRadios = document.querySelectorAll('input[name="fb-type"]')
  typeRadios.forEach(radio => {
    radio.addEventListener('change', () => updateSeverityVisibility(radio.value))
  })

  // Cancel
  const cancelBtn = document.getElementById('feedback-cancel')
  if (cancelBtn) cancelBtn.addEventListener('click', closeFeedbackModal)

  // Close (X button)
  const closeBtn = document.getElementById('feedback-close')
  if (closeBtn) closeBtn.addEventListener('click', closeFeedbackModal)

  // Submit
  const submitBtn = document.getElementById('feedback-submit')
  if (submitBtn) submitBtn.addEventListener('click', submitFeedback)

  // Char counter titre
  const titleInput = document.getElementById('feedback-title')
  const titleCounter = document.getElementById('feedback-title-counter')
  if (titleInput && titleCounter) {
    titleInput.addEventListener('input', () => {
      titleCounter.textContent = `${titleInput.value.length}/80`
    })
    // Submit on Enter
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        document.getElementById('feedback-description')?.focus()
      }
    })
  }

  // Submit on Cmd/Ctrl+Enter dans la description
  const descInput = document.getElementById('feedback-description')
  if (descInput) {
    descInput.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        submitFeedback()
      }
    })
  }
}

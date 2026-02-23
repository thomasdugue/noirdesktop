// eq.js — Égaliseur 8 bandes avec courbe SVG interactive

import { invoke } from './state.js';

// === CONSTANTES ===

const EQ_FREQS = [32, 64, 250, 1000, 2000, 4000, 8000, 16000]
const EQ_LABELS_JS = ['32', '64', '250', '1k', '2k', '4k', '8k', '16k']
const EQ_MIN_DB = -12
const EQ_MAX_DB = 12
const EQ_SVG_WIDTH = 280
const EQ_SVG_HEIGHT = 140
const EQ_MARGIN_X = 20
const EQ_GRAPH_WIDTH = EQ_SVG_WIDTH - 2 * EQ_MARGIN_X
const EQ_MARGIN_TOP = 10
const EQ_MARGIN_BOTTOM = 10
const EQ_GRAPH_HEIGHT = EQ_SVG_HEIGHT - EQ_MARGIN_TOP - EQ_MARGIN_BOTTOM

const EQ_PRESETS = {
  'Flat':       [0, 0, 0, 0, 0, 0, 0, 0],
  'Bass Boost': [6, 5, 3, 0, 0, 0, 0, 0],
  'Treble Boost': [0, 0, 0, 0, 1, 3, 5, 6],
  'Loudness':   [4, 3, 0, -1, -1, 0, 3, 4],
  'Vocal':      [-2, -1, 0, 3, 4, 2, 0, -1],
  'Rock':       [4, 3, 1, 0, -1, 1, 3, 4],
  'Jazz':       [3, 2, 0, 1, -1, -1, 1, 3],
  'Classical':  [0, 0, 0, 0, 0, -1, -2, -3],
  'Electronic': [5, 4, 1, 0, 0, 1, 3, 5],
  'Hip-Hop':    [5, 4, 2, 0, -1, 1, 0, 2],
  'Late Night': [3, 2, 0, -2, -2, 0, 1, 2],
}

// === ÉTAT PRIVÉ ===

let eqGains = new Float32Array(8)
let eqEnabled = false
let eqDraggingIndex = -1
let eqInitialized = false
let isEqPanelOpen = false

// Callbacks vers renderer.js pour fermer les autres panels
let panelCallbacks = {}

export function setEqPanelCallbacks(callbacks) {
  panelCallbacks = callbacks
}

// === FONCTIONS SVG ===

function eqDbToY(db) {
  const center = EQ_MARGIN_TOP + EQ_GRAPH_HEIGHT / 2
  return center - (db / EQ_MAX_DB) * (EQ_GRAPH_HEIGHT / 2)
}

function eqYToDb(y) {
  const center = EQ_MARGIN_TOP + EQ_GRAPH_HEIGHT / 2
  return -((y - center) / (EQ_GRAPH_HEIGHT / 2)) * EQ_MAX_DB
}

function eqFreqToX(index) {
  return EQ_MARGIN_X + (index / 7) * EQ_GRAPH_WIDTH
}

function eqBuildCurvePath(gains, closePath) {
  const points = gains.map((g, i) => ({ x: eqFreqToX(i), y: eqDbToY(g) }))
  let d = `M ${points[0].x},${points[0].y}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(i + 2, points.length - 1)]
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`
  }
  if (closePath) {
    const bottom = EQ_SVG_HEIGHT - EQ_MARGIN_BOTTOM
    d += ` L ${points[points.length - 1].x},${bottom} L ${points[0].x},${bottom} Z`
  }
  return d
}

function eqInitSVG() {
  const svg = document.getElementById('eq-curve-svg')
  if (!svg) return

  const ns = 'http://www.w3.org/2000/svg'
  svg.innerHTML = ''

  const dbLines = [-12, -6, 0, 6, 12]
  for (const db of dbLines) {
    const y = eqDbToY(db)
    const line = document.createElementNS(ns, 'line')
    line.setAttribute('x1', EQ_MARGIN_X)
    line.setAttribute('y1', y)
    line.setAttribute('x2', EQ_SVG_WIDTH - EQ_MARGIN_X)
    line.setAttribute('y2', y)
    line.setAttribute('class', db === 0 ? 'eq-zero-line' : 'eq-grid-line')
    svg.appendChild(line)

    if (db === -12 || db === 0 || db === 12) {
      const label = document.createElementNS(ns, 'text')
      label.setAttribute('x', EQ_MARGIN_X - 3)
      label.setAttribute('y', y + 3)
      label.setAttribute('text-anchor', 'end')
      label.setAttribute('class', 'eq-db-label')
      label.textContent = db > 0 ? `+${db}` : `${db}`
      svg.appendChild(label)
    }
  }

  for (let i = 0; i < 8; i++) {
    const x = eqFreqToX(i)
    const line = document.createElementNS(ns, 'line')
    line.setAttribute('x1', x)
    line.setAttribute('y1', EQ_MARGIN_TOP)
    line.setAttribute('x2', x)
    line.setAttribute('y2', EQ_SVG_HEIGHT - EQ_MARGIN_BOTTOM)
    line.setAttribute('class', 'eq-grid-line')
    svg.appendChild(line)
  }

  const fillPath = document.createElementNS(ns, 'path')
  fillPath.setAttribute('id', 'eq-curve-fill')
  fillPath.setAttribute('class', 'eq-curve-fill')
  fillPath.setAttribute('d', eqBuildCurvePath(eqGains, true))
  svg.appendChild(fillPath)

  const curvePath = document.createElementNS(ns, 'path')
  curvePath.setAttribute('id', 'eq-curve-path')
  curvePath.setAttribute('class', 'eq-curve-path')
  curvePath.setAttribute('d', eqBuildCurvePath(eqGains, false))
  svg.appendChild(curvePath)

  for (let i = 0; i < 8; i++) {
    const circle = document.createElementNS(ns, 'circle')
    circle.setAttribute('cx', eqFreqToX(i))
    circle.setAttribute('cy', eqDbToY(eqGains[i]))
    circle.setAttribute('r', 5)
    circle.setAttribute('class', 'eq-point')
    circle.setAttribute('data-band', i)
    circle.id = `eq-point-${i}`
    svg.appendChild(circle)
  }

  svg.addEventListener('mousedown', eqOnMouseDown)
  svg.addEventListener('mousemove', eqOnMouseMove)
  svg.addEventListener('mouseup', eqOnMouseUp)
  svg.addEventListener('mouseleave', eqOnMouseUp)
}

// === EVENT HANDLERS ===

function eqOnMouseDown(e) {
  const point = e.target.closest('.eq-point')
  if (!point) return
  eqDraggingIndex = parseInt(point.dataset.band)
  point.classList.add('dragging')
  e.preventDefault()
}

function eqOnMouseMove(e) {
  if (eqDraggingIndex < 0) return
  const svg = document.getElementById('eq-curve-svg')
  const rect = svg.getBoundingClientRect()
  const scaleY = EQ_SVG_HEIGHT / rect.height
  const y = (e.clientY - rect.top) * scaleY
  const db = Math.round(eqYToDb(y) * 2) / 2
  const clampedDb = Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, db))
  eqGains[eqDraggingIndex] = clampedDb
  eqUpdateCurve()
  eqUpdatePresetLabel()
}

function eqOnMouseUp() {
  if (eqDraggingIndex >= 0) {
    const point = document.getElementById(`eq-point-${eqDraggingIndex}`)
    if (point) point.classList.remove('dragging')
    eqDraggingIndex = -1
    eqSendGains()
  }
}

// === UPDATE FUNCTIONS ===

function eqUpdateCurve() {
  const curvePath = document.getElementById('eq-curve-path')
  const fillPath = document.getElementById('eq-curve-fill')
  if (curvePath) curvePath.setAttribute('d', eqBuildCurvePath(eqGains, false))
  if (fillPath) fillPath.setAttribute('d', eqBuildCurvePath(eqGains, true))
  for (let i = 0; i < 8; i++) {
    const circle = document.getElementById(`eq-point-${i}`)
    if (circle) {
      circle.setAttribute('cy', eqDbToY(eqGains[i]))
    }
  }
}

async function eqSendGains() {
  try {
    await invoke('set_eq_bands', { gains: Array.from(eqGains) })
  } catch (e) {
    console.error('[EQ] Error setting bands:', e)
  }
}

async function eqSetEnabled(enabled) {
  eqEnabled = enabled
  const checkbox = document.getElementById('eq-enabled-checkbox')
  if (checkbox) checkbox.checked = enabled
  eqUpdateStatusUI()
  eqUpdatePanelToggleLabel()
  try {
    await invoke('set_eq_enabled', { enabled })
  } catch (e) {
    console.error('[EQ] Error toggling EQ:', e)
  }
}

export function eqUpdateStatusUI() {
  const statusEl = document.getElementById('eq-mode-status')
  if (!statusEl) return
  if (eqEnabled) {
    const presetName = eqFindActivePreset()
    statusEl.textContent = presetName || 'Custom'
    statusEl.classList.add('active')
  } else {
    statusEl.textContent = 'Disabled'
    statusEl.classList.remove('active')
  }
}

function eqFindActivePreset() {
  for (const [name, preset] of Object.entries(EQ_PRESETS)) {
    if (name === 'Flat' && preset.every((g, i) => Math.abs(g - eqGains[i]) < 0.1)) return 'Flat'
    if (preset.every((g, i) => Math.abs(g - eqGains[i]) < 0.1)) return name
  }
  return null
}

function eqUpdatePresetLabel() {
  const labelEl = document.getElementById('eq-preset-label')
  if (!labelEl) return
  const presetName = eqFindActivePreset()
  labelEl.textContent = presetName || 'Custom'
  eqUpdateStatusUI()
  eqUpdatePanelToggleLabel()
}

function eqApplyPreset(name) {
  const preset = EQ_PRESETS[name]
  if (!preset) return
  for (let i = 0; i < 8; i++) {
    eqGains[i] = preset[i]
  }
  eqUpdateCurve()
  eqUpdatePresetLabel()
  eqSendGains()
  const dropdown = document.getElementById('eq-preset-dropdown')
  if (dropdown) dropdown.classList.add('hidden')
}

function eqBuildPresetDropdown() {
  const container = document.getElementById('eq-preset-dropdown')
  if (!container) return
  container.innerHTML = ''
  for (const name of Object.keys(EQ_PRESETS)) {
    const item = document.createElement('button')
    item.className = 'eq-preset-dropdown-item'
    item.dataset.preset = name
    item.textContent = name
    item.addEventListener('click', () => eqApplyPreset(name))
    container.appendChild(item)
  }
  eqUpdatePresetLabel()
}

// === PANEL OPEN/CLOSE ===

export function openEqPanel() {
  const panel = document.getElementById('eq-panel')
  if (!panel) return

  // Ferme les autres panels via callbacks
  panelCallbacks.closeOtherPanels?.()

  isEqPanelOpen = true
  panel.classList.add('open')
}

export function closeEqPanel() {
  const panel = document.getElementById('eq-panel')
  if (!panel) return
  isEqPanelOpen = false
  panel.classList.remove('open')
  const dropdown = document.getElementById('eq-preset-dropdown')
  if (dropdown) dropdown.classList.add('hidden')
}

export function toggleEqPanel() {
  if (isEqPanelOpen) {
    closeEqPanel()
  } else {
    openEqPanel()
  }
}

export function getEqPanelOpen() {
  return isEqPanelOpen
}

export function eqUpdatePanelToggleLabel() {
  const label = document.getElementById('eq-panel-enabled-label')
  if (!label) return
  if (eqEnabled) {
    const presetName = eqFindActivePreset()
    label.textContent = presetName || 'Custom'
    label.classList.add('active')
  } else {
    label.textContent = 'Disabled'
    label.classList.remove('active')
  }
}

// === INIT ===

export async function eqInit() {
  if (eqInitialized) return
  eqInitialized = true

  try {
    const state = await invoke('get_eq_state')
    eqEnabled = state.enabled
    for (let i = 0; i < Math.min(state.gains.length, 8); i++) {
      eqGains[i] = state.gains[i]
    }
  } catch (e) {
    console.log('[EQ] Could not load EQ state:', e)
  }

  const checkbox = document.getElementById('eq-enabled-checkbox')
  if (checkbox) checkbox.checked = eqEnabled
  eqUpdateStatusUI()
  eqUpdatePanelToggleLabel()

  eqInitSVG()
  eqBuildPresetDropdown()

  const eqInfoBtn = document.getElementById('eq-mode-info-btn')
  if (eqInfoBtn) {
    eqInfoBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleEqPanel()
    })
  }

  if (checkbox) {
    checkbox.addEventListener('change', () => {
      eqSetEnabled(checkbox.checked)
      eqUpdatePanelToggleLabel()
    })
  }

  const flatBtn = document.getElementById('eq-flat-btn')
  if (flatBtn) {
    flatBtn.addEventListener('click', () => eqApplyPreset('Flat'))
  }

  const presetDropdownBtn = document.getElementById('eq-preset-dropdown-btn')
  const presetDropdown = document.getElementById('eq-preset-dropdown')
  if (presetDropdownBtn && presetDropdown) {
    presetDropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      presetDropdown.classList.toggle('hidden')
    })
  }

  const closeBtn = document.getElementById('close-eq-panel')
  if (closeBtn) {
    closeBtn.addEventListener('click', closeEqPanel)
  }

  document.addEventListener('click', (e) => {
    if (presetDropdown && !presetDropdown.classList.contains('hidden')) {
      if (!e.target.closest('.eq-preset-dropdown-container')) {
        presetDropdown.classList.add('hidden')
      }
    }
  })
}

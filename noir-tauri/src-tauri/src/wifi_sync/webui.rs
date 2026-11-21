// wifi_sync/webui.rs — DAP-side WebUI (v3 — Noir DS 2026)
//
// Architecture: File System Access API (FSA) for direct disk writes — no
// ZIP, no per-file save prompt, no extraction step. The user picks a
// destination folder ONCE via `showDirectoryPicker()`; HEAN streams each
// track via `GET /file?album=...&path=<destRel>`, the JS pipes the bytes
// straight into a `FileSystemWritableFileStream`, and on success POSTs
// `/sync-mark` so the file is flagged as already-synced for next time.
//
// v3 design pass — Noir Design System compliant + 2026 trends:
//   * HEAN logo SVG inline in the header (white wordmark + BETA badge)
//   * Geist Mono numerals for stats, eyebrow labels, addresses
//   * White primary CTA per noir-btn-primary; green only for status
//   * Subtle mesh background, staggered mount, prefers-reduced-motion
//   * Per-album status badges: ON DAP / TO ADD / TO REMOVE
//   * Sticky sync progress bar at top (speed / files done / ETA) — replaces
//     the bottom toast that was hidden by the on-screen keyboard
//
// Folder persistence: the picked FileSystemDirectoryHandle is saved in
// IndexedDB. On reload, `tryRestoreDestination()` queries the permission;
// if still 'granted', the user is online without any prompt. If the grant
// has decayed to 'prompt' (browser restart / privacy timer), the welcome
// card morphs into a single-tap "Reconnect to <Folder>" button — Chrome
// remembers the picker `id: 'hean-music'` and re-opens the same folder.
//
// Manifest awareness: on first render after the folder is mounted, we walk
// the destination directory (one level deep — Artist/Album/) and build a
// loose-match Set of album folders that already exist on the DAP. The Set
// is intersected with the desktop's `albums[]` list to power 3 badge states:
//   - ON DAP   → server says alreadySynced=true (authoritative)
//   - TO ADD   → not synced
//   - TO REMOVE → folder exists on the DAP but matches no current selection
//
// Browser support:
//   * `showDirectoryPicker()` requires Chromium 86+, Edge 86+, Opera 72+.
//   * Safari and Firefox don't support it yet — those fall back to the
//     legacy `/album/:id.zip` route, which still works.
//
// Constraints kept from v2:
//   * No optional chaining (`?.`) — Chromium 79 still in some old DAPs.
//   * No top-level await.
//   * `device_uuid` persisted in localStorage so the server keeps a
//     stable per-device sync history.

/// The complete WebUI HTML. {{TOKEN}} is replaced at serve time.
pub const WEBUI_HTML: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="HEAN">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0a0a0a">
<link rel="manifest" href="data:application/manifest+json,%7B%22name%22%3A%22HEAN%20Sync%22%2C%22short_name%22%3A%22HEAN%22%2C%22start_url%22%3A%22%2F%22%2C%22display%22%3A%22standalone%22%2C%22background_color%22%3A%22%230a0a0a%22%2C%22theme_color%22%3A%22%230a0a0a%22%2C%22orientation%22%3A%22portrait%22%7D">
<title>HEAN Sync</title>
<style>
@font-face {
  font-family: 'Geist Mono';
  src: url('/font/geist-mono.woff2') format('woff2');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

:root {
  --color-bg: #0a0a0a;
  --color-bg-light: #111;
  --color-bg-lighter: #151515;
  --color-bg-surface: #1a1a1a;
  --color-bg-hover: #222;
  --color-border: #1f1f1f;
  --color-border-light: #2a2a2a;
  --color-border-lighter: #333;
  --color-text: #fff;
  --color-text-muted: #888;
  --color-text-faint: #555;
  --color-green: #4ade80;
  --color-red: #f87171;
  --color-amber: #fbbf24;
  --font-mono: 'Geist Mono', 'SF Mono', Menlo, Consolas, monospace;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --easing: cubic-bezier(.2, .65, .25, 1);
}

html, body {
  background: var(--color-bg);
  color: var(--color-text);
  overscroll-behavior: none;
}

body {
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.55;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  padding: 20px 16px 100px;
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  isolation: isolate;
}

button { font-family: inherit; font-size: inherit; }

/* ---------- background mesh ---------- */
.bg-mesh {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 60vh;
  background:
    radial-gradient(ellipse 60% 50% at 50% 0%, rgba(74, 222, 128, 0.05), transparent 60%),
    radial-gradient(ellipse 40% 30% at 20% 25%, rgba(255, 255, 255, 0.018), transparent 70%),
    radial-gradient(ellipse 40% 30% at 80% 25%, rgba(255, 255, 255, 0.018), transparent 70%);
  pointer-events: none;
  z-index: -1;
}

.app {
  width: 100%;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ---------- mount stagger ---------- */
.app > *:not(.banner):not(#sync-bar) {
  opacity: 0;
  transform: translateY(10px);
  animation: rise 0.55s var(--easing) forwards;
  animation-delay: calc(var(--stagger, 0) * 70ms + 80ms);
}
@keyframes rise {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ---------- sticky banners (top of viewport) ---------- */
.banner {
  position: sticky;
  top: 0;
  z-index: 100;
  background: #7f1d1d;
  border: 2px solid #dc2626;
  color: #fff;
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  margin-bottom: 8px;
  box-shadow: 0 8px 24px rgba(220, 38, 38, 0.3);
  animation: bannerSlideIn 0.25s ease-out;
}
@keyframes bannerSlideIn {
  from { opacity: 0; transform: translateY(-8px); }
  to   { opacity: 1; transform: translateY(0); }
}
.banner .banner-msg { flex: 1; min-width: 0; }
.banner .btn {
  width: auto;
  padding: 10px 16px;
  font-size: 11px;
  font-weight: 600;
  background: #fff;
  color: #7f1d1d;
  border: none;
  font-family: var(--font-mono);
  letter-spacing: 0.6px;
  text-transform: uppercase;
}

/* ---------- sticky sync progress bar (top, during sync) ---------- */
#sync-bar {
  position: sticky;
  top: 0;
  z-index: 90;
  background: rgba(10, 10, 10, 0.92);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-md);
  padding: 14px 16px 0;
  margin-bottom: 10px;
  overflow: hidden;
  animation: bannerSlideIn 0.3s var(--easing);
}
.sync-bar-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr auto;
  gap: 14px;
  align-items: center;
}
.sync-bar-stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.sync-bar-label {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--color-text-faint);
}
.sync-bar-value {
  font-family: var(--font-mono);
  font-size: 16px;
  font-weight: 500;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.3px;
}
.sync-bar-value .sync-bar-sep {
  color: var(--color-text-faint);
  margin: 0 2px;
}
#sync-bar-speed { color: var(--color-green); }
.sync-bar-cancel {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--color-text-muted);
  background: transparent;
  border: 1px solid var(--color-border-light);
  border-radius: 100px;
  padding: 8px 12px;
  cursor: pointer;
  transition: color 0.18s ease, border-color 0.18s ease, background 0.18s ease;
}
.sync-bar-cancel:hover {
  color: var(--color-red);
  border-color: rgba(248, 113, 113, 0.4);
  background: rgba(248, 113, 113, 0.06);
}
.sync-bar-current {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--color-text-faint);
  margin-top: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: 0.2px;
}
.sync-bar-progress {
  height: 2px;
  background: rgba(255, 255, 255, 0.06);
  margin: 12px -16px 0;
  position: relative;
}
.sync-bar-progress > div {
  height: 100%;
  background: linear-gradient(90deg, rgba(74, 222, 128, 0.6), var(--color-green));
  width: 0;
  transition: width 0.35s var(--easing);
  box-shadow: 0 0 8px rgba(74, 222, 128, 0.5);
}

/* ---------- reconnect banner (stale FSA handle) ---------- */
#reconnect-banner {
  position: sticky;
  top: 0;
  z-index: 95;
  background: rgba(248, 113, 113, 0.08);
  border: 1px solid rgba(248, 113, 113, 0.35);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 14px;
  animation: bannerSlideIn 0.3s var(--easing);
}
#reconnect-banner-msg {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--color-text);
  letter-spacing: 0.2px;
}
#reconnect-banner-msg strong {
  color: var(--color-red);
  font-weight: 600;
  display: block;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 1px;
  margin-bottom: 3px;
}
#btn-reconnect {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--color-text);
  background: var(--color-red);
  border: none;
  border-radius: 100px;
  padding: 10px 18px;
  cursor: pointer;
  white-space: nowrap;
  transition: filter 0.18s ease, transform 0.1s ease;
}
#btn-reconnect:hover { filter: brightness(1.15); }
#btn-reconnect:active { transform: scale(0.97); }

/* ---------- header (logo + connection pill) ---------- */
.hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
  --stagger: 0;
}
.hdr-logo {
  display: flex;
  align-items: center;
  height: 26px;
}
.hdr-logo svg {
  height: 100%;
  width: auto;
  display: block;
}
.hdr-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 11px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--color-text-muted);
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--color-border);
  border-radius: 100px;
}
.hdr-pill .hdr-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-green);
  box-shadow: 0 0 8px rgba(74, 222, 128, 0.7);
  animation: dotPulse 2s ease-in-out infinite;
}
@keyframes dotPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.55; transform: scale(0.85); }
}

/* ---------- onboarding hero ---------- */
.onb {
  position: relative;
  background: var(--color-bg-light);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 28px 24px 26px;
  --stagger: 1;
  overflow: hidden;
}
.onb::before {
  content: '';
  position: absolute;
  top: 0;
  left: 14%;
  right: 14%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.10), transparent);
}
.onb-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 1.6px;
  text-transform: uppercase;
  color: var(--color-text-faint);
  padding: 5px 11px;
  border: 1px solid var(--color-border);
  border-radius: 100px;
  background: rgba(255, 255, 255, 0.015);
  margin-bottom: 16px;
}
.onb-eyebrow-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-green);
  box-shadow: 0 0 8px rgba(74, 222, 128, 0.7);
  animation: dotPulse 2s ease-in-out infinite;
}
.onb-title {
  font-family: var(--font-mono);
  font-size: 26px;
  font-weight: 300;
  letter-spacing: -0.9px;
  line-height: 1.1;
  margin: 0 0 10px;
  color: var(--color-text);
}
.onb-title-accent {
  background: linear-gradient(180deg, #ffffff 0%, #888 140%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.onb-text {
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-muted);
  margin: 0 0 22px;
}
.onb-text strong {
  color: var(--color-text);
  font-weight: 500;
}
.onb-meta {
  margin-top: 14px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--color-green);
  text-align: center;
  font-variant-numeric: tabular-nums;
}
#onb-fallback {
  margin-top: 14px;
  font-size: 11px;
  color: var(--color-text-faint);
  line-height: 1.6;
}

/* ---------- folder bar (after pick) ---------- */
.folder-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--color-bg-light);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  --stagger: 1;
}
.folder-bar-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: rgba(74, 222, 128, 0.08);
  color: var(--color-green);
  flex-shrink: 0;
}
.folder-bar-icon svg { width: 16px; height: 16px; }
.folder-bar-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.folder-bar-label {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--color-text-faint);
}
.folder-bar-name {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: -0.1px;
}
.folder-bar-change {
  padding: 8px 14px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--color-text-muted);
  background: transparent;
  border: 1px solid var(--color-border-light);
  border-radius: 100px;
  cursor: pointer;
  transition: color 0.18s ease, border-color 0.18s ease, background 0.18s ease;
}
.folder-bar-change:hover {
  color: var(--color-text);
  border-color: var(--color-border-lighter);
  background: rgba(255, 255, 255, 0.03);
}

/* ---------- summary stats card ---------- */
.summary {
  background: var(--color-bg-light);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 18px 8px;
  --stagger: 2;
}
.summary-grid {
  display: grid;
  grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr;
  align-items: center;
  gap: 0;
}
.summary-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
}
.summary-num {
  font-family: var(--font-mono);
  font-size: 26px;
  font-weight: 300;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.8px;
  line-height: 1;
}
.summary-num.green { color: var(--color-green); }
.summary-num.red   { color: var(--color-red);   }
.summary-num.muted { color: var(--color-text-muted); }
.summary-label {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--color-text-faint);
}
.summary-divider {
  width: 1px;
  height: 28px;
  background: var(--color-border);
}

/* ---------- primary CTA (white, Noir DS) ---------- */
.cta {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  padding: 16px 24px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: #0a0a0a;
  background: #fff;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  overflow: visible;
  transition:
    transform 0.18s var(--easing),
    box-shadow 0.25s ease,
    background 0.2s ease;
  box-shadow: 0 8px 24px -10px rgba(255, 255, 255, 0.22);
  --stagger: 3;
}
.cta:hover:not(:disabled) {
  transform: translateY(-2px);
  background: #f5f5f5;
  box-shadow:
    0 14px 36px -12px rgba(255, 255, 255, 0.30),
    0 0 0 1px rgba(255, 255, 255, 0.08);
}
.cta:hover:not(:disabled) .cta-arrow { transform: translateX(4px); }
.cta:hover:not(:disabled) .cta-glow {
  opacity: 1;
  transform: scale(1.18);
}
.cta:active:not(:disabled) {
  transform: translateY(0) scale(0.98);
  transition-duration: 0.08s;
}
.cta:disabled {
  cursor: not-allowed;
  background: #2a2a2a;
  color: var(--color-text-faint);
  box-shadow: none;
}
.cta-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-green);
  box-shadow: 0 0 10px rgba(74, 222, 128, 0.7);
  flex-shrink: 0;
}
.cta:disabled .cta-dot {
  background: var(--color-text-faint);
  box-shadow: none;
}
.cta.is-syncing .cta-dot {
  animation: ctaPulse 1.1s ease-in-out infinite;
}
@keyframes ctaPulse {
  0%, 100% { opacity: 1;   transform: scale(1);   }
  50%      { opacity: 0.35; transform: scale(0.7); }
}
.cta-arrow {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  transition: transform 0.25s var(--easing);
}
.cta-glow {
  position: absolute;
  inset: -2px;
  border-radius: 12px;
  background: radial-gradient(ellipse at center, rgba(255, 255, 255, 0.18), transparent 65%);
  opacity: 0;
  transform: scale(0.95);
  transition: opacity 0.3s ease, transform 0.3s var(--easing);
  pointer-events: none;
  z-index: -1;
}
.cta svg { width: 14px; height: 14px; flex-shrink: 0; }

/* ---------- albums list ---------- */
.albums {
  background: var(--color-bg-light);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  --stagger: 4;
}
.albums-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border);
}
.albums-hdr-title {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  color: var(--color-text-faint);
}
.albums-hdr-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.album {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
  transition: background 0.18s ease;
}
.album:last-child { border-bottom: none; }
.album:hover { background: rgba(255, 255, 255, 0.015); }

.album-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.album-title {
  font-family: var(--font-sans);
  font-size: 13.5px;
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: -0.1px;
}
.album-meta {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: 0.1px;
}
.album.is-synced .album-title { color: var(--color-text-muted); }
.album.is-synced .album-meta  { color: var(--color-text-faint); }
.album.is-active { background: rgba(74, 222, 128, 0.04); }

/* ---------- album status badges (right column) ---------- */
.album-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  border-radius: 100px;
  white-space: nowrap;
  border: 1px solid transparent;
  transition: background 0.18s ease, border-color 0.18s ease;
}
.album-badge-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
}
.album-badge.on-dap {
  color: var(--color-green);
  background: rgba(74, 222, 128, 0.08);
  border-color: rgba(74, 222, 128, 0.18);
}
.album-badge.on-dap .album-badge-dot {
  background: var(--color-green);
  box-shadow: 0 0 6px rgba(74, 222, 128, 0.6);
}
.album-badge.to-add {
  color: var(--color-text-muted);
  background: rgba(255, 255, 255, 0.025);
  border-color: var(--color-border);
}
.album-badge.to-add .album-badge-dot {
  background: var(--color-text-faint);
}
.album-badge.to-remove {
  color: var(--color-red);
  background: rgba(248, 113, 113, 0.08);
  border-color: rgba(248, 113, 113, 0.18);
}
.album-badge.to-remove .album-badge-dot {
  background: var(--color-red);
  box-shadow: 0 0 6px rgba(248, 113, 113, 0.5);
}
.album-badge.active {
  color: var(--color-text);
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.18);
}
.album-badge .spinner {
  width: 10px;
  height: 10px;
  border: 1.4px solid rgba(255, 255, 255, 0.18);
  border-top-color: var(--color-text);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.empty, .error {
  padding: 36px 16px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--color-text-faint);
  text-transform: uppercase;
}
.error { color: var(--color-red); }

/* ---------- settings ---------- */
.settings {
  background: var(--color-bg-light);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  --stagger: 5;
}
.settings summary {
  cursor: pointer;
  list-style: none;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  color: var(--color-text-faint);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.settings summary::-webkit-details-marker { display: none; }
.settings summary::after {
  content: '+';
  font-size: 14px;
  color: var(--color-text-muted);
  transition: transform 0.2s ease;
  font-weight: 400;
}
.settings[open] summary::after { content: '−'; }
.settings-body {
  padding-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.settings-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: var(--color-text-muted);
  gap: 12px;
  padding: 4px 0;
}
.settings-row .lbl {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--color-text-faint);
}
.settings-row .val {
  font-family: var(--font-mono);
  color: var(--color-text-muted);
  font-size: 10.5px;
  word-break: break-all;
  text-align: right;
  letter-spacing: 0.1px;
}
.settings-btn {
  width: 100%;
  padding: 11px 14px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: var(--color-text);
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-light);
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease;
}
.settings-btn:hover {
  background: var(--color-bg-hover);
  border-color: var(--color-border-lighter);
}
.settings-btn-danger {
  color: var(--color-red);
  border-color: rgba(248, 113, 113, 0.18);
}
.settings-btn-danger:hover {
  background: rgba(248, 113, 113, 0.06);
  border-color: rgba(248, 113, 113, 0.32);
}

.hidden { display: none !important; }

/* ---------- locked state ---------- */
.locked .albums { opacity: 0.4; filter: saturate(0.3); }
.locked .album { pointer-events: none; }

/* ---------- small responsive ---------- */
@media (max-width: 380px) {
  body { padding: 14px 12px 80px; }
  .onb-title { font-size: 22px; }
  .summary-num { font-size: 22px; }
  .summary { padding: 16px 4px; }
  .sync-bar-value { font-size: 14px; }
  .sync-bar-label { font-size: 8.5px; }
}

/* ---------- reduced motion ---------- */
@media (prefers-reduced-motion: reduce) {
  .app > * {
    animation: none !important;
    opacity: 1 !important;
    transform: none !important;
  }
  .hdr-pill .hdr-dot,
  .onb-eyebrow-dot,
  .cta.is-syncing .cta-dot {
    animation: none !important;
  }
  #sync-bar { animation: none !important; }
}

/* ============================================================
 *  Debug panel — on-screen log viewer (for DAPs without devtools)
 * ============================================================ */
#dbg-panel {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  max-height: 45vh;
  background: rgba(0, 0, 0, 0.94);
  border-top: 1px solid #333;
  color: #9f9;
  font-family: 'Geist Mono', 'Menlo', monospace;
  font-size: 10px;
  line-height: 1.35;
  z-index: 99999;
  display: flex;
  flex-direction: column;
  transition: max-height 150ms ease;
}
#dbg-panel.collapsed { max-height: 30px; }
#dbg-panel-head {
  flex: 0 0 30px;
  padding: 0 12px;
  color: #fff;
  background: #111;
  border-bottom: 1px solid #222;
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
#dbg-panel-count {
  background: #2a2a2a;
  color: #fff;
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 10px;
  min-width: 18px;
  text-align: center;
}
#dbg-panel-count.has-errors { background: #f87171; color: #000; }
#dbg-panel-clear {
  margin-left: auto;
  background: #222;
  border: 1px solid #444;
  color: #fff;
  padding: 3px 10px;
  font-size: 10px;
  font-family: inherit;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  cursor: pointer;
  border-radius: 2px;
}
#dbg-panel-clear:active { background: #333; }
#dbg-panel-log {
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 6px 12px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  -webkit-overflow-scrolling: touch;
}
#dbg-panel.collapsed #dbg-panel-log { display: none; }
.dbg-err { color: #ff8a8a; display: block; }
.dbg-warn { color: #ffd080; display: block; }
.dbg-info { color: #9f9; display: block; }
</style>
</head>
<body>

<!-- Debug panel — tap header to expand, auto-opens on first error.
     Ships every console.warn/console.error to POST /debug/log so the
     Rust terminal sees them. Essential for DAPs where Chromium devtools
     can't be reached from the outside (e.g. FiiO JM21 webview). -->
<div id="dbg-panel" class="collapsed">
  <div id="dbg-panel-head">
    <span>DEBUG LOG</span>
    <span id="dbg-panel-count">0</span>
    <button id="dbg-panel-clear" type="button">clear</button>
  </div>
  <pre id="dbg-panel-log"></pre>
</div>

<div class="bg-mesh" aria-hidden="true"></div>

<div class="app" id="app-root">

  <!-- Restart / connectivity banner -->
  <div id="restart-banner" class="banner hidden">
    <div class="banner-msg" id="restart-banner-msg">HEAN was restarted. Refresh the page to reconnect.</div>
    <button class="btn" id="btn-refresh-page">Refresh</button>
  </div>

  <!-- Sticky sync progress bar (during sync) -->
  <div id="sync-bar" class="hidden" aria-live="polite">
    <div class="sync-bar-row">
      <div class="sync-bar-stat">
        <span class="sync-bar-label">Speed</span>
        <span class="sync-bar-value" id="sync-bar-speed">0 MB/s</span>
      </div>
      <div class="sync-bar-stat">
        <span class="sync-bar-label">Files</span>
        <span class="sync-bar-value">
          <span id="sync-bar-done">0</span><span class="sync-bar-sep">/</span><span id="sync-bar-total">0</span>
        </span>
      </div>
      <div class="sync-bar-stat">
        <span class="sync-bar-label">ETA</span>
        <span class="sync-bar-value" id="sync-bar-eta">—</span>
      </div>
      <button id="sync-bar-cancel" class="sync-bar-cancel" type="button">Cancel</button>
    </div>
    <div class="sync-bar-current" id="sync-bar-current"></div>
    <div class="sync-bar-progress"><div id="sync-bar-fill"></div></div>
  </div>

  <!-- Reconnect banner (shown when FSA handle goes stale mid-sync) -->
  <div id="reconnect-banner" class="hidden" role="alert">
    <div id="reconnect-banner-msg">
      <strong>Folder connection lost</strong>
      Chromium dropped the folder connection. Tap reconnect and pick the same folder to resume.
    </div>
    <button id="btn-reconnect" type="button">Reconnect</button>
  </div>

  <!-- Header: HEAN logo + connection pill -->
  <header class="hdr">
    <div class="hdr-logo" aria-label="HEAN">
      <svg viewBox="0 0 1833 419" xmlns="http://www.w3.org/2000/svg" fill="none">
        <circle cx="163.837" cy="215.565" r="28.8367" fill="#fff"/>
        <path d="M198.166 215.108C191.941 194.602 173.449 186.729 165.21 186.729C165.668 203.054 164.844 237.811 165.21 244.402C187.181 244.402 196.335 223.805 198.166 215.108Z" fill="#fff"/>
        <circle cx="420.163" cy="215.566" r="28.8367" transform="rotate(-180 420.163 215.566)" fill="#fff"/>
        <path d="M385.834 216.023C392.059 236.529 410.551 244.402 418.79 244.402C418.332 228.077 419.156 193.32 418.79 186.729C396.819 186.729 387.665 207.327 385.834 216.023Z" fill="#fff"/>
        <rect x="198.166" y="151.942" width="58.5889" height="126.332" rx="29.2945" fill="#fff"/>
        <rect x="260.417" y="108" width="63.1662" height="212.385" rx="29.2945" fill="#fff"/>
        <rect x="327.245" y="151.942" width="58.5889" height="126.332" rx="29.2945" fill="#fff"/>
        <circle cx="292" cy="215.566" r="35.2449" fill="#0a0a0a"/>
        <path d="M199.082 214.974C203.933 205.143 236.921 192.185 255.84 214.974C241.481 235.35 204.903 228.826 199.082 214.974Z" fill="#0a0a0a"/>
        <path d="M328.16 214.974C333.011 205.143 365.999 192.185 384.918 214.974C370.559 235.35 333.981 228.826 328.16 214.974Z" fill="#0a0a0a"/>
        <path d="M548.64 289V154.1H568.59V219.08L559.66 211.86H630.34L621.41 219.08V154.1H641.36V289H621.41V223.26L630.34 230.48H559.66L568.59 223.26V289H548.64ZM708.546 289V154.1H791.386V172.91H728.496V212.24H789.106V230.48H728.496V270.19H792.906V289H708.546ZM850.212 289L889.732 154.1H915.572L955.092 289H934.382L902.652 174.81L870.922 289H850.212ZM872.252 253.85L878.332 235.42H926.972L933.052 253.85H872.252ZM1012.4 289V154.1H1036.72L1080.99 260.69V154.1H1100.56V289H1076.24L1031.97 182.41V289H1012.4Z" fill="#fff"/>
        <rect x="1242" y="133" width="448.514" height="167" rx="33.4" fill="#fff"/>
        <path d="M1316.13 247.05V184.377H1334.31C1341.2 184.377 1346.43 185.878 1350.02 188.879C1353.61 191.88 1355.41 196.059 1355.41 201.414C1355.41 204.003 1354.82 206.327 1353.64 208.387C1352.46 210.388 1350.73 212.006 1348.43 213.242C1346.2 214.419 1343.52 215.037 1340.4 215.096V214.566C1344.23 214.566 1347.43 215.213 1350.02 216.508C1352.67 217.744 1354.67 219.509 1356.03 221.804C1357.38 224.041 1358.06 226.659 1358.06 229.661C1358.06 235.192 1356.14 239.488 1352.32 242.548C1348.55 245.549 1343.26 247.05 1336.43 247.05H1316.13ZM1325.39 238.399H1336.52C1340.58 238.399 1343.58 237.605 1345.52 236.016C1347.46 234.368 1348.43 232.103 1348.43 229.219C1348.43 226.159 1347.4 223.776 1345.34 222.069C1343.34 220.363 1340.4 219.509 1336.52 219.509H1325.39V238.399ZM1325.39 210.947H1334.49C1338.37 210.947 1341.22 210.182 1343.05 208.652C1344.87 207.063 1345.79 204.856 1345.79 202.032C1345.79 199.148 1344.87 196.941 1343.05 195.411C1341.22 193.822 1338.37 193.028 1334.49 193.028H1325.39V210.947ZM1401.27 247.05V184.377H1439.76V193.116H1410.54V211.388H1438.7V219.862H1410.54V238.311H1440.47V247.05H1401.27ZM1500.1 247.05V193.116H1481.74V184.377H1527.64V193.116H1509.28V247.05H1500.1ZM1565.04 247.05L1583.4 184.377H1595.4L1613.76 247.05H1604.14L1589.4 193.999L1574.66 247.05H1565.04ZM1575.28 230.72L1578.1 222.158H1600.7L1603.52 230.72H1575.28Z" fill="#0a0a0a"/>
      </svg>
    </div>
    <div class="hdr-pill">
      <span class="hdr-dot"></span>
      <span>WiFi Sync</span>
    </div>
  </header>

  <!-- Onboarding hero (server connected, no folder picked OR perm decayed) -->
  <div id="onb-card" class="onb">
    <div class="onb-eyebrow">
      <span class="onb-eyebrow-dot"></span>
      <span id="onb-eyebrow-text">Setup // Choose folder</span>
    </div>
    <h1 class="onb-title" id="onb-title">
      Pick a destination<br>
      <span class="onb-title-accent" id="onb-title-accent">on this device</span>
    </h1>
    <p class="onb-text" id="onb-text">
      HEAN will write tracks straight into the folder you choose — no save prompts, files stream over WiFi.
    </p>
    <button id="btn-pick" class="cta" type="button">
      <span class="cta-glow"></span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="cta-label" id="btn-pick-label">Choose folder</span>
      <svg class="cta-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
    </button>
    <div class="onb-meta hidden" id="onb-meta"></div>
    <div id="onb-fallback" class="hidden">
      Android mode: HEAN will save one ZIP per album to your Downloads folder.
      Tap <strong>Sync</strong> to start.
      <button id="btn-zip-mode" class="settings-btn" style="margin-top:10px">Sync all now</button>
    </div>
  </div>

  <!-- Folder bar (after pick) -->
  <div id="folder-bar" class="folder-bar hidden">
    <div class="folder-bar-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    </div>
    <div class="folder-bar-info">
      <div class="folder-bar-label">Destination</div>
      <div class="folder-bar-name" id="folder-bar-name">—</div>
    </div>
    <button class="folder-bar-change" id="dest-change" type="button">Change</button>
  </div>

  <!-- Stats card -->
  <div id="summary-card" class="summary hidden">
    <div class="summary-grid">
      <div class="summary-cell">
        <span class="summary-num" id="sum-total">—</span>
        <span class="summary-label">Albums</span>
      </div>
      <div class="summary-divider"></div>
      <div class="summary-cell">
        <span class="summary-num green" id="sum-on-dap">—</span>
        <span class="summary-label">On DAP</span>
      </div>
      <div class="summary-divider"></div>
      <div class="summary-cell">
        <span class="summary-num" id="sum-to-add">—</span>
        <span class="summary-label">To add</span>
      </div>
      <div class="summary-divider"></div>
      <div class="summary-cell">
        <span class="summary-num red" id="sum-to-remove">—</span>
        <span class="summary-label">To remove</span>
      </div>
    </div>
  </div>

  <!-- Sync CTA -->
  <div id="action-card" class="hidden">
    <button class="cta" id="btn-sync" type="button">
      <span class="cta-glow"></span>
      <span class="cta-dot"></span>
      <span class="cta-label" id="btn-sync-label">Sync</span>
      <svg class="cta-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
    </button>
  </div>

  <!-- Library list -->
  <div id="albums-card" class="albums hidden">
    <div class="albums-hdr">
      <span class="albums-hdr-title">Library</span>
      <span class="albums-hdr-count" id="albums-count">—</span>
    </div>
    <div id="albums-list">
      <div class="empty">Loading…</div>
    </div>
  </div>

  <!-- Settings -->
  <details class="settings" id="settings-panel">
    <summary>Settings</summary>
    <div class="settings-body">
      <div class="settings-row">
        <span class="lbl">Device ID</span>
        <span class="val" id="set-device-uuid">—</span>
      </div>
      <div class="settings-row">
        <span class="lbl">Folder</span>
        <span class="val" id="set-dest-name">none picked</span>
      </div>
      <button class="settings-btn" id="btn-pick-2" type="button">Change folder</button>
      <button class="settings-btn settings-btn-danger" id="btn-reset" type="button">Reset sync history</button>
    </div>
  </details>
</div>

<script>
(function() {
  'use strict';

  // ============================================================
  //  Constants + state
  // ============================================================
  var TOKEN = '{{TOKEN}}';
  var BASE = location.origin;

  // Server data
  var albums = [];          // [{ id, artist, album, trackCount, totalBytes, alreadySynced }]
  var rootPrefix = 'HEAN';

  // Destination picker (FSA API)
  var destHandle = null;
  var destLabel = '';

  // Android Chromium WebView has a broken FSA cache invalidation: every
  // directory/file handle returned by getDirectoryHandle/getFileHandle
  // comes from a stale cache that cannot be refreshed from JS. We proved
  // this with 5 approaches (queryPermission, requestPermission,
  // entries().next() on destHandle, entries().next() on leaf album,
  // user-gesture re-pick). All 5 fail with the exact same
  // InvalidStateError cascade. Fiio JM21 is the reference device.
  //
  // The durable fix: on Android, skip FSA entirely and use the browser's
  // Capability gate — FSA is the primary (and only reliable) path on
  // Chromium Android WebView, including FiiO / Hiby / Shanling DAPs.
  // Files land on the microSD card via `showDirectoryPicker()`, which
  // is what users actually need — DAPs are used on-the-go and the
  // internal /Downloads folder is usually too small.
  var _ua = navigator.userAgent || '';
  console.log('[wifi-sync] ua=' + _ua);
  var fsaSupported =
    typeof window.showDirectoryPicker === 'function' &&
    typeof window.FileSystemDirectoryHandle === 'function';
  console.log('[wifi-sync] fsaSupported=' + fsaSupported);
  if (!fsaSupported) {
    // Only reached on Safari/Firefox/old Chromium. Synthetic label so
    // the folder-bar + album list render immediately (renderAll uses
    // `destHandle != null || !fsaSupported` as hasDest).
    destLabel = 'Downloads · ZIP per album';
  }

  // Sync orchestration
  var syncing = false;
  var cancelRequested = false;
  var statusTimer = null;

  // Throughput measurement
  var tputBytes = 0;
  var tputStartedAt = 0;
  var tputCurrentTrack = '';

  // File counters (for top sync bar)
  var totalFilesToSync = 0;
  var doneFilesCount = 0;

  // On-DAP awareness — built by walking the destination folder
  var dapAlbumKeys = null;   // Set<looseKey> of album folders found on the DAP
  var orphanAlbums = [];     // [{ artistFolder, albumFolder, looseKey }]

  // ============================================================
  //  Device UUID — stable per browser profile
  // ============================================================
  function getOrCreateDeviceUuid() {
    var key = 'hean_device_uuid';
    var uuid = localStorage.getItem(key);
    if (!uuid) {
      uuid = 'dap-' + Date.now().toString(36) + '-' +
             Math.random().toString(36).slice(2, 10) + '-' +
             Math.random().toString(36).slice(2, 10);
      localStorage.setItem(key, uuid);
    }
    return uuid;
  }
  var DEVICE_UUID = getOrCreateDeviceUuid();

  // ============================================================
  //  Debug log — ships console.warn / console.error to both an
  //  on-screen panel AND POST /debug/log so the Rust terminal sees
  //  them. The DAP (FiiO JM21) Chromium WebView doesn't expose
  //  devtools over ADB, so this is the only way we get errors out.
  // ============================================================
  var _origErr = (console.error && console.error.bind(console)) || function(){};
  var _origWarn = (console.warn && console.warn.bind(console)) || function(){};
  var _dbgCount = 0;
  var _dbgErrorCount = 0;
  function _dbgFmt(a) {
    if (a == null) return String(a);
    if (typeof a === 'string') return a;
    if (a instanceof Error) {
      var s = (a.name || 'Error') + ': ' + (a.message || '');
      if (a.stack) s += '\n' + a.stack;
      return s;
    }
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }
  function _dbgJoin(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(_dbgFmt(args[i]));
    return parts.join(' ');
  }
  function _dbgAppend(level, text) {
    var logEl = document.getElementById('dbg-panel-log');
    if (logEl) {
      var ts = new Date().toISOString().slice(11, 23);
      var line = '[' + ts + '] ' + level.toUpperCase() + ' ' + text + '\n';
      var span = document.createElement('span');
      span.className = level === 'error' ? 'dbg-err'
                      : level === 'warn' ? 'dbg-warn' : 'dbg-info';
      span.textContent = line;
      logEl.appendChild(span);
      // Cap the DOM at 500 lines so the panel stays light on the DAP.
      while (logEl.childNodes.length > 500) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    }
    _dbgCount++;
    if (level === 'error') _dbgErrorCount++;
    var cnt = document.getElementById('dbg-panel-count');
    if (cnt) {
      cnt.textContent = String(_dbgCount);
      if (_dbgErrorCount > 0) cnt.classList.add('has-errors');
    }
    // Auto-open on first error so the user doesn't miss it.
    if (level === 'error') {
      var panel = document.getElementById('dbg-panel');
      if (panel) panel.classList.remove('collapsed');
    }
    // Ship to the Rust terminal — fire-and-forget, no recursion.
    try {
      fetch(location.origin + '/debug/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: level, msg: text, device: DEVICE_UUID })
      }).catch(function(){});
    } catch (e) {}
  }
  console.error = function() {
    try { _origErr.apply(console, arguments); } catch (e) {}
    _dbgAppend('error', _dbgJoin(arguments));
  };
  console.warn = function() {
    try { _origWarn.apply(console, arguments); } catch (e) {}
    _dbgAppend('warn', _dbgJoin(arguments));
  };
  // Last-resort catch-all — anything uncaught still lands here.
  window.addEventListener('error', function(ev) {
    _dbgAppend('error',
      'window.onerror: ' + (ev.message || '(no message)') +
      ' @ ' + (ev.filename || '?') + ':' + (ev.lineno || 0));
  });
  window.addEventListener('unhandledrejection', function(ev) {
    _dbgAppend('error', 'unhandledrejection: ' + _dbgFmt(ev.reason));
  });
  // Wire up the panel UI. The script tag lives at the end of <body>
  // so the DOM is already parsed at this point, no DOMContentLoaded
  // wait needed (matches the existing $('btn-pick') pattern below).
  (function wireDbgPanel() {
    var head = document.getElementById('dbg-panel-head');
    var root = document.getElementById('dbg-panel');
    var clearBtn = document.getElementById('dbg-panel-clear');
    if (head && root) {
      head.addEventListener('click', function(e) {
        if (e.target === clearBtn) return;
        root.classList.toggle('collapsed');
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var logEl = document.getElementById('dbg-panel-log');
        if (logEl) logEl.innerHTML = '';
        _dbgCount = 0;
        _dbgErrorCount = 0;
        var cnt = document.getElementById('dbg-panel-count');
        if (cnt) {
          cnt.textContent = '0';
          cnt.classList.remove('has-errors');
        }
      });
    }
    // Seed a boot log so the user sees the channel is alive immediately.
    _dbgAppend('info', 'debug panel ready — device=' + DEVICE_UUID.slice(0, 16));
  })();

  // ============================================================
  //  Helpers
  // ============================================================
  function $(id) { return document.getElementById(id); }

  function authQuery(extra) {
    var q = '?token=' + encodeURIComponent(TOKEN) +
            '&device=' + encodeURIComponent(DEVICE_UUID);
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) {
          q += '&' + k + '=' + encodeURIComponent(extra[k]);
        }
      }
    }
    return q;
  }

  function formatBytes(b) {
    if (!b || b === 0) return '0 B';
    var u = ['B','KB','MB','GB','TB'];
    var i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
  }

  function formatSpeed(bps) {
    if (!bps || bps < 1) return '0 B/s';
    var mb = bps / (1024 * 1024);
    if (mb >= 1) return mb.toFixed(1) + ' MB/s';
    var kb = bps / 1024;
    return kb.toFixed(0) + ' KB/s';
  }

  // ETA smoothing — early in the transfer, instantaneous bps swings wildly.
  // We display friendly placeholders instead of misleading numbers.
  function formatEta(remainingBytes, bps) {
    var elapsed = (Date.now() - tputStartedAt) / 1000;
    if (elapsed < 5) return 'Starting…';
    if (!bps || bps < 50 * 1024) return 'Starting…';
    if (!remainingBytes) return '—';
    var s = remainingBytes / bps;
    if (s < 5) return 'Almost done';
    if (s < 60) return Math.ceil(s) + 's';
    if (s < 3600) return Math.ceil(s / 60) + 'm';
    return (s / 3600).toFixed(1) + 'h';
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Loose-match key — strips non-alphanumerics + lowercases.
  // Used to compare desktop album metadata against on-disk folder names
  // without needing exact parity with the Rust sanitize_filename function.
  function looseKey(s) {
    if (s == null) return '';
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  // ============================================================
  //  IndexedDB persistence for the picked FileSystemDirectoryHandle
  // ============================================================
  var IDB_NAME = 'hean-wifi-sync';
  var IDB_STORE = 'handles';

  function idbOpen() {
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function() { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = function() { resolve(req.result); };
      req.onerror = function() { reject(req.error); };
    });
  }
  function idbPut(key, value) {
    return idbOpen().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function() { reject(tx.error); };
      });
    });
  }
  function idbGet(key) {
    return idbOpen().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = function() { resolve(req.result); };
        req.onerror = function() { reject(req.error); };
      });
    });
  }
  function idbDel(key) {
    return idbOpen().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function() { reject(tx.error); };
      });
    });
  }

  // ============================================================
  //  Destination picker
  // ============================================================
  function pickDestination() {
    if (!fsaSupported) {
      $('onb-fallback').classList.remove('hidden');
      return Promise.resolve(null);
    }
    return window.showDirectoryPicker({ id: 'hean-music', mode: 'readwrite', startIn: 'music' })
      .then(function(handle) {
        return handle.requestPermission({ mode: 'readwrite' }).then(function(p) {
          if (p !== 'granted') throw new Error('Permission not granted');
          destHandle = handle;
          destLabel = handle.name;
          // Persist label separately so we can show it as a "Reconnect" hint
          // even if the handle's permission decays back to 'prompt' on reload.
          try { localStorage.setItem('hean_dest_label', handle.name); } catch (e) {}
          return idbPut('dest', handle).then(function() {
            // Best-effort: ask the browser to mark our origin's storage as
            // persistent. This signals importance and reduces eviction risk.
            if (navigator.storage && navigator.storage.persist) {
              navigator.storage.persist().catch(function() {});
            }
            return walkDestForOnDap().then(function() { return handle; });
          });
        });
      })
      .catch(function(err) {
        if (err && err.name === 'AbortError') return null;
        console.error('Picker failed:', err);
        return null;
      });
  }

  // Restore — query permission, fall back to label-only hint if decayed.
  function tryRestoreDestination() {
    if (!fsaSupported) return Promise.resolve(null);
    try {
      var savedLabel = localStorage.getItem('hean_dest_label');
      if (savedLabel) destLabel = savedLabel;
    } catch (e) {}
    return idbGet('dest').then(function(handle) {
      if (!handle) return null;
      return handle.queryPermission({ mode: 'readwrite' }).then(function(p) {
        if (p === 'granted') {
          destHandle = handle;
          destLabel = handle.name;
          // Re-walk on every load to catch external changes (e.g. user
          // moved files via Finder/file manager).
          return walkDestForOnDap().then(function() { return handle; });
        }
        // Permission decayed: keep label, picker will resume same folder.
        return null;
      });
    }).catch(function() { return null; });
  }

  // Walk the destination folder ONE level deep to discover what's already
  // on the DAP. Builds a Set of looseKey(album folder name) so the album
  // list can show "On DAP" badges and a Set of artist+album orphans (folders
  // with no matching desktop album → "To remove").
  //
  // Why one level deep: the on-disk layout is `<picked>/HEAN/<Artist>/<Album>/track.flac`.
  // We don't need to enumerate every file — just the album folders.
  function walkDestForOnDap() {
    if (!destHandle) return Promise.resolve();
    dapAlbumKeys = new Set();
    orphanAlbums = [];
    // If the user picked the rootPrefix folder itself (e.g. they picked
    // "HEAN" directly instead of its parent), walk it directly. Otherwise
    // descend one level into rootPrefix.
    if (destHandle.name === rootPrefix) {
      return walkArtists(destHandle).catch(function() { return null; });
    }
    return destHandle.getDirectoryHandle(rootPrefix, { create: false }).then(function(rootDir) {
      return walkArtists(rootDir);
    }).catch(function() {
      // No HEAN/ folder yet — nothing on the DAP. Not an error.
      return null;
    });
  }

  function walkArtists(rootDir) {
    var promises = [];
    var entries = rootDir.entries ? rootDir.entries() : null;
    if (!entries) return Promise.resolve();

    function consume(it) {
      return it.next().then(function(res) {
        if (res.done) return;
        var entry = res.value;  // [name, handle]
        var artistName = entry[0];
        var artistHandle = entry[1];
        if (artistHandle.kind === 'directory') {
          promises.push(walkAlbums(artistName, artistHandle));
        }
        return consume(it);
      });
    }
    return consume(entries).then(function() { return Promise.all(promises); });
  }

  function walkAlbums(artistName, artistHandle) {
    var entries = artistHandle.entries ? artistHandle.entries() : null;
    if (!entries) return Promise.resolve();
    function consume(it) {
      return it.next().then(function(res) {
        if (res.done) return;
        var entry = res.value;
        var albumName = entry[0];
        var albumHandle = entry[1];
        if (albumHandle.kind === 'directory') {
          var key = looseKey(artistName) + '||' + looseKey(albumName);
          dapAlbumKeys.add(key);
          // Also add an album-only key as a softer fallback (some apps
          // reorganize artist folders).
          dapAlbumKeys.add('*||' + looseKey(albumName));
          orphanAlbums.push({
            artistFolder: artistName,
            albumFolder: albumName,
            looseKey: key
          });
        }
        return consume(it);
      });
    }
    return consume(entries);
  }

  // True if the album folder exists in the picked destination (even if
  // the server's per-device sync DB doesn't know about it). The desktop
  // server is the authoritative source for "synced" only when this device
  // has actually been used before; for a fresh DAP browser profile we
  // need to fall back to physical folder presence.
  function isAlbumOnDap(a) {
    if (!a) return false;
    if (a.alreadySynced) return true;
    if (!dapAlbumKeys) return false;
    var k1 = looseKey(a.artist) + '||' + looseKey(a.album);
    var k2 = '*||' + looseKey(a.album);
    return dapAlbumKeys.has(k1) || dapAlbumKeys.has(k2);
  }

  // Strip orphans that match a desktop album (any sanitisation discrepancy
  // forgiven via the *||album fallback).
  function computeOrphans() {
    if (!dapAlbumKeys) return [];
    var matched = new Set();
    for (var i = 0; i < albums.length; i++) {
      var a = albums[i];
      var k1 = looseKey(a.artist) + '||' + looseKey(a.album);
      var k2 = '*||' + looseKey(a.album);
      matched.add(k1);
      matched.add(k2);
    }
    var orphans = [];
    for (var j = 0; j < orphanAlbums.length; j++) {
      var o = orphanAlbums[j];
      if (!matched.has(o.looseKey) && !matched.has('*||' + looseKey(o.albumFolder))) {
        orphans.push(o);
      }
    }
    return orphans;
  }

  // ============================================================
  //  Subdir helpers (for the sync writes)
  // ============================================================
  // Walks a path segment chain from rootHandle, creating missing dirs.
  // After reaching the leaf, iterates entries() ONCE on the leaf to force
  // Chromium to perform a fresh readdir() on that directory's FD. This
  // rebuilds the leaf's inode cache before we try to create a file inside
  // it. (Per-level refresh was tried and made things WORSE — iterating
  // entries() on top-level handles seems to poison the cache instead of
  // refreshing it. Leaf-only is the empirically correct level.)
  function ensureSubdir(rootHandle, segments) {
    var p = Promise.resolve(rootHandle);
    segments.forEach(function(seg) {
      if (!seg || seg === '.' || seg === '..') return;
      p = p.then(function(parent) {
        return parent.getDirectoryHandle(seg, { create: true });
      });
    });
    return p.then(function(leaf) {
      return refreshDirCache(leaf).then(function() { return leaf; });
    });
  }

  // Force Chromium to re-read a directory's inode state from disk by
  // advancing its entries() async iterator once. Safe to call repeatedly.
  // Errors are swallowed — worst case the next operation fails and the
  // retry loop handles it.
  function refreshDirCache(dirHandle) {
    if (!dirHandle || typeof dirHandle.entries !== 'function') {
      return Promise.resolve();
    }
    try {
      var it = dirHandle.entries();
      var nextPromise;
      if (it && typeof it.next === 'function') {
        nextPromise = it.next();
      } else if (it && it[Symbol.asyncIterator]) {
        nextPromise = it[Symbol.asyncIterator]().next();
      } else {
        return Promise.resolve();
      }
      return Promise.resolve(nextPromise).catch(function() { return null; });
    } catch (e) {
      return Promise.resolve();
    }
  }

  function splitDestRel(prefixedRel) {
    var parts = prefixedRel.split('/').filter(function(s) { return s.length > 0; });
    if (parts.length === 0) return [[], 'unknown.bin'];
    var filename = parts.pop();
    return [parts, filename];
  }

  // ============================================================
  //  Liveness probe + restart banner
  // ============================================================
  var TOKEN_HASH_PREFIX = null;
  function pingServer() {
    return fetch(BASE + '/ping', { cache: 'no-store' })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        if (TOKEN_HASH_PREFIX == null) {
          TOKEN_HASH_PREFIX = data.tokenHash || '';
          return 'ok';
        }
        if (data.tokenHash && data.tokenHash !== TOKEN_HASH_PREFIX) {
          return 'stale';
        }
        return 'ok';
      })
      .catch(function() { return 'unreachable'; });
  }

  function showRestartBanner(state) {
    var banner = $('restart-banner');
    var msg = $('restart-banner-msg');
    if (state === 'ok') { banner.classList.add('hidden'); return; }
    if (state === 'stale') {
      msg.textContent = 'HEAN was restarted. Refresh the page to reconnect.';
    } else {
      msg.textContent = 'HEAN is unreachable. Check that your DAP is on the same WiFi network as HEAN.';
    }
    banner.classList.remove('hidden');
  }

  // ============================================================
  //  Status load + render
  // ============================================================
  function loadStatus() {
    return pingServer().then(function(state) {
      if (state !== 'ok') {
        showRestartBanner(state);
        renderAll();
        return;
      }
      showRestartBanner('ok');
      return fetch(BASE + '/status' + authQuery())
        .then(function(r) {
          if (r.status === 403) {
            showRestartBanner('stale');
            throw new Error('HTTP 403');
          }
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function(data) {
          albums = data.albums || [];
          rootPrefix = data.rootPrefix || 'HEAN';
          renderAll();
        })
        .catch(function(err) {
          console.error('Status fetch failed:', err);
          if (!err || !/403/.test(String(err.message))) {
            $('albums-list').innerHTML =
              '<div class="error">Connection error · ' + escapeHtml(err.message || err) + '</div>';
          }
        });
    });
  }

  function renderAll() {
    var hasDest = destHandle != null || !fsaSupported;

    $('app-root').classList.toggle('locked', !hasDest);

    // Onboarding hero card vs folder bar swap
    var onb = $('onb-card');
    var folderBar = $('folder-bar');
    var summaryCard = $('summary-card');
    var actionCard = $('action-card');
    var albumsCard = $('albums-card');

    if (hasDest) {
      onb.classList.add('hidden');
      folderBar.classList.remove('hidden');
      summaryCard.classList.remove('hidden');
      actionCard.classList.remove('hidden');
      albumsCard.classList.remove('hidden');
      $('folder-bar-name').textContent = destLabel || '—';
    } else {
      onb.classList.remove('hidden');
      folderBar.classList.add('hidden');
      summaryCard.classList.add('hidden');
      actionCard.classList.add('hidden');
      albumsCard.classList.add('hidden');

      // Hero copy adapts based on whether we have a saved label.
      var pickLabel = $('btn-pick-label');
      var titleAccent = $('onb-title-accent');
      var eyebrow = $('onb-eyebrow-text');
      var text = $('onb-text');
      if (destLabel) {
        $('onb-title').innerHTML =
          'Reconnect to<br><span class="onb-title-accent">' + escapeHtml(destLabel) + '</span>';
        if (text) text.innerHTML = 'Tap to resume — your browser remembers the folder, no second pick needed.';
        if (eyebrow) eyebrow.textContent = 'Setup // One tap to reconnect';
        if (pickLabel) pickLabel.textContent = 'Reconnect';
      } else {
        $('onb-title').innerHTML =
          'Pick a destination<br><span class="onb-title-accent">on this device</span>';
        if (text) text.innerHTML = 'HEAN will write tracks straight into the folder you choose — no save prompts, files stream over WiFi.';
        if (eyebrow) eyebrow.textContent = 'Setup // Choose folder';
        if (pickLabel) pickLabel.textContent = 'Choose folder';
      }
    }

    // Stats — an album counts as "On DAP" if EITHER the server's per-device
    // sync DB has it OR the folder physically exists in the picked
    // destination. The DB resets when the user wipes browser storage / picks
    // a fresh device UUID, but the folder on disk is the visual ground truth.
    var total = albums.length;
    var onDap = 0;
    var toAdd = 0;
    for (var i = 0; i < albums.length; i++) {
      if (isAlbumOnDap(albums[i])) onDap++;
      else toAdd++;
    }
    var orphans = hasDest ? computeOrphans() : [];

    $('sum-total').textContent = total;
    $('sum-on-dap').textContent = onDap;
    $('sum-to-add').textContent = toAdd;
    $('sum-to-remove').textContent = orphans.length;

    // Pre-pick "waiting" hint on the onboarding hero.
    var meta = $('onb-meta');
    if (!hasDest && total > 0) {
      var totalBytes = 0;
      for (var k = 0; k < albums.length; k++) totalBytes += (albums[k].totalBytes || 0);
      meta.textContent = total + ' album' + (total === 1 ? '' : 's') +
        ' (' + formatBytes(totalBytes) + ') waiting from HEAN';
      meta.classList.remove('hidden');
    } else {
      meta.classList.add('hidden');
    }

    // Sync CTA copy
    var btn = $('btn-sync');
    var btnLabel = $('btn-sync-label');
    btn.classList.remove('is-syncing');
    if (!hasDest) {
      btnLabel.textContent = 'Pick a folder first';
      btn.disabled = true;
    } else if (syncing) {
      btnLabel.textContent = 'Syncing…';
      btn.disabled = true;
      btn.classList.add('is-syncing');
    } else if (toAdd === 0 && orphans.length === 0) {
      btnLabel.textContent = 'All synced';
      btn.disabled = true;
    } else {
      var parts = [];
      if (toAdd > 0) parts.push('+' + toAdd);
      if (orphans.length > 0) parts.push('−' + orphans.length);
      btnLabel.textContent = 'Sync ' + parts.join(' / ');
      btn.disabled = false;
    }

    $('set-dest-name').textContent = destLabel || 'none picked';
    $('set-device-uuid').textContent = DEVICE_UUID;

    renderAlbums(orphans);
  }

  function renderAlbums(orphans) {
    var container = $('albums-list');
    if (albums.length === 0 && (!orphans || orphans.length === 0)) {
      container.innerHTML = '<div class="empty">No albums selected on the desktop</div>';
      $('albums-count').textContent = '';
      return;
    }
    var html = '';

    for (var i = 0; i < albums.length; i++) {
      var a = albums[i];
      var rowClass = '';
      var badgeHtml;
      if (isAlbumOnDap(a)) {
        badgeHtml = '<span class="album-badge on-dap"><span class="album-badge-dot"></span>On DAP</span>';
        rowClass = 'is-synced';
      } else {
        badgeHtml = '<span class="album-badge to-add"><span class="album-badge-dot"></span>To add</span>';
      }
      html +=
        '<div class="album ' + rowClass + '" data-album-id="' + escapeHtml(a.id) + '">' +
          '<div class="album-info">' +
            '<div class="album-title">' + escapeHtml(a.album || 'Unknown Album') + '</div>' +
            '<div class="album-meta">' + escapeHtml(a.artist || 'Unknown Artist') +
              ' · ' + (a.trackCount || 0) + ' tracks · ' +
              formatBytes(a.totalBytes || 0) + '</div>' +
          '</div>' +
          '<div class="album-badge-wrap">' + badgeHtml + '</div>' +
        '</div>';
    }

    // Orphan rows — folders on the DAP that no longer match any selection.
    if (orphans && orphans.length > 0) {
      for (var j = 0; j < orphans.length; j++) {
        var o = orphans[j];
        html +=
          '<div class="album">' +
            '<div class="album-info">' +
              '<div class="album-title">' + escapeHtml(o.albumFolder) + '</div>' +
              '<div class="album-meta">' + escapeHtml(o.artistFolder) + ' · orphaned on DAP</div>' +
            '</div>' +
            '<div class="album-badge-wrap">' +
              '<span class="album-badge to-remove"><span class="album-badge-dot"></span>To remove</span>' +
            '</div>' +
          '</div>';
      }
    }

    container.innerHTML = html;
    var totalRows = albums.length + (orphans ? orphans.length : 0);
    $('albums-count').textContent = totalRows + ' total';
  }

  function setAlbumStatus(albumId, kind, label) {
    var row = document.querySelector('.album[data-album-id="' + albumId + '"]');
    if (!row) return;
    if (kind === 'active') {
      row.classList.add('is-active');
    } else {
      row.classList.remove('is-active');
    }
    var wrap = row.querySelector('.album-badge-wrap');
    if (wrap) {
      if (kind === 'active') {
        wrap.innerHTML = '<span class="album-badge active"><span class="spinner"></span>Syncing</span>';
      } else if (kind === 'synced') {
        wrap.innerHTML = '<span class="album-badge on-dap"><span class="album-badge-dot"></span>On DAP</span>';
        row.classList.add('is-synced');
      } else if (kind === 'failed') {
        wrap.innerHTML = '<span class="album-badge to-remove"><span class="album-badge-dot"></span>Failed</span>';
      } else {
        wrap.innerHTML = '<span class="album-badge to-add"><span class="album-badge-dot"></span>To add</span>';
      }
    }
    if (label) {
      var meta = row.querySelector('.album-meta');
      if (meta) meta.textContent = label;
    }
  }

  // ============================================================
  //  ZIP sync pipeline (Android / non-FSA fallback)
  //
  //  Durable path that sidesteps the broken FSA cache on Chromium
  //  WebView: fetch each album as a single ZIP stream, accumulate into
  //  a Blob, trigger the browser's native download manager via a
  //  synthetic <a download> click. The browser writes the ZIP straight
  //  to /Downloads/ using the same code path as every website file
  //  download — no handles, no cache, no cross-track state leaks.
  //
  //  Each album is processed sequentially. Live progress comes from
  //  the ReadableStream reader. Once the blob is handed to the
  //  browser, we POST /sync-mark for every track in the album manifest
  //  so the DB reflects the synced state for the next run.
  // ============================================================
  function sanitizeZipFilename(s) {
    // Strip characters that break Android/exFAT/NTFS download managers.
    return String(s || 'album')
      .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180) || 'album';
  }

  // ZIP mode (mobile / no-FSA path)
  // =================================
  // CRITICAL ARCHITECTURE NOTE (2026-04 rewrite):
  //
  // The previous implementation buffered the entire ZIP in JS memory
  // via `fetch → getReader → chunks[] → new Blob → URL.createObjectURL
  // → <a download>`. This was broken on two axes:
  //
  //   1. Blob buffering hits Chromium Android's ~500 MB hard cap and
  //      crashes OOM on any real FLAC album.
  //   2. `blob:` URLs are NOT resolved by Android WebView's
  //      DownloadManager — the download silently fails with zero
  //      feedback (the DownloadManager gets only the placeholder URL,
  //      never the bytes). Confirmed on FiiO JM21 after zero
  //      `[wifi-sync] ZIP download failed` logs despite the UI showing
  //      the sync loop running.
  //
  // The durable fix: point a plain anchor at the HTTPS URL of the
  // server. The browser's native download manager streams the response
  // directly from network to /Downloads — zero JS memory, no Blob, no
  // `blob:` protocol, no 500 MB limit. This is how every "download a
  // file" flow on every website has worked on Android since forever.
  //
  // Trade-off: we lose per-album progress feedback and cancellation.
  // The browser's own download notification becomes the progress UI,
  // which is the native experience users already expect.
  //
  // Sync-marking: without a completion callback we can't know when the
  // download finishes, so we optimistically mark synced 4 s after the
  // click. If the user interrupts the download, the album will reappear
  // after a manual reload + re-pick, which is acceptable.

  // Fallback ZIP mode (manual button): for Safari/Firefox/old Chromium
  // only, as a last-resort when FSA is genuinely unavailable. Kicks off
  // a single native anchor download per album sequentially. Not used
  // automatically — FSA is the primary path on every modern browser
  // including Chromium Android WebView (which is what DAPs run).
  var ZIP_CLICK_STAGGER_MS = 1200;

  function startZipSync() {
    var pending = [];
    for (var i = 0; i < albums.length; i++) {
      if (!albums[i].alreadySynced) pending.push(albums[i]);
    }
    if (pending.length === 0) return;

    syncing = true;
    cancelRequested = false;
    doneFilesCount = 0;
    totalFilesToSync = pending.length;
    showSyncBar();
    renderAll();

    zipSyncQueue(pending, 0).then(function() {
      syncing = false;
      cancelRequested = false;
      hideSyncBarSoon();
      loadStatus();
    });
  }

  function zipSyncQueue(queue, index) {
    if (cancelRequested || index >= queue.length) return Promise.resolve();
    var album = queue[index];
    tputCurrentTrack = (album.artist || '') + ' – ' + (album.album || '');
    setAlbumStatus(album.id, 'active', 'Queued for download…');

    try {
      var filename = sanitizeZipFilename(
        (album.artist || 'Unknown Artist') + ' - ' + (album.album || 'Unknown Album')
      ) + '.zip';
      var url = BASE + '/album/' + encodeURIComponent(album.id) + '.zip' + authQuery();
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      a.target = '_self';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      doneFilesCount++;
      updateSyncBar();
      setAlbumStatus(album.id, 'synced',
        (album.artist || '') + ' · sent to Downloads');
    } catch (e) {
      console.error('[wifi-sync] zip fallback failed for album', album.id, e);
      setAlbumStatus(album.id, 'failed',
        'Failed: ' + (e && e.message ? e.message : e));
    }

    return sleep(ZIP_CLICK_STAGGER_MS).then(function() {
      return zipSyncQueue(queue, index + 1);
    });
  }

  // ============================================================
  //  Sync orchestration
  // ============================================================
  function startSync() {
    if (syncing) {
      cancelRequested = true;
      return;
    }
    // Native download path for Android (no FSA).
    if (!fsaSupported) {
      return startZipSync();
    }
    if (!destHandle) {
      pickDestination().then(function(h) { if (h) startSync(); });
      return;
    }

    var pending = [];
    for (var i = 0; i < albums.length; i++) {
      // Use isAlbumOnDap so we don't re-download albums whose folder is
      // already on disk even when the per-device DB is empty.
      if (!isAlbumOnDap(albums[i])) pending.push(albums[i]);
    }
    var orphansToRemove = computeOrphans();
    if (pending.length === 0 && orphansToRemove.length === 0) return;

    syncing = true;
    cancelRequested = false;
    tputBytes = 0;
    tputStartedAt = Date.now();
    doneFilesCount = 0;
    totalFilesToSync = 0;
    for (var k = 0; k < pending.length; k++) {
      totalFilesToSync += (pending[k].trackCount || 0);
    }
    // Each orphan album folder counts as one "file" in the progress bar.
    totalFilesToSync += orphansToRemove.length;
    showSyncBar();
    renderAll();

    syncAlbumQueue(pending, 0)
      .then(function() {
        if (cancelRequested) return;
        return removeOrphansQueue(orphansToRemove, 0);
      })
      .then(function() {
        syncing = false;
        cancelRequested = false;
        hideSyncBarSoon();
        // Re-walk to refresh on-DAP awareness, then refresh status.
        walkDestForOnDap().then(loadStatus);
      });
  }

  // Remove each orphan album folder from <dest>/<rootPrefix>/<artist>/<album>.
  // Uses FSA `removeEntry(name, { recursive: true })`. Errors are logged but
  // not fatal — we want the rest of the orphans to clean up too.
  function removeOrphansQueue(orphans, index) {
    if (cancelRequested || !orphans || index >= orphans.length) {
      return Promise.resolve();
    }
    var o = orphans[index];
    return destHandle.getDirectoryHandle(rootPrefix, { create: false })
      .then(function(rootDir) {
        return rootDir.getDirectoryHandle(o.artistFolder, { create: false })
          .then(function(artistDir) {
            return artistDir.removeEntry(o.albumFolder, { recursive: true })
              .then(function() {
                // Best-effort: remove the artist folder too if it's now empty.
                return rootDir.removeEntry(o.artistFolder, { recursive: false }).catch(function() {});
              });
          });
      })
      .catch(function(err) {
        console.error('Orphan removal failed:', o.artistFolder, '/', o.albumFolder, err);
      })
      .then(function() {
        doneFilesCount++;
        updateSyncBar();
        return removeOrphansQueue(orphans, index + 1);
      });
  }

  function syncAlbumQueue(queue, index) {
    if (cancelRequested || index >= queue.length) {
      return Promise.resolve();
    }
    var album = queue[index];
    setAlbumStatus(album.id, 'active', 'Fetching manifest…');

    return fetchManifest(album.id)
      .then(function(manifest) {
        return syncAlbumTracks(album, manifest);
      })
      .catch(function(err) {
        if (err && err.isStaleSkip) {
          console.warn('[wifi-sync] skipping album', album.id, '— stale FSA handle auto-recovered');
          setAlbumStatus(album.id, 'failed',
            'Skipped · browser cache poisoned, will retry next sync');
        } else {
          console.error('Album sync failed:', album.id, err);
          setAlbumStatus(album.id, 'failed', 'Failed: ' + (err && err.message ? err.message : err));
        }
      })
      .then(function() {
        return syncAlbumQueue(queue, index + 1);
      });
  }

  function fetchManifest(albumId) {
    return fetch(BASE + '/album/' + encodeURIComponent(albumId) + '/manifest' + authQuery())
      .then(function(r) {
        if (!r.ok) throw new Error('manifest HTTP ' + r.status);
        return r.json();
      });
  }

  function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  // Called between albums. The real per-file refresh lives inside
  // ensureSubdir (refreshDirCache on the album leaf). This is just an
  // extra belt-and-suspenders refresh at the root level.
  function flushDestHandleCache() {
    return refreshDirCache(destHandle);
  }

  // ------------------------------------------------------------
  //  Automatic handle re-acquisition (no user gesture).
  //
  //  Chromium's FSA writable cache has a cumulative-invalidation bug:
  //  after the first InvalidStateError (triggered by e.g. a case
  //  collision on exFAT or a weird path), all subsequent writes under
  //  the same handle poison. The only known recovery is to re-read the
  //  handle from IndexedDB and verify the permission is still
  //  'granted' — no picker re-prompt needed, since the user already
  //  authorized this folder on a previous tap. The fresh handle
  //  reference carries a clean internal cache.
  //
  //  On stale: we auto-reacquire silently, skip the current album
  //  (marking it failed so the user can retry later), and continue the
  //  sync queue with the fresh destHandle. If re-acquisition itself
  //  fails (permission decayed, IDB empty), we surface the reconnect
  //  banner as a last-resort.
  // ------------------------------------------------------------
  var awaitingReconnect = false;
  var reconnectResolvers = [];

  function reacquireHandleSilently() {
    return idbGet('dest').then(function(handle) {
      if (!handle) return null;
      return handle.queryPermission({ mode: 'readwrite' }).then(function(p) {
        if (p !== 'granted') return null;
        destHandle = handle;
        destLabel = handle.name;
        console.warn('[wifi-sync] destHandle re-acquired silently from IDB');
        return handle;
      }).catch(function() { return null; });
    }).catch(function() { return null; });
  }

  function awaitReconnect(reason) {
    var banner = $('reconnect-banner');
    var msgEl = $('reconnect-banner-msg');
    if (msgEl && reason) {
      msgEl.innerHTML = '<strong>Folder connection lost</strong>' +
        escapeHtml(reason);
    }
    if (banner) banner.classList.remove('hidden');
    awaitingReconnect = true;
    return new Promise(function(resolve) {
      reconnectResolvers.push(resolve);
    });
  }

  function handleReconnectClick() {
    // pickDestination() is already a user-gesture-driven showDirectoryPicker.
    // On success it replaces destHandle with a fresh one. On abort it
    // returns null and we leave the banner visible for another tap.
    pickDestination().then(function(h) {
      if (!h) return; // user cancelled the picker
      var banner = $('reconnect-banner');
      if (banner) banner.classList.add('hidden');
      awaitingReconnect = false;
      var resolvers = reconnectResolvers.slice();
      reconnectResolvers = [];
      resolvers.forEach(function(fn) {
        try { fn(h); } catch (e) {}
      });
    });
  }

  function isStaleFsaError(err) {
    if (!err) return false;
    if (err.name === 'InvalidStateError') return true;
    if (err.name === 'NotFoundError') return true;
    if (err.message && err.message.indexOf('state had changed') !== -1) return true;
    return false;
  }

  // Step 3 — retry wrapper for a single track download. On InvalidStateError
  // we wait 150ms, flush the cache on destHandle, and retry ONCE. Any other
  // error propagates immediately (network, HTTP, cancel).
  function retryOnStaleFSA(fn) {
    return fn().catch(function(err) {
      var isStale = err && (err.name === 'InvalidStateError' ||
        (err.message && err.message.indexOf('state had changed') !== -1));
      if (!isStale) throw err;
      console.warn('[wifi-sync] stale FSA handle, retrying after flush:', err.message);
      return sleep(150).then(flushDestHandleCache).then(fn);
    });
  }

  function syncAlbumTracks(album, manifest) {
    var tracks = (manifest.tracks || []).filter(function(t) { return !t.alreadySynced; });
    var hasCover = !!manifest.hasCover;
    if (tracks.length === 0 && !hasCover) {
      setAlbumStatus(album.id, 'synced', album.artist + ' · already up to date');
      return Promise.resolve();
    }
    var p = Promise.resolve();
    var done = 0;
    var total = tracks.length;
    tracks.forEach(function(track, idx) {
      p = p.then(function() {
        if (cancelRequested) return;
        setAlbumStatus(album.id, 'active',
          'Track ' + (done + 1) + ' / ' + total + ' · ' + (track.title || ''));
        // downloadTrack has its own internal 3-attempt retry loop with
        // Range resume, so we don't double-wrap here.
        return downloadTrack(album.id, track).then(function() {
          done++;
          doneFilesCount++;
          updateSyncBar();
          // Step 2bis — 50ms micro-pause between tracks, lets Chromium's
          // FSA cache settle after the rename that close() triggered.
          if (idx < tracks.length - 1) return sleep(50);
        });
      });
    });
    // Cover written inline after the audio tracks for the same album folder
    // — matches the dap_sync engine ordering and avoids exFAT corruption.
    if (hasCover && tracks.length > 0) {
      p = p.then(function() {
        if (cancelRequested) return;
        return downloadAlbumCover(album, tracks[0]).catch(function(err) {
          console.warn('Cover download failed for', album.id, err);
        });
      });
    }
    return p.then(function() {
      if (cancelRequested) return;
      // Step 2ter — flush the FSA cache on destHandle at the end of each
      // album. Implicit: Chromium re-reads the permission state, which
      // forces a fresh snapshot of the ancestor inodes.
      return flushDestHandleCache();
    }).then(function() {
      if (cancelRequested) return;
      setAlbumStatus(album.id, 'synced', album.artist + ' · ' + total + ' tracks');
    });
  }

  // Write the album cover next to its audio tracks. We piggyback on the
  // first track's destRel to derive the folder ("Artist/Album/track.flac"
  // → "Artist/Album"), then write "cover.jpg" inside it.
  function downloadAlbumCover(album, sampleTrack) {
    var prefixedRel = rootPrefix
      ? rootPrefix + '/' + sampleTrack.destRel
      : sampleTrack.destRel;
    var split = splitDestRel(prefixedRel);
    var dirSegments = split[0];
    return ensureSubdir(destHandle, dirSegments)
      .then(function(parentDir) {
        return parentDir.getFileHandle('cover.jpg', { create: true });
      })
      .then(function(fileHandle) {
        return fileHandle.createWritable({ keepExistingData: false }).then(function(writable) {
          return fetch(BASE + '/album/' + encodeURIComponent(album.id) + '/cover' + authQuery())
            .then(function(resp) {
              if (!resp.ok) {
                return writable.abort().then(function() {
                  throw new Error('cover HTTP ' + resp.status);
                });
              }
              return pumpToWritable(resp.body, writable, null);
            });
        });
      });
  }

  // Self-healing track downloader with HTTP Range resume.
  //
  // Why: Chromium's FSA writable cache has a known cumulative-invalidation
  // bug (InvalidStateError mid-album). We can't prevent every occurrence,
  // so we treat failures as normal: count bytes successfully written,
  // re-open the writable with keepExistingData:true, seek to the offset,
  // and ask the server for `bytes=<offset>-` via HTTP Range. The server
  // (axum-range in server.rs) replies with 206 Partial Content and we
  // pump the remainder into the same file.
  //
  // Retries up to MAX_ATTEMPTS times per track, with a short backoff and
  // an implicit destHandle cache flush between attempts.
  function downloadTrack(albumId, track) {
    var prefixedRel = rootPrefix
      ? rootPrefix + '/' + track.destRel
      : track.destRel;

    var split = splitDestRel(prefixedRel);
    var dirSegments = split[0];
    var filename = split[1];

    tputCurrentTrack = filename;

    var MAX_ATTEMPTS = 5;
    var attempt = 0;
    var bytesWritten = 0;

    function attemptOnce() {
      attempt++;
      var isResume = bytesWritten > 0;

      // Re-walk from destHandle every attempt. If a FSA cache entry went
      // stale, this picks up the fresh snapshot automatically.
      return ensureSubdir(destHandle, dirSegments)
        .then(function(parentDir) {
          // CRITICAL — "state had changed" recovery:
          // When a prior attempt's createWritable() crashed mid-flight,
          // it can leave a `.crswap` tempfile (or a 0-byte / partial
          // target file) on disk. On the next attempt, getFileHandle
          // returns a handle whose internal stat snapshot is taken AT
          // CREATION TIME — and then createWritable() trips the
          // InvalidStateError "state had changed since it was read
          // from disk" because the actual on-disk state (a pre-
          // existing partial) doesn't match the snapshot's expectation.
          //
          // Nuking the entry before getFileHandle({create:true}) forces
          // Chromium to re-stat the parent dir AND create a brand-new
          // file entry with a fresh snapshot. Safe because we're about
          // to overwrite the file anyway. Skipped on resume because
          // resume relies on the partial bytes already on disk.
          if (isResume) return parentDir;
          return parentDir.removeEntry(filename).catch(function() {
            // Ignore NotFoundError (file didn't exist) and anything
            // else — the subsequent getFileHandle will surface the
            // real problem if there is one.
          }).then(function() { return parentDir; });
        })
        .then(function(parentDir) {
          return parentDir.getFileHandle(filename, { create: true });
        })
        .then(function(fileHandle) {
          // On resume, keepExistingData:true preserves what's already on
          // disk so seek(bytesWritten) + write() appends cleanly.
          return fileHandle.createWritable({ keepExistingData: isResume }).then(function(writable) {
            var seekPromise = isResume
              ? writable.seek(bytesWritten).catch(function(err) {
                  // If seek fails the writable is probably unusable;
                  // treat as a fresh start next attempt.
                  bytesWritten = 0;
                  throw err;
                })
              : Promise.resolve();
            return seekPromise.then(function() {
              var headers = {};
              if (isResume) {
                headers['Range'] = 'bytes=' + bytesWritten + '-';
              }
              return fetch(BASE + '/file' + authQuery({
                album: albumId,
                path: track.destRel
              }), { headers: headers }).then(function(resp) {
                // 200 = full body (server ignored range or no range sent)
                // 206 = partial from our offset
                // 416 = range not satisfiable (file shorter than we thought)
                if (resp.status === 416) {
                  // Our bytesWritten is stale: restart clean on next attempt.
                  bytesWritten = 0;
                  return writable.abort().then(function() {
                    throw new Error('HTTP 416');
                  });
                }
                if (!resp.ok) {
                  return writable.abort().then(function() {
                    throw new Error('HTTP ' + resp.status);
                  });
                }
                // If we asked for a range and got 200 instead of 206, the
                // server sent us the whole file — reset the writable and
                // take it from the top.
                if (isResume && resp.status === 200) {
                  return writable.abort().then(function() {
                    bytesWritten = 0;
                    throw new Error('range-unsupported-retry');
                  });
                }
                return pumpToWritable(resp.body, writable, function(chunkLen) {
                  bytesWritten += chunkLen;
                });
              });
            });
          });
        });
    }

    function loop() {
      return attemptOnce().catch(function(err) {
        if (cancelRequested) throw err;
        var stale = isStaleFsaError(err);
        console.warn('[wifi-sync] attempt ' + attempt + ' failed for ' +
          filename + ' (bytesWritten=' + bytesWritten + '):',
          err.message || err);
        if (attempt >= MAX_ATTEMPTS) {
          // Exhausted retries. On stale, try the silent IDB re-acquire
          // as a last-ditch effort; if that also fails, mark the album
          // as skipped so syncAlbumQueue moves on to the next album
          // (which will get its own fresh ensureSubdir walk with
          // per-level refresh — the real fix for the cascade).
          if (stale) {
            return reacquireHandleSilently().then(function(freshHandle) {
              var skipErr = new Error(
                'FSA cascade — album skipped, will retry next sync'
              );
              skipErr.isStaleSkip = true;
              throw skipErr;
            });
          }
          throw err;
        }
        // Still have retries left. Wait a beat, walk the tree fresh,
        // retry. The per-level refreshDirCache inside ensureSubdir
        // (called on the next attempt) is what actually breaks the
        // cumulative FSA pollution — this backoff just gives Chromium
        // a microtask window to settle the prior writable's close.
        var backoff = stale ? 200 * attempt : 150 * attempt;
        return sleep(backoff).then(function() {
          // Extra belt-and-suspenders: refresh destHandle's own cache
          // before the next ensureSubdir walk. Cheap and idempotent.
          return refreshDirCache(destHandle);
        }).then(loop);
      });
    }

    return loop().then(function() {
      return fetch(BASE + '/sync-mark' + authQuery(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          albumId: albumId,
          destRel: track.destRel,
          sizeBytes: track.sizeBytes,
          quickHash: ''
        })
      });
    });
  }

  // Pumps a ReadableStream into a FileSystemWritableFileStream, invoking
  // `onBytes(len)` after each successful write so the caller can track
  // the exact byte offset for Range resume. On any error, the reader is
  // cancelled and the writable is aborted so no native handles leak
  // (WebView on JM21 chokes after ~40 leaked writables).
  function pumpToWritable(readable, writable, onBytes) {
    var reader = readable.getReader();
    var cleanedUp = false;
    function cleanup() {
      if (cleanedUp) return Promise.resolve();
      cleanedUp = true;
      var rc = reader.cancel().catch(function() {});
      var wa = writable.abort().catch(function() {});
      return Promise.all([rc, wa]);
    }
    function step() {
      if (cancelRequested) {
        return cleanup().then(function() { throw new Error('cancelled'); });
      }
      return reader.read().then(function(res) {
        if (res.done) {
          cleanedUp = true; // close() takes ownership; no abort needed
          return writable.close();
        }
        return writable.write(res.value).then(function() {
          var len = res.value.length;
          tputBytes += len;
          if (onBytes) onBytes(len);
          updateSyncBar();
          return step();
        });
      });
    }
    return step().catch(function(err) {
      return cleanup().then(function() { throw err; });
    });
  }

  // ============================================================
  //  Top sync bar (replaces the old bottom toast)
  // ============================================================
  function showSyncBar() {
    $('sync-bar').classList.remove('hidden');
    updateSyncBar();
  }
  function hideSyncBarSoon() {
    setTimeout(function() {
      if (!syncing) {
        $('sync-bar').classList.add('hidden');
        $('sync-bar-fill').style.width = '0%';
      }
    }, 1800);
  }
  function updateSyncBar() {
    if (!syncing && tputBytes === 0) return;
    var elapsed = (Date.now() - tputStartedAt) / 1000;
    if (elapsed < 0.2) return;

    var bps = tputBytes / elapsed;
    $('sync-bar-speed').textContent = formatSpeed(bps);
    $('sync-bar-done').textContent = doneFilesCount;
    $('sync-bar-total').textContent = totalFilesToSync;

    var remainingBytes = 0;
    for (var i = 0; i < albums.length; i++) {
      if (!albums[i].alreadySynced) remainingBytes += (albums[i].totalBytes || 0);
    }
    remainingBytes = Math.max(0, remainingBytes - tputBytes);
    $('sync-bar-eta').textContent = formatEta(remainingBytes, bps);
    $('sync-bar-current').textContent = tputCurrentTrack;

    var pct = totalFilesToSync > 0
      ? Math.min(100, (doneFilesCount / totalFilesToSync) * 100)
      : 0;
    $('sync-bar-fill').style.width = pct + '%';
  }

  // ============================================================
  //  Reset sync state
  // ============================================================
  function resetSyncState() {
    if (!confirm('Reset sync history for this device? You will need to re-pull every album.')) return;
    fetch(BASE + '/sync-state' + authQuery(), { method: 'DELETE' })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return loadStatus();
      })
      .catch(function(err) { alert('Reset failed: ' + err.message); });
  }

  // ============================================================
  //  Init
  // ============================================================
  $('btn-pick').addEventListener('click', function() {
    pickDestination().then(function(h) { if (h) renderAll(); });
  });
  $('btn-pick-2').addEventListener('click', function() {
    pickDestination().then(function(h) { if (h) renderAll(); });
  });
  $('dest-change').addEventListener('click', function() {
    pickDestination().then(function(h) { if (h) renderAll(); });
  });
  $('btn-sync').addEventListener('click', startSync);
  $('sync-bar-cancel').addEventListener('click', function() {
    cancelRequested = true;
    $('sync-bar-cancel').textContent = 'Cancelling…';
  });
  $('btn-reconnect').addEventListener('click', handleReconnectClick);
  $('btn-refresh-page').addEventListener('click', function() { location.reload(); });
  $('btn-reset').addEventListener('click', resetSyncState);
  // Reuses the new streaming ZIP pipeline (progress-tracked, sequential,
  // marks tracks as synced via /sync-mark at the end of each album).
  $('btn-zip-mode').addEventListener('click', startZipSync);

  if (!fsaSupported) {
    $('onb-fallback').classList.remove('hidden');
    $('btn-pick').disabled = true;
    $('btn-pick-2').disabled = true;
  }

  tryRestoreDestination().then(function() {
    return loadStatus();
  });

  statusTimer = setInterval(function() {
    if (!syncing) loadStatus();
  }, 3000);
})();
</script>
</body>
</html>
"##;

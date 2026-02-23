// state.js — État partagé de l'application Noir Desktop
// Tous les modules importent depuis ce fichier pour accéder à l'état global.

// === TAURI API ===
export const { invoke, convertFileSrc } = window.__TAURI__.core;
export const { listen } = window.__TAURI__.event;

// === AUDIO ENGINE STATE ===
export const playback = {
  currentTrackIndex: -1,
  audioIsPlaying: false,
  audioDurationFromRust: 0,
  audioPositionFromRust: 0,
  gaplessPreloadTriggered: false,
  currentPlayingAlbumKey: null,
  shuffleMode: 'off',        // 'off', 'album', 'library'
  repeatMode: 'off',         // 'off', 'all', 'one'
  shufflePlayedTracks: new Set(),
  lastVolume: 100,
};

// === LIBRARY DATA ===
export const library = {
  tracks: [],
  albums: {},
  artists: {},
  tracksByPath: new Map(),
  metadataLoaded: false,
  trackAddedDates: {},
};

// === SEARCH ===
export const search = {
  query: '',
  index: new Map(),  // Index inversé : mot → Set<index de track>
};

// === UI STATE ===
export const ui = {
  currentView: 'home',
  selectedAlbumKey: null,
  filteredArtist: null,
  albumDetailDiv: null,
  isQueuePanelOpen: false,
  isTrackInfoPanelOpen: false,
  isEqPanelOpen: false,
  isSettingsPanelOpen: false,
  trackInfoCurrentTrack: null,
};

// === QUEUE ===
export const queue = {
  items: [],
};

// === SORT STATE ===
export const sort = {
  column: 'title',
  direction: 'asc',
  albumSortMode: 'artist-asc',
};

// === CACHES ===
// Note: Les caches stockent des URLs noir:// (~60 octets) au lieu de base64 (~700KB)
export const caches = {
  coverCache: new Map(),
  thumbnailCache: new Map(),
  homeDataCache: {
    lastPlayed: null,
    recentTracks: [],
    allPlayedAlbums: [],
    topArtists: [],
    lastFetch: 0,
    isValid: false,
  },
};

export const HOME_CACHE_TTL = 30000;  // 30 secondes

// === FAVORITES ===
export const favorites = {
  tracks: new Set(),
};

// === PERFORMANCE DIAGNOSTICS ===
export const PERF = {
  thumbnailCalls: 0,
  thumbnailCacheHits: 0,
  thumbnailCacheMisses: 0,
  coverFallbacks: 0,
  internetFallbacks: 0,
  totalLoadTime: 0,
  slowLoads: [],

  reset() {
    this.thumbnailCalls = 0;
    this.thumbnailCacheHits = 0;
    this.thumbnailCacheMisses = 0;
    this.coverFallbacks = 0;
    this.internetFallbacks = 0;
    this.totalLoadTime = 0;
    this.slowLoads = [];
  },

  log() {
    const hitRate = this.thumbnailCalls > 0 ? (this.thumbnailCacheHits / this.thumbnailCalls * 100).toFixed(1) : 0;
    const avgTime = this.thumbnailCalls > 0 ? (this.totalLoadTime / this.thumbnailCalls).toFixed(0) : 0;
    console.log(`%c[PERF] === THUMBNAIL PERFORMANCE REPORT ===`, 'color: #00ff00; font-weight: bold');
    console.log(`[PERF] Total calls: ${this.thumbnailCalls}`);
    console.log(`[PERF] Cache hits: ${this.thumbnailCacheHits} (${hitRate}%)`);
    console.log(`[PERF] Cache misses: ${this.thumbnailCacheMisses}`);
    console.log(`[PERF] Cover fallbacks: ${this.coverFallbacks}`);
    console.log(`[PERF] Internet fallbacks: ${this.internetFallbacks}`);
    console.log(`[PERF] Avg load time: ${avgTime}ms`);
    console.log(`[PERF] Slow loads (>500ms): ${this.slowLoads.length}`);
    if (this.slowLoads.length > 0) {
      console.log(`[PERF] Top 10 slowest:`);
      this.slowLoads.sort((a, b) => parseInt(b.time) - parseInt(a.time)).slice(0, 10).forEach((s, i) => {
        console.log(`  ${i + 1}. ${s.time}ms - ${s.type} - ${s.path}`);
      });
    }
    console.log(`%c[PERF] === END REPORT ===`, 'color: #00ff00; font-weight: bold');
  },
};

// Expose pour debug console
window.PERF = PERF;

// === DOM ELEMENTS ===
// Références aux éléments principaux de la page
export const dom = {
  selectFolderBtn: document.getElementById('select-folder'),
  openFolderWelcomeBtn: document.getElementById('open-folder-welcome'),
  welcomeDiv: document.getElementById('welcome'),
  albumsViewDiv: document.getElementById('albums-view'),
  albumsGridDiv: document.getElementById('albums-grid'),
  playerDiv: document.getElementById('player'),
  trackNameEl: document.getElementById('track-name'),
  trackFolderEl: document.getElementById('track-folder'),
  playPauseBtn: document.getElementById('play-pause'),
  progressBar: document.getElementById('progress'),
  currentTimeEl: document.getElementById('current-time'),
  durationEl: document.getElementById('duration'),
  coverArtEl: document.getElementById('cover-art'),
  prevBtn: document.getElementById('prev'),
  nextBtn: document.getElementById('next'),
  searchInput: document.getElementById('search-input'),
  searchResultsPanel: document.getElementById('search-results-panel'),
  shuffleBtn: document.getElementById('shuffle'),
  repeatBtn: document.getElementById('repeat'),
  volumeBar: document.getElementById('volume'),
  volumeBtn: document.getElementById('volume-btn'),
  audioOutputBtn: document.getElementById('audio-output-btn'),
  audioOutputMenu: document.getElementById('audio-output-menu'),
  audioOutputList: document.getElementById('audio-output-list'),
  exclusiveModeCheckbox: document.getElementById('exclusive-mode-checkbox'),
};

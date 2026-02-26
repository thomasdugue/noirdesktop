// app.js — Médiateur cross-module pour éviter les dépendances circulaires
// Chaque module enregistre ses fonctions publiques ici.
// Les autres modules appellent via app.functionName() au lieu d'importer directement.

export const app = {
  // === Playback ===
  playTrack: null,
  playAlbum: null,
  togglePlay: null,
  playNextTrack: null,
  playPreviousTrack: null,
  resetPlayerUI: null,
  getCurrentTrackDuration: null,
  triggerGaplessPreload: null,
  loadAudioDevices: null,
  updateVolumeIcon: null,
  updateRepeatButtonUI: null,

  // === Views ===
  displayCurrentView: null,
  updateAlbumTracksHighlight: null,
  updateHomeNowPlayingSection: null,
  navigateToAlbumPage: null,
  navigateToArtistPage: null,
  navigateToMixPage: null,
  navigateBack: null,
  switchView: null,
  updateNowPlayingHighlight: null,
  closeAlbumDetail: null,
  invalidateDiscoveryMixCache: null,
  getVirtualScrollState: null,

  // === Panels ===
  toggleQueuePanel: null,
  closeAllPanels: null,
  showContextMenu: null,
  showAlbumContextMenu: null,
  closeContextMenu: null,
  closeTrackInfoPanel: null,
  closeSettings: null,
  showTrackInfoPanel: null,
  goToTrackAlbum: null,
  goToTrackArtist: null,
  hideContextMenu: null,
  openTrackInfoInEditMode: null,
  showBulkEditModal: null,

  // === Queue ===
  addToQueue: null,
  playNext: null,
  removeFromQueue: null,
  clearQueue: null,
  updateQueueDisplay: null,
  updateQueueIndicators: null,
  addAlbumToQueue: null,
  showQueueNotification: null,

  // === Library ===
  invalidateHomeCache: null,
  groupTracksIntoAlbumsAndArtists: null,
  buildTrackLookup: null,
  loadThumbnailAsync: null,
  loadCoverAsync: null,
  loadArtistImageAsync: null,
  observeCoverLoading: null,
  initCoverObserver: null,
  startBackgroundScan: null,
  updateIndexationStats: null,
  removeTracksFromLibrary: null,

  // === Playlists ===
  addTrackToPlaylist: null,
  showAddToPlaylistMenu: null,
  showAddToPlaylistMenuMulti: null,
  loadPlaylists: null,
  updatePlaylistsSidebar: null,
  loadFavorites: null,
  toggleFavorite: null,
  getFavoriteButtonHtml: null,
  displayPlaylistView: null,
  showPlaylistModal: null,

  // === Search ===
  buildSearchIndex: null,
  searchTracksWithIndex: null,
  updateTracksFilter: null,
  closeSearchPanel: null,

  // === Drag ===
  prepareCustomDrag: null,
  prepareAlbumDrag: null,

  // === EQ ===
  closeEqPanel: null,
  openEqPanel: null,
  toggleEqPanel: null,
  getEqPanelOpen: null,

  // === Settings ===
  openSettings: null,
  toggleSettings: null,
  updateHogModeUI: null,

  // === Misc ===
  selectFolder: null,
}

// Navigation.test.js — Module 10: Navigation tests
// Tests sidebar navigation, view switching, and history stack.
//
// These tests require jsdom + full module initialization (state.js imports
// window.__TAURI__ and caches DOM references at load time). Skipped until
// a DOM test environment is configured.

import { describe, test } from '@jest/globals';

describe('Module 10 — Navigation', () => {

  // 10.1: Sidebar navigation switches the active view
  test.skip('10.1: clicking a sidebar nav-item switches currentView and highlights the item', () => {
    // Requires jsdom + full module initialization
    // - Render the sidebar with nav-items (home, albums, artists, tracks, playlists)
    // - Click on "albums" nav-item
    // - Verify ui.currentView === 'albums'
    // - Verify the clicked item has .active class and others do not
  });

  // 10.2: Navigation history push and pop
  test.skip('10.2: navigating to album detail pushes to history; back button pops', () => {
    // Requires jsdom + full module initialization
    // - Navigate from home -> albums -> album detail
    // - Verify ui.navigationHistory has 2 entries
    // - Trigger back navigation
    // - Verify ui.currentView returns to 'albums'
  });

  // 10.3: Deep-link navigation to artist page
  test.skip('10.3: navigating to an artist page sets currentView and filteredArtist', () => {
    // Requires jsdom + full module initialization
    // - Call app.showArtistPage('Artist Name')
    // - Verify ui.currentView === 'artist-page'
    // - Verify ui.currentArtistPageKey === 'Artist Name'
  });

  // 10.4: Home view renders with cached data
  test.skip('10.4: home view displays recent albums and top artists from cache', () => {
    // Requires jsdom + full module initialization
    // - Populate caches.homeDataCache with mock data
    // - Render home view
    // - Verify carousel sections are present in DOM
    // - Verify correct number of album cards rendered
  });

});

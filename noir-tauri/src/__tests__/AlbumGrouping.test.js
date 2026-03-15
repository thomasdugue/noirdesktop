// AlbumGrouping.test.js — Module 13: Album grouping regression tests
// Vérifie les invariants critiques :
//   - Un album avec plusieurs artistes = UNE SEULE entrée dans library.albums
//   - normalizeKey élimine les différences Unicode / espaces
//   - Tri des tracks par disc_number / track_number
//
// Ces tests PROTÈGENT contre la régression #2026-03-14 (duplication d'albums)

import { describe, test, expect, beforeEach, beforeAll } from '@jest/globals';
import { library, clearObject } from '../state.js';
import { app } from '../app.js';

let normalizeKey, groupTracksIntoAlbumsAndArtists;

beforeAll(async () => {
  // app.buildSearchIndex est appelé à la fin de groupTracksIntoAlbumsAndArtists
  app.buildSearchIndex = () => {};

  const lib = await import('../library.js');
  normalizeKey = lib.normalizeKey;
  groupTracksIntoAlbumsAndArtists = lib.groupTracksIntoAlbumsAndArtists;
});

// Helper : crée un track minimal
function makeTrack(path, album, artist, trackNum = 1, disc = 1) {
  return {
    path,
    name: path.split('/').pop(),
    metadata: {
      title: path.split('/').pop().replace('.flac', ''),
      album,
      artist,
      track: trackNum,
      disc,
      duration: 240,
    },
  };
}

describe('Module 13 — normalizeKey', () => {

  test('13.1: returns null/undefined unchanged', () => {
    expect(normalizeKey(null)).toBe(null);
    expect(normalizeKey(undefined)).toBe(undefined);
    expect(normalizeKey('')).toBe('');
  });

  test('13.2: trims whitespace', () => {
    expect(normalizeKey('  OK Computer  ')).toBe('OK Computer');
    expect(normalizeKey('\tAlbum\n')).toBe('Album');
  });

  test('13.3: normalizes Unicode to NFC', () => {
    // é en NFD (e + accent combinant) vs NFC (é précomposé)
    const nfd = 'L\u0027E\u0301cole du Micro d\u0027Argent'; // NFD
    const nfc = 'L\u0027\u00C9cole du Micro d\u0027Argent';  // NFC
    expect(normalizeKey(nfd)).toBe(normalizeKey(nfc));
  });

  test('13.4: NFC + trim combined', () => {
    const messy = '  Ne\u0301s Sous La Me\u0302me E\u0301toile  '; // NFD with spaces
    const clean = 'N\u00E9s Sous La M\u00EAme \u00C9toile';       // NFC trimmed
    expect(normalizeKey(messy)).toBe(clean);
  });

});

describe('Module 13 — groupTracksIntoAlbumsAndArtists', () => {

  beforeEach(() => {
    // Reset library state before each test
    library.tracks = [];
    clearObject(library.albums);
    clearObject(library.artists);
    library.metadataLoaded = false;
  });

  test('13.5: INVARIANT — multi-artist album produces exactly ONE album entry', () => {
    // Album "OK Computer" avec tracks de "Radiohead" et un feat "Radiohead feat. Jonny Greenwood"
    library.tracks = [
      makeTrack('/music/ok/01.flac', 'OK Computer', 'Radiohead', 1),
      makeTrack('/music/ok/02.flac', 'OK Computer', 'Radiohead', 2),
      makeTrack('/music/ok/03.flac', 'OK Computer', 'Radiohead feat. Jonny Greenwood', 3),
      makeTrack('/music/ok/04.flac', 'OK Computer', 'Radiohead', 4),
    ];

    groupTracksIntoAlbumsAndArtists();

    const albumKeys = Object.keys(library.albums);
    expect(albumKeys).toHaveLength(1);
    expect(albumKeys[0]).toBe('OK Computer');
    expect(library.albums['OK Computer'].tracks).toHaveLength(4);
  });

  test('13.6: INVARIANT — album name with different Unicode forms = ONE entry', () => {
    const albumNFD = "L'E\u0301cole du Micro d'Argent"; // NFD
    const albumNFC = "L'\u00C9cole du Micro d'Argent";  // NFC

    library.tracks = [
      makeTrack('/music/ecole/01.flac', albumNFD, 'IAM', 1),
      makeTrack('/music/ecole/02.flac', albumNFC, 'IAM', 2),
      makeTrack('/music/ecole/03.flac', albumNFD, 'IAM', 3),
    ];

    groupTracksIntoAlbumsAndArtists();

    const albumKeys = Object.keys(library.albums);
    expect(albumKeys).toHaveLength(1);
    expect(library.albums[albumKeys[0]].tracks).toHaveLength(3);
  });

  test('13.7: INVARIANT — album name with trailing spaces = ONE entry', () => {
    library.tracks = [
      makeTrack('/music/a/01.flac', 'My Album', 'Artist A', 1),
      makeTrack('/music/a/02.flac', 'My Album ', 'Artist A', 2), // trailing space
      makeTrack('/music/a/03.flac', '  My Album  ', 'Artist A', 3), // both sides
    ];

    groupTracksIntoAlbumsAndArtists();

    expect(Object.keys(library.albums)).toHaveLength(1);
    expect(library.albums['My Album'].tracks).toHaveLength(3);
  });

  test('13.8: compilation album → "Various Artists" when no majority artist', () => {
    library.tracks = [
      makeTrack('/music/comp/01.flac', 'Best of 2025', 'Artist A', 1),
      makeTrack('/music/comp/02.flac', 'Best of 2025', 'Artist B', 2),
      makeTrack('/music/comp/03.flac', 'Best of 2025', 'Artist C', 3),
      makeTrack('/music/comp/04.flac', 'Best of 2025', 'Artist D', 4),
    ];

    groupTracksIntoAlbumsAndArtists();

    expect(Object.keys(library.albums)).toHaveLength(1);
    expect(library.albums['Best of 2025'].artist).toBe('Various Artists');
    expect(library.albums['Best of 2025'].isVariousArtists).toBe(true);
  });

  test('13.9: album with majority artist keeps that artist name', () => {
    library.tracks = [
      makeTrack('/music/ok/01.flac', 'OK Computer', 'Radiohead', 1),
      makeTrack('/music/ok/02.flac', 'OK Computer', 'Radiohead', 2),
      makeTrack('/music/ok/03.flac', 'OK Computer', 'Radiohead', 3),
      makeTrack('/music/ok/04.flac', 'OK Computer', 'Radiohead feat. Someone', 4),
    ];

    groupTracksIntoAlbumsAndArtists();

    expect(library.albums['OK Computer'].artist).toBe('Radiohead');
    expect(library.albums['OK Computer'].isVariousArtists).toBe(true);
  });

  test('13.10: single-artist album is NOT marked as Various Artists', () => {
    library.tracks = [
      makeTrack('/music/ok/01.flac', 'OK Computer', 'Radiohead', 1),
      makeTrack('/music/ok/02.flac', 'OK Computer', 'Radiohead', 2),
    ];

    groupTracksIntoAlbumsAndArtists();

    expect(library.albums['OK Computer'].artist).toBe('Radiohead');
    expect(library.albums['OK Computer'].isVariousArtists).toBe(false);
  });

  test('13.11: tracks sorted by disc then track number', () => {
    library.tracks = [
      makeTrack('/music/a/d2t1.flac', 'Double Album', 'Artist', 1, 2),
      makeTrack('/music/a/d1t2.flac', 'Double Album', 'Artist', 2, 1),
      makeTrack('/music/a/d1t1.flac', 'Double Album', 'Artist', 1, 1),
      makeTrack('/music/a/d2t2.flac', 'Double Album', 'Artist', 2, 2),
    ];

    groupTracksIntoAlbumsAndArtists();

    const tracks = library.albums['Double Album'].tracks;
    expect(tracks[0].path).toBe('/music/a/d1t1.flac');
    expect(tracks[1].path).toBe('/music/a/d1t2.flac');
    expect(tracks[2].path).toBe('/music/a/d2t1.flac');
    expect(tracks[3].path).toBe('/music/a/d2t2.flac');
  });

  test('13.12: two DIFFERENT albums remain as two separate entries', () => {
    library.tracks = [
      makeTrack('/music/a/01.flac', 'Album A', 'Artist X', 1),
      makeTrack('/music/b/01.flac', 'Album B', 'Artist X', 1),
    ];

    groupTracksIntoAlbumsAndArtists();

    expect(Object.keys(library.albums)).toHaveLength(2);
    expect(library.albums['Album A']).toBeDefined();
    expect(library.albums['Album B']).toBeDefined();
  });

  test('13.13: tracks without metadata are skipped', () => {
    library.tracks = [
      { path: '/music/broken.flac', name: 'broken.flac', metadata: null },
      makeTrack('/music/ok/01.flac', 'OK Computer', 'Radiohead', 1),
    ];

    groupTracksIntoAlbumsAndArtists();

    expect(Object.keys(library.albums)).toHaveLength(1);
    expect(library.albums['OK Computer'].tracks).toHaveLength(1);
  });

  test('13.14: artist index correctly built from multi-artist album', () => {
    library.tracks = [
      makeTrack('/music/ok/01.flac', 'OK Computer', 'Radiohead', 1),
      makeTrack('/music/ok/02.flac', 'OK Computer', 'Radiohead feat. Someone', 2),
    ];

    groupTracksIntoAlbumsAndArtists();

    // Both artists should exist in the artist index
    expect(library.artists['Radiohead']).toBeDefined();
    expect(library.artists['Radiohead feat. Someone']).toBeDefined();

    // Both should reference the same album
    expect(library.artists['Radiohead'].albums).toContain('OK Computer');
    expect(library.artists['Radiohead feat. Someone'].albums).toContain('OK Computer');
  });

});

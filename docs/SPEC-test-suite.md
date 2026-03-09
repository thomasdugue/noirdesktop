# Suite de tests Noir Desktop

## Contexte

Le projet grossit et on a des régressions à chaque session de travail.

**Objectif :** Créer une suite de tests (`cargo test` + tests frontend) qui vérifie tous les comportements critiques de l'app. Ces tests doivent tourner sans DAC branché, sans NAS connecté, sans fichiers audio personnels — utilise des fichiers de test embarqués, des mocks et des assertions.

## Règles

* Les tests doivent être autonomes : `cargo test` et `npm test` suffisent, aucune configuration manuelle
* Embarquer des petits fichiers de test dans le repo (générer des fichiers audio synthétiques de quelques secondes si nécessaire — sinusoïde, silence, etc.)
* Mocker les interactions hardware (CoreAudio, DAC, réseau, système de fichiers réseau)
* Chaque test a un nom clair qui décrit le comportement vérifié
* Les tests doivent être rapides (< 30 secondes pour la suite complète)
* Organiser les tests par module (un fichier de test par domaine)

## Tests Backend Rust (`cargo test`)

### Module 1 — Décodage audio (`tests/audio_decode.rs`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 1.1 | Décoder un fichier FLAC 16-bit/44.1kHz | Retourne des samples, sample rate = 44100, bit depth = 16 |
| 1.2 | Décoder un fichier FLAC 24-bit/96kHz | Retourne des samples, sample rate = 96000, bit depth = 24 |
| 1.3 | Décoder un fichier FLAC 24-bit/192kHz | Retourne des samples, sample rate = 192000, bit depth = 24 |
| 1.4 | Décoder un fichier WAV 16-bit/44.1kHz | Retourne des samples, sample rate = 44100 |
| 1.5 | Décoder un fichier AIFF 16-bit/44.1kHz | Retourne des samples, sample rate = 44100 |
| 1.6 | Décoder un fichier ALAC (M4A) | Retourne des samples, format détecté comme ALAC |
| 1.7 | Décoder un fichier MP3 320kbps | Retourne des samples, bitrate détecté ~320kbps |
| 1.8 | Décoder un fichier MP3 VBR | Retourne des samples, bitrate variable détecté |
| 1.9 | Ouvrir un fichier corrompu | Retourne une erreur propre, pas de panic |
| 1.10 | Ouvrir un fichier non-audio (.txt, .jpg) | Retourne une erreur propre, pas de panic |
| 1.11 | Décoder un fichier de 0 seconde | Retourne une erreur ou un résultat vide, pas de panic |

**Fichiers de test :** Générer des fichiers synthétiques (sinusoïde 440Hz, 3 secondes) dans chaque format. Utiliser `hound` pour WAV, un encodeur FLAC, etc. OU embarquer de très petits fichiers binaires dans `tests/fixtures/`.

### Module 2 — Seek et position (`tests/audio_seek.rs`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 2.1 | Seek à 0% (début) | La position retournée est 0 |
| 2.2 | Seek à 50% | La position retournée est ~50% de la durée totale (±100ms) |
| 2.3 | Seek à 100% (fin) | Pas de panic, le décodeur est à la fin ou retourne fin de fichier |
| 2.4 | Seek en avant (de 10s à 30s) | Position = ~30s |
| 2.5 | Seek en arrière (de 30s à 5s) | Position = ~5s |
| 2.6 | 10 seeks rapides consécutifs | Aucun panic, aucune corruption, position finale correcte |
| 2.7 | Seek sur un fichier FLAC | Fonctionne correctement |
| 2.8 | Seek sur un fichier MP3 | Fonctionne correctement (tolérance ±500ms) |
| 2.9 | Seek après la fin du fichier | Pas de panic, géré proprement |

### Module 3 — RingBuffer (`tests/ring_buffer.rs`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 3.1 | Écrire puis lire N samples | Samples lus identiques aux écrits, dans le bon ordre |
| 3.2 | Écrire plus que la capacité | Pas de panic |
| 3.3 | Lire un buffer vide | Pas de panic, pas de données corrompues |
| 3.4 | Flush du buffer | Après flush, buffer vide |
| 3.5 | Écriture et lecture concurrentes (2 threads) | Pas de data race, pas de corruption |
| 3.6 | Pre-fill après flush | Lecture retourne exactement les samples du pre-fill |

### Module 4 — Metadata et formats (`tests/metadata.rs`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 4.1 | Extraire metadata d'un FLAC tagué | Retourne titre, artiste, album, track, année, genre |
| 4.2 | Extraire metadata d'un MP3 (ID3v2) | Retourne titre, artiste, album, track |
| 4.3 | Extraire metadata d'un WAV | Retourne ce qui est disponible |
| 4.4 | Extraire metadata d'un ALAC (M4A) | Retourne titre, artiste, album |
| 4.5 | Fichier sans aucun tag | Champs vides ou "Unknown", pas de panic |
| 4.6 | Pochette embarquée FLAC | Retourne bytes d'image, taille > 0 |
| 4.7 | Fichier sans pochette | Retourne None, pas de panic |
| 4.8 | Numéro de disque | Retourne disc number si présent |
| 4.9 | Format display : FLAC 24/192 | Retourne "24-bit / 192kHz" |
| 4.10 | Format display : MP3 320kbps | Retourne "320 kbps" |
| 4.11 | Format display : MP3 VBR | Retourne "~245 kbps" ou "VBR" |
| 4.12 | Format display : WAV 16/44.1 | Retourne "16-bit / 44.1kHz" |

### Module 5 — Library / Scanner (`tests/library_scanner.rs`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 5.1 | Scanner dossier avec 5 fichiers audio | 5 entrées avec chemin + metadata |
| 5.2 | Dossier avec fichiers non-audio | Non-audio ignorés |
| 5.3 | Dossier vide | Library vide, pas de panic |
| 5.4 | Dossier inexistant | Erreur propre |
| 5.5 | Pas de doublons | Scanner 2x → même nombre d'entrées |
| 5.6 | Scan incrémental : ajout | Re-scan ajoute uniquement le nouveau |
| 5.7 | Scan incrémental : suppression | Re-scan retire le fichier supprimé |
| 5.8 | Tri disc_number puis track_number | Tracks triées correctement |
| 5.9 | Tri fallback nom de fichier | Si pas de tag, tri par nom |
| 5.10 | Détection doublons | Même titre+artiste+album+durée → flaggés |

### Module 6 — Queue et playlist (`tests/queue.rs`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 6.1 | Ajouter 1 morceau | Queue contient 1 élément |
| 6.2 | Ajouter 10 morceaux | 10 éléments dans le bon ordre |
| 6.3 | Skip next | Avance au suivant |
| 6.4 | Skip next sur dernier | Pas de panic |
| 6.5 | Skip previous | Revient au précédent |
| 6.6 | Skip previous sur premier | Pas de panic |
| 6.7 | Vider la queue | Queue vide |
| 6.8 | Shuffle | Ordre différent (20+ morceaux) |
| 6.9 | Repeat one | Même morceau remis en tête |
| 6.10 | Repeat all | Repart au premier après le dernier |
| 6.11 | Créer playlist | Playlist créée avec bons morceaux |
| 6.12 | Supprimer morceau de playlist | Retiré, reste dans le bon ordre |

### Module 7 — Source réseau / SMB mocks (`tests/network_source.rs`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 7.1 | Ajouter source réseau (mock) | Enregistrée avec IP, chemin, credentials |
| 7.2 | Connexion réussie (mock) | Statut = Connected |
| 7.3 | Connexion échouée (mock) | Statut = Error |
| 7.4 | Déconnexion timeout (mock) | Reconnexion programmée |
| 7.5 | Cache local après scan | Metadata accessibles sans réseau |
| 7.6 | Source down → library navigable | Cache accessible, playback échoue |
| 7.7 | Buffering copie locale | Fichier copié vers /tmp |
| 7.8 | Suppression source | Source retirée, cache nettoyé |

### Module 8 — Commandes Tauri (`tests/tauri_commands.rs`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 8.1 | play chemin valide | Ok, state = Playing |
| 8.2 | play chemin invalide | Erreur, state = Stopped |
| 8.3 | pause pendant lecture | Ok, state = Paused |
| 8.4 | resume après pause | Ok, state = Playing |
| 8.5 | stop | Ok, state = Stopped |
| 8.6 | seek position valide | Ok, position retournée |
| 8.7 | seek position négative | Erreur, pas de crash |
| 8.8 | get_library | Liste JSON |
| 8.9 | search avec terme | Résultats correspondants |
| 8.10 | search terme vide | Pas de panic |

## Tests Frontend (`npm test`)

> Note : le frontend est en Vanilla JS (pas React). Les tests utilisent Jest + jsdom.

### Module 9 — Affichage formats (`__tests__/FormatDisplay.test.js`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 9.1 | FLAC 24-bit/192kHz | Affiche "24-bit / 192kHz" |
| 9.2 | MP3 320kbps | Affiche "320 kbps" |
| 9.3 | WAV 16-bit/44.1kHz | Affiche "16-bit / 44.1kHz" |
| 9.4 | Données manquantes | Fallback gracieux, pas de crash |

### Module 10 — Navigation (`__tests__/Navigation.test.js`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 10.1 | Home → Album → retour Home | Contenu identique, pas de re-fetch |
| 10.2 | Page artiste 200 tracks | Rend sans crash |
| 10.3 | Recherche clic artiste | Navigation vers page artiste |
| 10.4 | Recherche 30 résultats | Affiche jusqu'à 30 |

### Module 11 — Player controls (`__tests__/PlayerControls.test.js`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 11.1 | Clic Play | Appelle play |
| 11.2 | Clic Pause | Appelle pause |
| 11.3 | Clic Skip Next | Appelle skip_next |
| 11.4 | Clic Skip Previous | Appelle skip_previous |
| 11.5 | Clic progress bar 50% | Appelle seek ~50% |
| 11.6 | Temps affiché | Formaté mm:ss |

### Module 12 — Vue album (`__tests__/AlbumView.test.js`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 12.1 | Album 10 tracks | Ordre des track numbers |
| 12.2 | Multi-disques | Disque 1 avant disque 2 |
| 12.3 | Pas de doublons | Chaque track une seule fois |
| 12.4 | Pochette | Chemin full-size, pas thumbnail |

## Fichiers de test à générer

| Fichier | Description |
|---------|-------------|
| `test_44100_16.flac` | Sinusoïde 440Hz, 3s, 44100Hz, 16-bit, tagué (titre: "Test 44.1", artiste: "Noir Test", album: "Test Album", track: 1) |
| `test_96000_24.flac` | Sinusoïde 440Hz, 3s, 96000Hz, 24-bit, tagué (track: 2) |
| `test_192000_24.flac` | Sinusoïde 440Hz, 3s, 192000Hz, 24-bit, tagué (track: 3) |
| `test_44100_16.wav` | Sinusoïde 440Hz, 3s, 44100Hz, 16-bit |
| `test_44100_16.aiff` | Sinusoïde 440Hz, 3s, 44100Hz, 16-bit |
| `test_320.mp3` | Sinusoïde 440Hz, 3s, 320kbps CBR, tagué ID3v2 |
| `test_vbr.mp3` | Sinusoïde 440Hz, 3s, VBR |
| `test_corrupted.flac` | Fichier tronqué |
| `test_notaudio.txt` | Fichier texte |
| `test_empty.flac` | FLAC valide, 0 sample |
| `test_cover.flac` | FLAC avec pochette JPEG embarquée |
| `test_no_tags.flac` | FLAC sans aucun tag |
| `test_multidisc_d1t1.flac` | Disc 1, Track 1 |
| `test_multidisc_d1t2.flac` | Disc 1, Track 2 |
| `test_multidisc_d2t1.flac` | Disc 2, Track 1 |

Si tu ne peux pas générer certains formats, utilise de très petits fichiers binaires encodés en base64, ou `ffmpeg` si disponible.

## Organisation

```
src-tauri/
├── tests/
│   ├── fixtures/
│   ├── audio_decode.rs
│   ├── audio_seek.rs
│   ├── ring_buffer.rs
│   ├── metadata.rs
│   ├── library_scanner.rs
│   ├── queue.rs
│   ├── network_source.rs
│   └── tauri_commands.rs
src/
├── __tests__/
│   ├── FormatDisplay.test.js
│   ├── Navigation.test.js
│   ├── PlayerControls.test.js
│   └── AlbumView.test.js
```

## Important

Ne modifie PAS le code existant de l'application pour créer les tests. Les tests testent le code TEL QU'IL EST. Si un test échoue, c'est un bug à documenter — pas une raison de modifier le test.

**Exception :** si une fonction n'est pas publique et doit être testée, tu peux la rendre `pub(crate)`.

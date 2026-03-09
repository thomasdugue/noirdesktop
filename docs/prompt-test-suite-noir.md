# Suite de tests Noir Desktop — Prompt Claude Code

## Contexte

On travaille sur Noir Desktop, un player audiophile macOS (Rust/Tauri + React).
Le projet grossit et on a des régressions à chaque session de travail.

**Objectif :** Créer une suite de tests (`cargo test` + tests frontend) qui vérifie tous les comportements critiques de l'app. Ces tests doivent tourner **sans DAC branché, sans NAS connecté, sans fichiers audio personnels** — utilise des fichiers de test embarqués, des mocks et des assertions.

Ces tests seront lancés **avant et après chaque session de travail** pour détecter les régressions.

---

## Règles

- Les tests doivent être autonomes : `cargo test` et `npm test` suffisent, aucune configuration manuelle
- Embarquer des petits fichiers de test dans le repo (générer des fichiers audio synthétiques de quelques secondes si nécessaire — sinusoïde, silence, etc.)
- Mocker les interactions hardware (CoreAudio, DAC, réseau, système de fichiers réseau)
- Chaque test a un nom clair qui décrit le comportement vérifié
- Les tests doivent être rapides (< 30 secondes pour la suite complète)
- Organiser les tests par module (un fichier de test par domaine)

---

## Tests Backend Rust (`cargo test`)

### Module 1 — Décodage audio (`tests/audio_decode.rs`)

Vérifier que le décodeur (Symphonia) lit correctement tous les formats supportés.

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

**Fichiers de test :** Générer des fichiers synthétiques (sinusoïde 440Hz, 3 secondes) dans chaque format lors du build des tests. Utiliser `hound` pour WAV, un encodeur FLAC basique, etc. OU embarquer de très petits fichiers binaires dans `tests/fixtures/`.

---

### Module 2 — Seek et position (`tests/audio_seek.rs`)

Vérifier que le seek place le décodeur à la bonne position.

| # | Test | Comportement attendu |
|---|------|---------------------|
| 2.1 | Seek à 0% (début) | La position retournée est 0 |
| 2.2 | Seek à 50% | La position retournée est ~50% de la durée totale (±100ms) |
| 2.3 | Seek à 100% (fin) | Pas de panic, le décodeur est à la fin ou retourne fin de fichier |
| 2.4 | Seek en avant (de 10s à 30s) | Position = ~30s |
| 2.5 | Seek en arrière (de 30s à 5s) | Position = ~5s |
| 2.6 | 10 seeks rapides consécutifs | Aucun panic, aucune corruption, position finale correcte |
| 2.7 | Seek sur un fichier FLAC | Fonctionne correctement |
| 2.8 | Seek sur un fichier MP3 | Fonctionne correctement (MP3 seek est notoirement imprécis — tolérance ±500ms) |
| 2.9 | Seek après la fin du fichier | Pas de panic, géré proprement |

---

### Module 3 — RingBuffer (`tests/ring_buffer.rs`)

Vérifier que le ring buffer fonctionne correctement (structure critique partagée entre le thread de décodage et le callback audio).

| # | Test | Comportement attendu |
|---|------|---------------------|
| 3.1 | Écrire puis lire N samples | Les samples lus sont identiques aux samples écrits, dans le bon ordre |
| 3.2 | Écrire plus que la capacité | Les données les plus anciennes sont écrasées OU l'écriture bloque (selon l'implémentation) — pas de panic |
| 3.3 | Lire un buffer vide | Retourne des zéros ou bloque — pas de panic, pas de données corrompues |
| 3.4 | Flush du buffer | Après un flush, la lecture retourne des zéros ou bloque. Le buffer est vide. |
| 3.5 | Écriture et lecture concurrentes (2 threads) | Pas de data race, pas de corruption. Les samples lus correspondent aux samples écrits. |
| 3.6 | Pre-fill après flush | Après flush + pre-fill de N samples, la lecture retourne exactement ces N samples |

---

### Module 4 — Metadata et formats (`tests/metadata.rs`)

Vérifier l'extraction correcte des métadonnées de chaque format.

| # | Test | Comportement attendu |
|---|------|---------------------|
| 4.1 | Extraire metadata d'un FLAC tagué | Retourne titre, artiste, album, numéro de track, année, genre |
| 4.2 | Extraire metadata d'un MP3 (ID3v2) tagué | Retourne titre, artiste, album, numéro de track |
| 4.3 | Extraire metadata d'un WAV tagué | Retourne ce qui est disponible (WAV a des tags limités) |
| 4.4 | Extraire metadata d'un ALAC (M4A) tagué | Retourne titre, artiste, album |
| 4.5 | Fichier sans aucun tag | Retourne des champs vides ou "Unknown", pas de panic |
| 4.6 | Extraire la pochette embarquée d'un FLAC | Retourne des bytes d'image (JPEG ou PNG), taille > 0 |
| 4.7 | Fichier sans pochette embarquée | Retourne None ou vide, pas de panic |
| 4.8 | Extraire le numéro de disque | Retourne le disc number si présent dans les tags |
| 4.9 | Format display : FLAC 24/192 | La fonction retourne "24-bit / 192kHz" |
| 4.10 | Format display : MP3 320kbps | La fonction retourne "320 kbps" |
| 4.11 | Format display : MP3 VBR ~245kbps | La fonction retourne "~245 kbps" ou "VBR" |
| 4.12 | Format display : WAV 16/44.1 | La fonction retourne "16-bit / 44.1kHz" |

---

### Module 5 — Library / Scanner (`tests/library_scanner.rs`)

Vérifier le scan, l'indexation, et la détection de doublons.

| # | Test | Comportement attendu |
|---|------|---------------------|
| 5.1 | Scanner un dossier avec 5 fichiers audio | Retourne 5 entrées dans la library, chacune avec chemin + metadata |
| 5.2 | Scanner un dossier avec des fichiers non-audio (.jpg, .txt, .log) | Les fichiers non-audio sont ignorés, seuls les audio sont indexés |
| 5.3 | Scanner un dossier vide | Retourne une library vide, pas de panic |
| 5.4 | Scanner un dossier qui n'existe pas | Retourne une erreur propre |
| 5.5 | Un fichier = une entrée (pas de doublons) | Scanner deux fois le même dossier → le nombre d'entrées ne change pas |
| 5.6 | Scan incrémental : ajout d'un fichier | Après ajout d'un fichier dans le dossier, le re-scan ajoute uniquement le nouveau fichier |
| 5.7 | Scan incrémental : suppression d'un fichier | Après suppression d'un fichier, le re-scan le retire de la library |
| 5.8 | Tri des tracks par disc number puis track number | Les tracks d'un album sont retournées triées par disc_number ASC, track_number ASC |
| 5.9 | Tri fallback par nom de fichier | Si pas de tag track number, les tracks sont triées par nom de fichier |
| 5.10 | Détection de doublons (même titre + artiste + album + durée) | Les doublons sont détectés et flaggés, pas supprimés |

**Setup de test :** Créer un dossier temporaire (`tempdir`) avec des fichiers audio synthétiques. Nettoyer après le test.

---

### Module 6 — Queue et playlist (`tests/queue.rs`)

Vérifier la gestion de la file d'attente et des playlists.

| # | Test | Comportement attendu |
|---|------|---------------------|
| 6.1 | Ajouter un morceau à la queue | La queue contient 1 élément |
| 6.2 | Ajouter 10 morceaux | La queue contient 10 éléments dans le bon ordre |
| 6.3 | Skip next | Le morceau courant avance au suivant dans la queue |
| 6.4 | Skip next sur le dernier morceau | Comportement défini (stop ou boucle) — pas de panic |
| 6.5 | Skip previous | Le morceau courant revient au précédent |
| 6.6 | Skip previous sur le premier morceau | Reste sur le premier morceau — pas de panic |
| 6.7 | Vider la queue | La queue est vide, pas de morceau courant |
| 6.8 | Shuffle activé | L'ordre de la queue est différent de l'ordre original (test probabiliste sur 20+ morceaux) |
| 6.9 | Repeat one | Après la fin du morceau courant, le même morceau est remis en tête |
| 6.10 | Repeat all | Après le dernier morceau, la queue repart au premier |
| 6.11 | Créer une playlist avec nom | La playlist est créée, contient les bons morceaux, le nom est correct |
| 6.12 | Supprimer un morceau de la playlist | Le morceau est retiré, les autres restent dans le bon ordre |

---

### Module 7 — Source réseau / SMB (mocks) (`tests/network_source.rs`)

Vérifier la logique de connexion et de cache réseau SANS vrai NAS.

| # | Test | Comportement attendu |
|---|------|---------------------|
| 7.1 | Ajouter une source réseau (mock) | La source est enregistrée avec IP, chemin, credentials |
| 7.2 | Connexion réussie (mock) | Statut = Connected |
| 7.3 | Connexion échouée (IP invalide, mock) | Statut = Error, message d'erreur clair |
| 7.4 | Déconnexion après timeout (mock) | Statut = Disconnected, tentative de reconnexion automatique programmée |
| 7.5 | Cache local des metadata après scan réseau | Après un scan (mock), les metadata sont stockées localement. Un 2e accès ne nécessite pas de connexion réseau |
| 7.6 | Source réseau indisponible → library reste navigable | Si la source est down, les metadata en cache restent accessibles. Seul le playback échoue. |
| 7.7 | Buffering : fichier réseau copié localement avant lecture | La fonction de buffering copie un fichier (mock) vers /tmp et retourne le chemin local |
| 7.8 | Suppression d'une source réseau | La source est retirée de la liste, le cache associé est nettoyé |

---

### Module 8 — Commandes Tauri (`tests/tauri_commands.rs`)

Vérifier que les commandes Tauri (l'interface entre le frontend et le backend) fonctionnent.

| # | Test | Comportement attendu |
|---|------|---------------------|
| 8.1 | Commande `play` avec un chemin valide | Retourne Ok, le state passe à Playing |
| 8.2 | Commande `play` avec un chemin invalide | Retourne une erreur structurée, le state reste Stopped |
| 8.3 | Commande `pause` pendant la lecture | Retourne Ok, le state passe à Paused |
| 8.4 | Commande `resume` après pause | Retourne Ok, le state passe à Playing |
| 8.5 | Commande `stop` | Retourne Ok, le state passe à Stopped |
| 8.6 | Commande `seek` avec position valide | Retourne Ok avec la nouvelle position |
| 8.7 | Commande `seek` avec position négative | Retourne une erreur, pas de crash |
| 8.8 | Commande `get_library` | Retourne la liste des morceaux en JSON |
| 8.9 | Commande `search` avec un terme | Retourne les résultats correspondants |
| 8.10 | Commande `search` avec un terme vide | Retourne une liste vide ou tous les résultats — pas de panic |

---

## Tests Frontend React (`npm test`)

### Module 9 — Affichage des formats (`tests/FormatDisplay.test.tsx`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 9.1 | Composant format avec FLAC 24-bit/192kHz | Affiche "24-bit / 192kHz" |
| 9.2 | Composant format avec MP3 320kbps | Affiche "320 kbps" |
| 9.3 | Composant format avec WAV 16-bit/44.1kHz | Affiche "16-bit / 44.1kHz" |
| 9.4 | Composant format avec données manquantes | Affiche "—" ou fallback gracieux, pas de crash |

### Module 10 — Navigation et état des pages (`tests/Navigation.test.tsx`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 10.1 | Naviguer vers Home, puis Album, puis retour Home | Le contenu de Home est identique (même données, pas de re-fetch) |
| 10.2 | Page artiste avec mock de 200 tracks | Le composant rend sans crash (vérifier que la virtualisation est en place) |
| 10.3 | Recherche : cliquer sur un artiste dans les résultats | La navigation va vers la page artiste |
| 10.4 | Recherche : afficher au moins 30 résultats | Le composant affiche jusqu'à 30 résultats si disponibles |

### Module 11 — Player controls (`tests/PlayerControls.test.tsx`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 11.1 | Clic sur Play | Appelle la commande Tauri `play` |
| 11.2 | Clic sur Pause | Appelle la commande Tauri `pause` |
| 11.3 | Clic sur Skip Next | Appelle la commande Tauri `skip_next` |
| 11.4 | Clic sur Skip Previous | Appelle la commande Tauri `skip_previous` |
| 11.5 | Clic sur la progress bar à 50% | Appelle la commande Tauri `seek` avec ~50% de la durée |
| 11.6 | Affichage du temps actuel et durée totale | Les deux valeurs sont formatées en mm:ss |

### Module 12 — Vue album (`tests/AlbumView.test.tsx`)

| # | Test | Comportement attendu |
|---|------|---------------------|
| 12.1 | Afficher un album avec 10 tracks | Les 10 tracks sont affichées dans l'ordre des track numbers |
| 12.2 | Album multi-disques | Le disque 1 est affiché avant le disque 2 |
| 12.3 | Pas de tracks en double | Chaque track n'apparaît qu'une seule fois dans la vue |
| 12.4 | Pochette en haute résolution | L'image de la pochette utilise le chemin full-size (pas le thumbnail) |

---

## Fichiers de test à générer

Lors du setup de la suite de tests, générer (ou embarquer) ces fichiers :

| Fichier | Description |
|---------|-------------|
| `test_44100_16.flac` | Sinusoïde 440Hz, 3 secondes, 44100Hz, 16-bit, tagué (titre: "Test 44.1", artiste: "Noir Test", album: "Test Album", track: 1) |
| `test_96000_24.flac` | Sinusoïde 440Hz, 3 secondes, 96000Hz, 24-bit, tagué (track: 2) |
| `test_192000_24.flac` | Sinusoïde 440Hz, 3 secondes, 192000Hz, 24-bit, tagué (track: 3) |
| `test_44100_16.wav` | Sinusoïde 440Hz, 3 secondes, 44100Hz, 16-bit |
| `test_44100_16.aiff` | Sinusoïde 440Hz, 3 secondes, 44100Hz, 16-bit |
| `test_320.mp3` | Sinusoïde 440Hz, 3 secondes, 320kbps CBR, tagué (ID3v2) |
| `test_vbr.mp3` | Sinusoïde 440Hz, 3 secondes, VBR |
| `test_corrupted.flac` | Fichier tronqué / corrompu |
| `test_notaudio.txt` | Fichier texte "This is not audio" |
| `test_empty.flac` | Fichier FLAC valide mais 0 sample |
| `test_cover.flac` | Fichier FLAC avec pochette JPEG embarquée |
| `test_no_tags.flac` | Fichier FLAC sans aucun tag |
| `test_multidisc_d1t1.flac` | Disc 1, Track 1 |
| `test_multidisc_d1t2.flac` | Disc 1, Track 2 |
| `test_multidisc_d2t1.flac` | Disc 2, Track 1 |

Si tu ne peux pas générer certains formats programmatiquement (MP3, ALAC), utilise des fichiers binaires très petits encodés en base64 dans le code de test, ou utilise `ffmpeg` dans le build script si disponible.

---

## Comment organiser

```
src-tauri/
├── tests/
│   ├── fixtures/           ← fichiers audio de test
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
│   ├── FormatDisplay.test.tsx
│   ├── Navigation.test.tsx
│   ├── PlayerControls.test.tsx
│   └── AlbumView.test.tsx
```

---

## Ce qui ne doit PAS changer

Ne modifie PAS le code existant de l'application pour créer les tests.
Les tests doivent tester le code TEL QU'IL EST.
Si un test échoue, c'est un bug à corriger ensuite — pas une raison de modifier le test.
Exception : si une fonction n'est pas publique et doit être testée, tu peux la rendre `pub(crate)`.

---

## Commandes de validation

Après l'implémentation, je dois pouvoir lancer :

```bash
# Backend
cargo test 2>&1 | tail -20

# Frontend
npm test -- --watchAll=false 2>&1 | tail -20
```

Et voir le résultat de TOUS les tests en une commande.

---

## Protocole de début et fin de session

### DÉBUT de session

```
1. Lis CLAUDE.md
2. Lance `cargo test` — note les résultats
3. Lance `npm test -- --watchAll=false` — note les résultats
4. Si des tests échouent AVANT de commencer → dis-le moi, on corrige d'abord
5. Fais un commit "checkpoint avant [tâche du jour]"
```

### FIN de session

```
1. Lance `cargo test` — compare avec les résultats du début
2. Lance `npm test -- --watchAll=false` — compare avec les résultats du début
3. Si des tests qui passaient avant échouent maintenant → RÉGRESSION → corrige avant de terminer
4. Si de nouveaux tests échouent à cause de ton travail → corrige ou documente pourquoi
5. Mets à jour CLAUDE.md avec ce qu'on a fait/décidé
6. Fais un commit "[tâche du jour] terminée"
```

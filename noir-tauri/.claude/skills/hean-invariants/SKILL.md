---
name: hean-invariants
description: Règles « ne JAMAIS casser » de Hean et décisions techniques actées. Charger AVANT toute modif de code (JS ou Rust), avant une review de diff, ou quand on touche à library.albums, excluded_paths, METADATA_CACHE/write_metadata, background scan, SMB retry/credentials, mosaïques playlist, Sentry before_send, option_env!, dylibbundler, CoreAudio/CPAL, media keys.
---

# hean-invariants — ce qui ne doit jamais casser

Source de vérité des invariants (le CLAUDE.md n'en garde qu'un résumé d'une ligne). Chaque règle ici a été payée par une régression réelle.

## Invariants protégés par des tests (ne JAMAIS casser)

- **Un album = une seule entrée dans `library.albums`.** Quel que soit le nombre d'artistes différents dans les tracks d'un album, il doit produire exactement UNE entrée dans `library.albums`. La clé d'album est normalisée via `normalizeKey()` (trim + NFC). **Jamais** de clé brute `track.metadata.album` — toujours `normalizeKey(track.metadata.album)`. Tests : Module 13 (AlbumGrouping.test.js), tests 13.5–13.7.
- **Pas de duplication visuelle sur la homepage.** La section "Recently Played" déduplique par album (clé composite `artiste|||album`), pas seulement par chemin de fichier. Un même album ne doit apparaître qu'une seule fois même si plusieurs tracks ont été écoutées.
- **SMB : connexion périmée = retry automatique.** `read_file_to_temp_progressive()` doit tenter un retry avec reconnexion fraîche si `open_with()` échoue (connexion expirée). Ne JAMAIS supprimer ce mécanisme de retry.
- **SMB : credentials = gestion d'erreur explicite.** `retrieve_password()` ne doit JAMAIS utiliser `unwrap_or_default()`. Un échec Keychain doit retourner une erreur claire à l'utilisateur, pas un mot de passe vide silencieux.
- **SMB : propagation d'erreur du thread de download.** `LAST_DOWNLOAD_ERROR` stocke l'erreur du thread de download. `audio_play` doit la récupérer via `take_last_download_error()` quand `bytes_written == 0` pour afficher l'erreur réelle au lieu d'un message générique.
- **Suppression de tracks = PERMANENTE.** Quand l'utilisateur supprime des tracks de la bibliothèque, elles ne doivent JAMAIS revenir, même après redémarrage ou re-scan NAS. Mécanisme : `excluded_paths` dans `config.json`. Défense en profondeur — les `excluded_paths` DOIVENT être vérifiés à CHAQUE point d'entrée :
  1. `init_cache()` : filtre les tracks exclues au chargement du cache depuis le disque
  2. `start_background_scan()` : filtre les tracks locales via `excluded_paths` + filtre les SMB tracks préservées
  3. `scan_network_source_cmd()` : filtre les tracks NAS re-scannées par `excluded_paths`
  Ne JAMAIS ajouter un code path qui charge ou scanne des tracks sans vérifier `excluded_paths`.
- **Métadonnées éditées = écrites dans le fichier audio.** `write_metadata()` doit TOUJOURS écrire les tags dans le fichier audio réel (via lofty), pas seulement dans le cache. Le cache est un accélérateur, pas la source de vérité — la source de vérité est le fichier audio.
- **METADATA_CACHE : UPDATE, jamais REMOVE.** `write_metadata()` doit mettre à jour l'entrée `METADATA_CACHE` avec les nouvelles valeurs (`get_mut` + set champs), PAS la supprimer. La suppression créait une race condition fatale : le background scan (concurrent) re-lisait le fichier audio (pas encore écrit par lofty), réinsérait les anciennes métadonnées dans `METADATA_CACHE`, et cette corruption persistait indéfiniment. L'update garantit que : (1) `get_metadata_internal()` retourne les valeurs les plus récentes, (2) `scan_folder_with_metadata()` ne réinsère pas de données stale (check `!contains_key`). Ne JAMAIS revenir à `cache.entries.remove()` dans `write_metadata()`.
- **`start_background_scan()` : re-application METADATA_CACHE.** Après `cache.tracks = all_tracks`, les métadonnées de chaque track doivent être re-synchronisées depuis un snapshot de `METADATA_CACHE` (pris AVANT le lock `TRACKS_CACHE` pour éviter le deadlock). Cela capture les user edits qui ont eu lieu pendant le scan. Ne JAMAIS supprimer cette re-application.
- **METADATA_CACHE : jamais de stale data.** `get_metadata_internal()` vérifie `METADATA_CACHE` avant de lire le fichier. L'update dans `write_metadata()` + la re-application dans `start_background_scan()` garantissent que les user edits ne sont jamais perdus. Ne JAMAIS retirer le `save_metadata_cache_to_file()` dans `write_metadata()`.
- **Playlist mosaic covers : déduplication par album seul.** `getPlaylistAlbumCovers()` déduplique par `album.trim().normalize('NFC')` (nom d'album seul), identique à la clé de `library.albums`. **Ne JAMAIS dédupliquer par `artist+album`** — les variations "feat." dans les noms d'artistes créent de faux albums distincts (même pochette dupliquée × N dans la mosaïque). Régression constatée 2026-03-16.
- **Playlist mosaic covers : fallback internet OBLIGATOIRE.** `loadPlaylistThumbs()` DOIT avoir 4 niveaux de fallback : (1) `thumbnailCache`/`coverCache` → (2) `get_cover_thumbnail` → (3) `get_cover` → (4) `fetch_internet_cover(artist, album)`. Sans le niveau 4, les albums sans cover embarquée (cover récupérée uniquement via MusicBrainz/Deezer) affichent une cellule noire. Les attributs `data-cover-artist` et `data-cover-album` DOIVENT être injectés par `buildPlaylistThumbHtml` pour que le fallback fonctionne.
- **Playlist mosaic sidebar : CSS positionnement absolu (pas Grid) pour le petit mosaïque 28×28.** Bug récurrent (fixé 4× avant 2026-05-19). Le CSS Grid de petite taille (28×28) cause des bugs WebKit où les cellules vides résolvent `height:100%` contre le container au lieu du grid area. Fix définitif CSS : positionnement absolu avec `calc(50% - 0.5px)` pour chaque cellule nth-child. Le grand mosaïque (96×96) utilise toujours CSS Grid (pas de bug à cette taille). **Ne JAMAIS revenir au CSS Grid pour `.playlist-cover-grid-sm`.**
- **Playlist mosaic sidebar : rebuild automatique après chargement async des covers.** Bug récurrent (fixé 2026-05-19). Root cause : `updatePlaylistsSidebar()` est appelé au démarrage AVANT que les covers soient en cache. `loadPlaylistThumbs()` charge les covers en async, mais si un autre `updatePlaylistsSidebar()` arrive entre-temps, le HTML est remplacé et les cellules déconnectées. Les covers finissent dans le cache mais ne sont jamais affichées. Fix définitif : (1) `buildPlaylistThumbHtml()` injecte les covers en inline style depuis le cache via `cellHtml()`, (2) `loadPlaylistThumbs()` skip les cellules `has-cover`, compte les nouvelles covers chargées, et schedule UN rebuild via `requestAnimationFrame` si `newCoversLoaded > 0`, (3) guard `_thumbsRefreshScheduled` empêche la boucle infinie. Au 2e passage, `cellHtml()` trouve les covers dans le cache → inline style → cellules `has-cover` → `loadPlaylistThumbs` skip tout → pas de 3e rebuild. **Ne JAMAIS supprimer le rebuild automatique dans `loadPlaylistThumbs()`.**
- **Boutons 'Add to Queue' et 'Add to Playlist' au survol des tracks.** Les règles CSS `.track-add-queue` et `.track-add-playlist` (opacity 0 → 1 au hover de `.playlist-track-item`) ne doivent PAS être supprimées. Régression constatée si ces règles sont absentes.
- **Sentry `before_send` doit drop les events si `SENTRY_ENABLED.load(Relaxed) == false`.** Sans ce check, désactiver le toggle dans Settings ne stoppe pas l'envoi des events qui sont déjà dans le hub Sentry. Le test unitaire `scrubs_*` couvre l'anonymisation des paths mais pas le toggle — vérifier visuellement après chaque modif de `sentry_init.rs`.
- **`option_env!()` doit être utilisé pour TOUS les secrets compile-time** (`HEAN_SENTRY_DSN`, `NOIR_WORKER_URL`, `NOIR_WORKER_SECRET`). Sans ça, le binaire release est silencieusement privé du secret (pas d'erreur runtime, juste un fallback "save locally" / "no Sentry"). `scripts/release.sh` valide la présence des vars AVANT le build pour éviter ce piège — ne JAMAIS bypass ce script en lançant `npm run tauri build` à nu.
- **`dylibbundler` doit être suivi du fix LC_RPATH dupliqués.** dylibbundler ajoute systématiquement un `LC_RPATH @executable_path/../Frameworks/` à chaque dylib mais certaines dylibs Samba en avaient déjà un (Homebrew). 66/92 dylibs ont des doublons → macOS dyld refuse depuis Big Sur. Le pipeline doit : (1) `dylibbundler` → (2) boucle sur Frameworks/ qui détecte les doublons et fait `install_name_tool -delete_rpath` une seule fois → (3) re-sign chaque dylib touchée. Ne JAMAIS oublier l'étape 2.

## Gravité (utilisée pour décider si un diff peut être mergé)

Classement décidé par Thomas le 2026-10-27. Critère : ce que vit le testeur si la règle casse. Perte de données, app inutilisable, risque légal ou sécurité → BLOQUANT. Défaut visuel ou gênant mais réparable → AVERTISSEMENT. Une nouvelle règle ajoutée sans gravité est BLOQUANT par défaut jusqu'à ce que Thomas la classe.

**🔴 BLOQUANT** — le merge est refusé :
- **Un album = une seule entrée dans `library.albums`** (un album coupé en deux est inacceptable pour les testeurs)
- **SMB : connexion périmée = retry automatique**
- **SMB : credentials = gestion d'erreur explicite** (mot de passe vide → risque de verrouillage du compte NAS)
- **Suppression de tracks = PERMANENTE**
- **Métadonnées éditées = écrites dans le fichier audio**
- **METADATA_CACHE : UPDATE, jamais REMOVE**
- **`start_background_scan()` : re-application METADATA_CACHE**
- **METADATA_CACHE : jamais de stale data**
- **Sentry `before_send` drop les events si `SENTRY_ENABLED` est false** (RGPD)
- **`option_env!()` pour TOUS les secrets compile-time**
- **`dylibbundler` suivi du fix LC_RPATH dupliqués** (sinon crash au lancement)

**🟡 AVERTISSEMENT** — signalé, Thomas décide :
- **Pas de duplication visuelle sur la homepage**
- **SMB : propagation d'erreur du thread de download** (seul le message d'erreur se dégrade)
- **Playlist mosaic covers : déduplication par album seul**
- **Playlist mosaic covers : fallback internet OBLIGATOIRE**
- **Playlist mosaic sidebar : positionnement absolu (pas Grid) pour le 28×28**
- **Playlist mosaic sidebar : rebuild automatique après chargement async**
- **Boutons 'Add to Queue' / 'Add to Playlist' au survol** (toujours accessibles par clic droit)

## Décisions techniques actées

- **Audio engine = coreaudio-rs.** CPAL a été remplacé car il ne donnait pas assez de contrôle sur le buffer interne CoreAudio (seek cassé, pas d'accès à AudioUnitReset, pas de contrôle du buffer size). **NE JAMAIS revenir à CPAL.**
- **Bit-perfect = pas de resampling.** Le sample rate du device doit correspondre au sample rate du fichier. Hog mode pour accès exclusif au DAC.
- **Dynamic sample rate switching** entre morceaux de sample rates différents.
- **Affichage format :** lossless (FLAC, ALAC, WAV, AIFF) → "24-bit / 192kHz". Lossy (MP3, AAC, OGG) → "320 kbps". Partout dans l'interface, sans exception.
- **Thumbnails des pochettes :** format léger (WebP/JPEG), générées au scan, utilisées dans les listes/carrousels. Pleine résolution uniquement sur la page album.
- **Un fichier audio = une entrée en base.** Jamais de doublons pour un même chemin.
- **Tracks triées par** `disc_number` ASC puis `track_number` ASC. Fallback : nom de fichier.
- **Page d'accueil :** contenu calculé une fois au lancement, stable pendant la session.
- **SMB réseau :** connexion native gérée par Noir (pas par Finder). Cache local des metadata. Buffering : copie locale avant lecture pour éviter la latence réseau.
- **Media keys macOS :** souvlaki (`MPRemoteCommandCenter`) utilisé pour que Noir prenne le contrôle des touches multimédia même quand Apple Music tourne. Les global shortcuts Tauri `MediaPlayPause/MediaTrackNext/MediaTrackPrevious` ne suffisent pas — Apple Music les intercepte en priorité. **Ne jamais réajouter F7/F8/F9 comme global shortcuts Tauri.**
- **Navigation séquentielle en vue tracks :** toujours utiliser `ui.tracksViewOrder` (paths dans l'ordre visuel trié/filtré), jamais `library.tracks[currentTrackIndex ± 1]`. L'ordre de `library.tracks` est l'ordre de scan, qui diffère du tri visuel.
- **Sentry = un seul DSN côté Rust.** Pas de SDK `@sentry/browser` JS (1.5MB minifié, lourd, pas de bundler). Les erreurs JS sont forwardées via `invoke('report_js_error')` → `sentry::capture_event()` côté Rust. Économie + 1 seul projet Sentry à monitorer + pas de double-comptage.
- **Tokens secrets compile-time only.** `option_env!()` lit les env vars à la compilation, pas au runtime. **Ne JAMAIS** stocker un token (Sentry DSN, GitHub feedback, Tauri signing key) dans le runtime — toujours via `option_env!`. Wrapper `release.sh` valide les vars AVANT le build pour éviter les builds release silencieusement sans secrets.
- **Cloudflare Worker pour le feedback** (au lieu d'un GitHub PAT compile-time dans le binaire). Le binaire ne contient plus de credentials GitHub — uniquement l'URL du worker + un secret partagé. Le worker tient le `GITHUB_TOKEN` côté serveur. Si le binaire fuit, le pire qui arrive c'est qu'on doit révoquer le `NOIR_SECRET` (pas un token GitHub avec des droits étendus).
- **Dylib bundling pour libsmbclient.** Sur macOS, `pavao` linke contre `libsmbclient.0.8.1.dylib` qui dépend transitivement de ~92 dylibs Samba (Homebrew). Sans bundling, l'app crash au lancement chez tous les Macs sans Homebrew. Pipeline release.sh : `dylibbundler` → fix LC_RPATH dupliqués (`install_name_tool -delete_rpath`) → re-sign chaque dylib + l'app entière → notariser. **Ne JAMAIS skipper le bundling**, sous peine de DMG inutilisables chez les testeurs.
- **DMG ET app sont notarisés séparément.** Tauri notarise l'app mais pas le DMG. Sans notarisation explicite du DMG (`xcrun notarytool submit Hean_*.dmg`), Gatekeeper refuse le DMG même si l'app à l'intérieur est OK. Toujours notariser les deux + stapler les deux.
- **Privacy toggle = `AtomicBool` runtime + persistence config.json.** Le toggle dans Settings → Privacy ne nécessite pas de redémarrage SI Sentry était init au boot (le `before_send` callback check l'AtomicBool à chaque event). Si Sentry n'a pas été init au boot (`enabled=false` au démarrage), le toggle persiste mais ne prend effet qu'au prochain reboot. UI affiche un hint "Restart Hean to enable error reporting" dans ce cas.

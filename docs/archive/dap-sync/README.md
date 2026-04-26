# DAP Sync — Archive

**Statut** : feature retirée du build actif le **2026-04-22** avant le lancement de la beta de Hean, en raison de bugs d'instabilité non résolus sur le mode MTP (Transaction ID mismatch, timeouts, InvalidObjectHandle).

## Pourquoi cette archive

La feature DAP Sync (synchronisation de la bibliothèque musicale vers un Digital Audio Player) représentait environ **10 000 lignes** de code (2 957 JS frontend + ~6 980 Rust backend), **15 commandes Tauri**, et plusieurs mois d'investigation. Plutôt que de la supprimer définitivement ou de la laisser pourrir dans le code actif, on a choisi :

1. **Archiver** le code source dans une branche git dédiée + un tag annoté — pour pouvoir le réimporter sans friction
2. **Consolider la mémoire du projet** dans ce dossier — pour ne rien perdre des décisions, investigations et bugs connus

## Accéder au code archivé

- **Branche** : `archive/dap-sync-v1` (pushée sur `origin`)
- **Tag** : `dap-sync-archive-2026-04` (commit `c901ba2` sur `main`)

```bash
# Voir le code archivé
git checkout archive/dap-sync-v1
git log archive/dap-sync-v1

# Ou inspecter le tag
git show dap-sync-archive-2026-04
```

## Contenu de ce dossier

| Fichier | Rôle |
|---|---|
| [OVERVIEW.md](OVERVIEW.md) | Architecture globale : 3 modes de sync, modules Rust, module JS, commandes Tauri, tables SQLite, format manifest |
| [DECISIONS.md](DECISIONS.md) | Décisions techniques majeures + leur justification (perf, corruption exFAT, MTP, etc.) |
| [KNOWN_ISSUES.md](KNOWN_ISSUES.md) | Bugs non résolus au moment de l'archivage + pistes explorées |
| [REINTEGRATION.md](REINTEGRATION.md) | Mode d'emploi pas-à-pas pour réintégrer la feature plus tard |
| [TEST_PROTOCOL.md](TEST_PROTOCOL.md) | Protocole de test manuel (12 cas) |
| [TEST_EXECUTION_LOG.md](TEST_EXECUTION_LOG.md) | Journal d'exécution avec bugs observés sur FiiO JM21 |

## Statut des modes

| Mode | État au moment de l'archivage |
|---|---|
| **Mass Storage (USB/SD mountée)** | Fonctionnel mais pas stress-testé ; logique anti-corruption exFAT solide |
| **MTP (USB direct)** | Instable : Transaction ID mismatch sur retry, timeout sur gros albums (FiiO JM21) |
| **SMB comme source** | Fonctionnel pour la lecture mais `smb_utils` est partagé avec le streaming audio |

## Pour reprendre plus tard

Commencer par lire [KNOWN_ISSUES.md](KNOWN_ISSUES.md) puis [REINTEGRATION.md](REINTEGRATION.md). Les pré-requis pour reprendre MTP sont documentés dans les deux fichiers.

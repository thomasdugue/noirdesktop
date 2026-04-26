# DAP Sync — Bugs connus au moment de l'archivage

Ce document liste les bugs non résolus qui ont motivé le retrait de la feature pour la beta. Lire avant toute tentative de réintégration — certains sont connus depuis plusieurs semaines et n'ont pas trouvé de fix robuste.

**État des tests au moment de l'archivage** (voir `TEST_EXECUTION_LOG.md` pour les logs bruts) :

| Test | Résultat | Commentaire |
|------|----------|-------------|
| 1 — Détection device | ✅ | FiiO JM21 détecté au démarrage |
| 2 — Affichage albums | ✅ | Badges "on DAP" affichés correctement |
| 3 — Sync incrémental | ✅ | 0 copy / 0 delete quand rien à faire |
| 4 — Ajout album | ✅ | Badge "to add" → "on DAP" après sync |
| 5 — Badge "to remove" | ✅ | Décocher "on DAP" → "to remove" |
| 6 — Suppression album | ✅ | Fichiers + dossier vide supprimés |
| 7 — Ajout + suppression | ⚠️ | Voir Issue #1 — erreurs InvalidObjectHandle |
| 8 — Timeout album long | ❌ | Voir Issue #2 — Paco De Lucia timeout |
| 9 — Re-sync après erreur | ⚠️ | Voir Issue #3 — Transaction ID mismatch |
| 10 — Cancel mid-sync | ✅ | Toast "Sync cancelled" |
| 11 — Guard USB exclusif | ✅ | Management bloqué pendant sync |

---

## Issue #1 — `InvalidObjectHandle` sur delete MTP (~50 % de taux d'échec)

**Symptôme** : lors d'un sync MTP qui combine ajouts et suppressions, environ la moitié des deletes échouent avec :

```
[MTP] The Weeknd - After Hours/Disc 1/14 - Until I Bleed Out.flac — delete failed:
Protocol error: InvalidObjectHandle during DeleteObject
[MTP] Deleted 14/28 files, 14 errors
```

**Effet utilisateur** :
- L'album disparaît quand même de l'UI (le plan marque comme deleted)
- Les fichiers restent physiquement sur le device → pollution progressive
- Un toast d'erreur inquiète l'utilisateur alors que visuellement "ça a marché"

**Cause probable** : les object handles MTP deviennent invalides si le device a été scanné entre temps, ou si une autre opération a modifié le storage index. Pas de mécanisme de refresh/retry implémenté.

**Ce qui a été tenté** :
- Scan complet du device avant delete → handles toujours invalides
- Pause entre les deletes → pas d'effet
- `MTP_LOCK` pour sérialiser les accès → déjà en place

**Pistes non explorées** :
- Refresh des handles entre chaque delete (coûteux mais peut-être nécessaire)
- Regroupement des deletes par dossier + delete du dossier entier (si supporté par le device)

**Commits liés** :
- `4bc7021` fix(dap-sync): MTP delete InvalidObjectHandle + Transaction ID mismatch (fix partiel)
- `7188fd8` fix(dap-sync): 3 MTP bugs — badge ToRemove, empty folders, missing deletes

---

## Issue #2 — Timeout MTP sur album long (Paco De Lucia reproduit)

**Symptôme** : sur l'album "Paco De Lucia - Entre Dos Aguas", la track 5 (`Convite.flac`) provoque systématiquement :

```
[MTP] TIMEOUT: Paco De Lucia - Entre Dos Aguas/05 - Convite.flac
      — poisoning folder 'Paco De Lucia - Entre Dos Aguas' (remaining files will be skipped)
[MTP] Batch sync complete: 4/14 files copied, 0 already on device, (0.1 GB), 10 errors
```

**Effet** : le dossier est marqué "poisoned", les tracks restantes (6-14) sont skipées sans même être tentées.

**Cause probable** : le timeout interne de `mtp-rs` (30 s) est dépassé pour certains fichiers FLAC hi-res (24/96 ou 24/192). La firmware du FiiO JM21 semble particulièrement lente sur certains patterns.

**Ce qui a été tenté** :
- Retry manuel → échec reproductible exactement au même endroit
- Flush préventif toutes les 40 fichiers → n'aide pas pour ce cas isolé
- Pause entre uploads → pas d'effet

**Pistes non explorées** :
- Timeout adaptatif basé sur la taille du fichier (30s pour <50MB, 120s pour >500MB)
- Découpage des gros fichiers et upload par chunks (si supporté par mtp-rs)
- Investigation firmware-side : est-ce que le JM21 est lent sur certains codecs spécifiques ?

**Commits liés** :
- `753e484` fix(dap-sync): actually skip files after MTP timeout instead of re-attempting
- `c7f53f2` fix(dap-sync): MTP badges always "to add" + per-file timeout + disconnected screen

---

## Issue #3 — Transaction ID mismatch sur retry

**Symptôme** : après un timeout ou une erreur pendant un sync MTP, le prochain retry peut lever :

```
[MTP] No MTP device found: Invalid data: Transaction ID mismatch: expected 1, got 73
```

**Effet** : le device apparaît comme "no MTP device found" alors qu'il est physiquement connecté. L'utilisateur doit débrancher/rebrancher physiquement pour récupérer.

**Cause probable** : l'abandon en cours d'une opération MTP (timeout ou erreur) laisse le compteur Transaction ID du host désynchronisé avec celui du device. `mtp-rs` ne gère pas le resync automatique.

**Ce qui a été tenté** :
- Force-close de la session avant reconnect → parfois fonctionne, souvent non
- Refresh complet du device → les handles restent invalides
- Grace period avant de déclarer le device déconnecté → masque le symptôme mais ne le résout pas

**Pistes non explorées** :
- Reset complet du Transaction ID à 0 + renvoi `OpenSession` (possible via `mtp-rs` en bas niveau ?)
- Fork `mtp-rs` pour ajouter un mécanisme de recovery après erreur

**Commits liés** :
- `1f2ab47` MTP: resilient reconnection + grace period before disconnected
- `61e2d2a` fix(dap-sync): global MTP_LOCK prevents USB connection conflicts

---

## Issue #4 — Badge "to remove" qui disparaît sur delete partiel

**Symptôme** : quand Issue #1 se produit (delete partiel), le badge "to remove" de l'album **disparaît** immédiatement même si 50 % des fichiers sont encore physiquement sur le device.

**Effet** : l'utilisateur ne voit pas que l'album est dans un état incohérent. Il faut cocher à nouveau l'album pour voir réapparaître le badge, puis le décocher pour voir "to remove" — moment où le mismatch devient visible.

**Cause** : le manifest est mis à jour en considérant le delete comme réussi côté plan, même si les opérations physiques ont échoué.

**Piste** : tracker les deletes partiellement échoués dans le manifest (`partial_delete: true`) et les re-proposer comme "to remove" au prochain plan.

---

## Issue #5 — Pas de recovery robuste sur déconnexion mid-sync

**Symptôme** : si le câble USB est débranché (ou le DAP redémarré) pendant une sync, le thread Rust reste bloqué sur un `read()` ou `write()` MTP jusqu'au timeout.

**Effet** : l'UI reste gelée sur "syncing" jusqu'au timeout de 3 s côté JS, puis retour à la vue albums mais le manifest peut être partiellement écrit sur le device. Re-scan nécessaire.

**Ce qui existe** :
- Timeout JS 3 s pour débloquer l'utilisateur visuellement
- `cleanup_empty_dirs` en fin de sync (pour le mode Mass Storage)
- Détection de la déconnexion côté watcher

**Ce qui manque** :
- Checkpoint atomique du manifest (partial write possible)
- Reprise depuis le dernier checkpoint sur re-connexion
- Notification utilisateur claire "sync interrompue, X/Y fichiers synchronisés"

---

## Vue d'ensemble des pistes explorées (chronologie)

| Date (2026) | Commits | Sujet |
|---|---|---|
| 03-14 | `d5538cf`, `a34702c` | UX polish — tabs, typography |
| 03-15 | `fa5792d`, `80b3dbf` | Retry feedback, unified dest card, sync icon, context menu, auto-volume detection |
| 03-17 | `4f2f19c`, `61c7c8a` | SMB UUID resolution, retry strategy, exFAT sanitization |
| 03-23 | `8d7da04`, `8946789`, `e2bab6a` | exFAT ghost dirs, cover persistence, F_NOCACHE verify, SMB fallback |
| 03-24 | `5cdb915` | Batch adaptatif copie audio |
| 03-25 | `9d71cf3` | Integrity checks, cp-based copy, flat structure, batch pause |
| ... | `1c5c34c` | **MTP sync POC — bypass exFAT driver entirely** |
| ... | `416e550`, `d293805`, `d55ec6c` | MTP sidebar, USB conflict fix, incremental sync |
| ... | `7188fd8`, `5bcd564`, `dd78610` | Badge ToRemove, empty folders, session crash, manifest accuracy |
| ... | `753e484`, `84a544c` | Skip files after timeout |
| ... | `767bacd`, `4bc7021`, `c7f53f2` | MTP delete InvalidObjectHandle, Transaction ID mismatch, disconnected screen |
| ... | `436135c`, `a4d476f`, `276aca5` | Badge refresh, files_copied counter, MTP polling, timeout + log noise |
| ... | `61e2d2a`, `1f2ab47`, `04d8171`, `f4496ad` | Global MTP_LOCK, resilient reconnection, firmware flush pause, general MTP improvements |

---

## Pré-requis pour reprendre proprement

Avant de rouvrir la feature, ces 3 problèmes doivent avoir un plan de résolution :

1. **Transaction ID mismatch** — mécanisme de reset/recovery après erreur (peut nécessiter un fork de `mtp-rs`)
2. **Timeout adaptatif** — basé sur la taille du fichier, avec retry intelligent (pas juste skip)
3. **Checkpoint manifest atomique** — écriture atomique incrémentale pour permettre la reprise après crash ou déconnexion

Sans ces 3 points résolus, la feature restera instable pour les utilisateurs avec des DAP MTP récents (FiiO, iBasso, Shanling modernes).

Le mode **Mass Storage** (USB/SD classique) est lui nettement plus stable — il serait envisageable de le réactiver sans MTP comme première étape.

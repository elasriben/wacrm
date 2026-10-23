---
name: oralink-deploy-verify
description: Use when preparing, verifying, updating or rolling back the OraLink waCRM deployment (Docker Compose, Supabase, Caddy, backups). Runs the checklist and reports real results; never deploys or migrates production without explicit approval.
---

# OraLink — déploiement et vérification

Règles
- Ne jamais déployer, migrer une base réelle, créer une ressource payante ni toucher à SendZen/Meta sans accord explicite de l'utilisateur.
- Aucun secret dans Git ni dans la sortie : `.env` reste hors dépôt, seul `.env.example` (valeurs vides) est versionné.
- Tout code tiers s'exécute dans un conteneur jetable sans secret.

Checklist (rapporter chaque point comme RÉUSSI / ÉCHEC / NON TESTÉ avec la sortie réelle)
1. `bash -n` et shellcheck sur chaque script de `oralink/deploy/`.
2. `docker compose -f oralink/deploy/compose.oralink.yml config` valide ; images avec variante linux/arm64 (`docker manifest inspect`).
3. `.env.example` : aucune valeur réelle ; chaque variable documentée.
4. Installation sur environnement jetable : `install.sh` idempotent (deux exécutions de suite, même résultat), puis `verify.sh` (santé de chaque service).
5. Migrations : rejeu complet sur base vierge ; suite `supabase/tests/run.sh` attendue 71/71 (ou le nombre courant) ; ne jamais rejouer les anciennes migrations sur une base existante.
6. Sauvegarde chiffrée puis restauration sur base jetable ; comparer les comptes de lignes ; chronométrer.
7. `update.sh` puis `rollback.sh` sur environnement jetable.
8. Journaux : aucun jeton, message ni numéro de téléphone en clair.

Rapport final : tableau des points, écarts, ce qui n'a PAS été testé (ARM64 réel, VM Oracle, SendZen), décisions humaines requises.

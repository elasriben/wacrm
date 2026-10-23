# OraLink — tableau de suivi

Mis à jour par la coordination (branche `agent/skills`). Les issues GitHub sont **désactivées** sur ce dépôt : les éléments
sont identifiés ici par `OL-<n>`. Si les issues sont activées plus tard, chaque `OL-<n>` deviendra une issue avec le
label `needs-human` quand une décision humaine est requise.

Légende de l'état des tests : ✅ vert (chiffres réels) · ⏳ en cours · ⬜ pas encore exécuté · ❌ échec.

## Éléments de travail

| ID | Sujet | Responsable | Branche / PR | Dépend de | Tests | needs-human |
|---|---|---|---|---|---|---|
| OL-1 | Coordination : contrats v2, skills v2, conventions, ce tableau | Coordination | `agent/skills` — PR #5 | — | ✅ CI « Lint, typecheck, test, build » | **Approbation de fusion** |
| OL-2 | OraLink CI sur toutes les PR vers `main` (typecheck/tests, isolation + migrations rejouées, gitleaks, `node --test` de `oralink/`) | QUALITÉ | `feat/oralink-qa` — PR à ouvrir | OL-1 | ⏳ | Fusion ; puis jobs à rendre obligatoires (voir OL-9) |
| OL-3 | Passerelle SendZen : relecture, contrat waCRM ↔ SendZen, tests de contrat sur maquette | SENDZEN | `feat/oralink-sendzen` — PR à ouvrir | #6 ✅ | ⏳ | Fusion (PR sensible) ; tests réels T-S1…T-S10 |
| OL-4 | Pile de déploiement ARM64, Caddy, scripts, sauvegarde/restauration | DEVOPS | `feat/oralink-devops` — PR à ouvrir | OL-2 | ⏳ | Fusion (PR sensible) ; VM, DNS, destination des sauvegardes |
| OL-5 | Audit consentement/STOP/scoring de l'existant + migrations `900`/`901_oralink_*` | CRM MÉTIER | `feat/oralink-crm` — PR à ouvrir | OL-2 | ⏳ (isolation 71/71 après renommage) | Fusion (PR sensible) ; conservation des tables selon l'audit |
| OL-6 | Migration `902_oralink_redeem_invitation_tables` (ex-« 062 ») : `redeem_invitation` couvre les nouvelles tables | CRM MÉTIER | `feat/oralink-crm` | OL-5 | ❌ connu : `redeem-invitation-migration.test.ts` 1/6 en échec avant correction | Fusion (PR sensible) |
| OL-7 | Garde STOP : détection STOP/START dans le webhook + `canSendAutomated` sur tous les envois automatisés | CRM MÉTIER | `feat/oralink-crm` (commit séparé) | OL-5, OL-6 | ⬜ | Fusion (webhook) ; liste STOP darija/arabe |
| OL-8 | Contenus CRM : pipelines, flows FR/darija, règles de scoring, script de semis | CRM MÉTIER | `feat/oralink-crm-content` | OL-7 | ⬜ | Textes FR/darija validés par un locuteur natif |
| OL-9 | Renforcement du ruleset « Protect Main » | Humain | — | OL-2 vert sur 2 PR | — | **Modification du ruleset** |
| OL-10 | Isolation des nouvelles tables dans `supabase/tests`, vérification des sauvegardes | QUALITÉ | `feat/oralink-qa` (phase 2) | OL-4, OL-5 | ⬜ | — |

Déjà fusionné : PR #1 (synchronisation amont + isolation), #2 (LF), #3 (`WHATSAPP_API_BASE_URL`), #4 (prototype de
passerelle), #6 (liste blanche `WHATSAPP_API_ALLOWED_HTTP_HOSTS`, réserve « http interne uniquement »).

## Décisions humaines (`needs-human`)

| Décision | Bloque |
|---|---|
| Approuver et fusionner chaque PR (aucune fusion automatique) | OL-1 à OL-8 |
| Rendre obligatoires les jobs OraLink CI dans le ruleset | OL-9 |
| Créer l'environnement de staging (VM ou Supabase Cloud sans donnée réelle), domaine et DNS | OL-4 |
| Destination des sauvegardes hors hébergeur et garde de la clé privée | OL-4 |
| Compte SendZen sandbox et autorisation des tests réels T-S1…T-S10 | OL-3 |
| Liste STOP darija/arabe, textes de consentement et d'accusé STOP | OL-7, OL-8 |
| Base légale et déclaration auprès de l'autorité de protection des données | ouverture publique |

## Règles de publication (dépôt public)

Aucun secret, numéro de téléphone réel, adresse IP d'exploitation, chemin local, identifiant sensible ni donnée
personnelle dans les branches, PR, issues ou documents. gitleaks est exécuté avant chaque publication.

# OraLink — contrats d'interface entre chantiers

Version 2 · base `main` @ `d54bea6` · à modifier uniquement par le coordinateur (branche `agent/skills`).
Conventions : branches `feat/oralink-<chantier>` ; migrations `supabase/migrations/9NN_oralink_<sujet>.sql` (voir COORDINATION.md).
Un chantier qui a besoin d'un changement de contrat **s'arrête et le signale** au lieu de l'implémenter.

Légende : ✅ établi dans le code · ❓ à confirmer (test réel ou décision humaine).

## 1. Propriété des fichiers

Un chemin a un seul propriétaire. Les autres chantiers peuvent le **lire**, jamais le modifier.

| Chantier | Branche | Possède (écriture) |
|---|---|---|
| Coordination | `agent/skills` | `docs/oralink/COORDINATION.md`, `docs/oralink/CONTRACTS.md`, `docs/oralink/CODEX.md`, `.claude/skills/oralink-*/` |
| DEVOPS | `feat/oralink-devops` | `deploy/oralink/**`, `docs/oralink/devops/**` |
| SENDZEN | `feat/oralink-sendzen` | `oralink/sendzen-gateway/**`, `oralink/sendzen-test-kit/**`, `docs/oralink/sendzen/**`, nouveaux fichiers de test `src/**/*.gateway.test.ts` |
| CRM MÉTIER | `feat/oralink-crm` | `supabase/migrations/9NN_oralink_*.sql`, `src/lib/oralink/**`, `oralink/crm/**`, `docs/oralink/crm/**`, **et seul autorisé** à modifier `src/app/api/whatsapp/webhook/route.ts` et les points d'envoi sortants (voir §5) |
| QUALITÉ | `feat/oralink-qa` | `.github/workflows/oralink-ci.yml`, `supabase/tests/**`, `docs/oralink/qa/**`, nouveaux fichiers `src/**/*.security.test.ts` |

Gelés pour tous (modification = décision du coordinateur) : `src/lib/whatsapp/meta-api.ts`, `src/lib/whatsapp/graph-base.ts`
(fusionnés par la PR #3 ; seule évolution prévue : liste blanche HTTP, §3), `src/app/api/whatsapp/config/route.ts`, `.github/workflows/ci.yml`, `.github/workflows/migrations.yml`,
`supabase/migrations/001`–`899` (plage amont), `package.json`, `package-lock.json`, `next.config.ts`.
Une dépendance npm supplémentaire = demande au coordinateur, pas d'ajout direct.

## 2. Topologie et ports (DEVOPS ↔ tous)

| Service | Écoute | Exposé publiquement |
|---|---|---|
| Caddy | 80, 443 | **Oui, seul** |
| waCRM (Next.js) | `3000` réseau Docker interne | via Caddy : `https://crm.<DOMAINE>` |
| API Supabase (passerelle Kong ou équivalent) | `8000` interne | via Caddy : `https://sb.<DOMAINE>` (navigateur + waCRM) |
| PostgreSQL | `5432` interne | **Jamais** |
| Passerelle SendZen | `8080` interne | **Jamais** (waCRM l'appelle par `WHATSAPP_API_BASE_URL=http://sendzen-gateway:8080`) |
| Studio Supabase | désactivé en production ; tunnel SSH seulement | **Jamais** |

Webhook entrant SendZen → `https://crm.<DOMAINE>/api/whatsapp/webhook` (route waCRM existante ✅). Pas d'autre route publique ajoutée.

## 3. Variables d'environnement

Noms réservés. Aucune valeur réelle dans le dépôt : `.env.example` avec des valeurs factices uniquement.

| Variable | Lue par | Remarque |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | waCRM ✅ | |
| `ENCRYPTION_KEY` | waCRM ✅ | 64 hex ; chiffre les jetons `whatsapp_config` |
| `META_APP_SECRET` | waCRM ✅ | liste séparée par des virgules ; contient le(s) secret(s) de webhook SendZen |
| `WHATSAPP_API_BASE_URL` | waCRM ✅ (PR #3) | cible : `http://sendzen-gateway:8080` — **refusé aujourd'hui** (https obligatoire), voir ci-dessous |
| `WHATSAPP_API_ALLOWED_HTTP_HOSTS` | waCRM ❓ (à venir) | liste blanche explicite d'hôtes internes autorisés en `http`, séparés par des virgules (ex. `sendzen-gateway`) |
| `SENDZEN_API_BASE`, `NUMBER_MAP`, `ALLOW_TYPES`, `MAX_BODY_BYTES`, `SENDZEN_TIMEOUT_MS` | passerelle ✅ | voir `oralink/sendzen-gateway/.env.example` |
| `ORALINK_DOMAIN`, `ORALINK_ACME_EMAIL` | Caddy | |
| `ORALINK_BACKUP_RECIPIENT` | `backup.sh` | clé publique de chiffrement ; la clé privée ne va **jamais** sur la VM |
| `ORALINK_BACKUP_TARGET` | `backup.sh` | destination hors Oracle ❓ (décision humaine) |

Incompatibilité connue : `resolveGraphApiBase` (`src/lib/whatsapp/graph-base.ts`, PR #3) exige `https`, alors que la
passerelle écoute en `http` sur le réseau Docker interne. Correctif : **PR séparée #6** `feat/oralink-graph-http-allowlist`
après fusion de #3 : accepter `http` uniquement si le nom d'hôte figure exactement dans `WHATSAPP_API_ALLOWED_HTTP_HOSTS`
(comparaison exacte, insensible à la casse ; pas de joker, pas de suffixe) ; `https` inchangé ; identifiants, query et fragment
toujours refusés. Tests : hôte listé accepté, hôte non listé refusé, variable vide = comportement actuel, sous-domaine ou
`sendzen-gateway.evil.example` refusé, liste avec espaces normalisée.

## 4. Scripts d'exploitation (DEVOPS → QUALITÉ, skill `oralink-deploy-verify`)

`deploy/oralink/scripts/{install,verify,update,rollback,backup,restore}.sh`, bash, `set -euo pipefail`, idempotents.

- Sortie lisible par machine : une ligne par contrôle, `CHECK <nom> OK|FAIL|SKIP <détail court>`, puis `SUMMARY ok=<n> fail=<n> skip=<n>`.
- Codes de sortie : `0` tout OK · `1` au moins un FAIL · `2` erreur d'environnement / garde-fou.
- `verify.sh` contrôle au minimum : ports publics = {80, 443} uniquement ; santé waCRM, API Supabase, passerelle ; TLS valide ;
  aucune variable obligatoire vide ; dernière sauvegarde < 26 h et déchiffrable (test sur copie).
- `restore.sh` restaure **dans une base de test nommée `*_restore_test`** par défaut ; la restauration sur la base réelle
  exige un drapeau explicite et n'est jamais lancée par un agent.

## 5. Données CRM (CRM MÉTIER → QUALITÉ, SENDZEN)

Migrations nommées **`9NN_oralink_<sujet>.sql`** (900+). Toute table nouvelle : RLS activée, politiques fondées sur `public.is_account_member(...)` ✅
(même modèle que les migrations 040–047), colonne `account_id` obligatoire, tests d'isolation fournis à QUALITÉ.

### Consentement (journal en ajout seul)
`contact_consents` : `id uuid`, `account_id`, `contact_id`, `channel` (`whatsapp`), `purpose` (`service` | `marketing`),
`status` (`granted` | `revoked`), `source` (voir §6 ou `inbound` | `manual` | `import`), `evidence` (wamid, id de run de flow
ou note ; **pas de contenu de message**), `recorded_at`, `recorded_by` (uuid nullable).
Aucune politique `UPDATE`/`DELETE` pour les utilisateurs : l'historique ne se réécrit pas. L'état courant se lit par une vue
ou une fonction (« dernier événement par contact et finalité »).

### STOP
- Détection à la réception dans `processMessage` (webhook), sur un message texte **dont le contenu entier**, normalisé (casse,
  accents, espaces), est un mot-clé de la liste. Liste initiale : `STOP`, `ARRET`, `STOPPER`, `DESINSCRIRE`, `UNSUBSCRIBE`,
  `توقف` ❓, `ستوب` ❓ — **la liste darija/arabe doit être validée par un locuteur natif** avant production.
- Effet : événement `revoked` pour `marketing` **et** `service`, accusé de réception unique (texte FR + darija ❓), puis plus
  aucun envoi sortant automatisé (broadcast, flow, automatisation) vers ce contact. La boîte de réception humaine reste lisible.
- Garde sortante : **un seul point d'entrée**, fonction `src/lib/oralink/consent.ts → canSendAutomated(accountId, contactId)`,
  appelée par les chemins broadcast / flows / automatisations. CRM MÉTIER identifie ces points et les modifie **en dernier**,
  dans un commit séparé.
- Réabonnement : seulement par un message explicite du contact (`START` ❓) → événement `granted`.

### Source, rappel, scoring
- Source du lead : jeton du QR (§6) → étiquette native `src:<CODE>` posée par le flow (`set_tag` ✅) + événement de consentement
  avec `source = <CODE>`.
- Demande de rappel : bouton de flow → étiquette native `rappel` + nœud `handoff` ✅. Pas de table dédiée si les étiquettes suffisent.
- Scoring explicable : `lead_scores` (`account_id`, `contact_id`, `score int 0–100`, `reasons jsonb` = liste
  `{rule, points, valeur}`, `rules_version`, `computed_at`). Règles en JSON versionné dans `oralink/crm/scoring/<compte>.json`.
  Fonction pure `src/lib/oralink/scoring.ts → scoreLead(answers, rules) → {score, reasons}`, testée.
- Réponses aux questionnaires : variables de flow (`collect_input` ✅) + champs personnalisés natifs (`custom_fields` ✅).

### Comptes et pipelines
Deux comptes waCRM distincts : **TranZit** et **Immerview** (isolation par `account_id`, aucune donnée partagée).
Pipelines, étapes, étiquettes et flows décrits en JSON dans `oralink/crm/<compte>/` + script de semis idempotent
`oralink/crm/seed.mjs` qui passe par l'API (pas de SQL direct sur les tables), exécuté **uniquement en staging par un humain**.

## 6. QR codes BeachFlag

Deux QR codes, un par compte. Chacun ouvre `https://wa.me/<numéro du compte>?text=<texte pré-rempli>`.
Le texte pré-rempli contient le **code source** qui sert de mot-clé au flow natif (`trigger_type = 'keyword'` ✅).

| Code | Compte | Usage |
|---|---|---|
| `OL-TZ-BF1` | TranZit | BeachFlag 1 |
| `OL-IM-BF1` | Immerview | BeachFlag 1 |

Le texte exact (FR/darija) et les numéros sont ❓ (décision humaine). Aucun numéro réel dans le dépôt.

## 7. Passerelle SendZen (SENDZEN → waCRM, DEVOPS)

- waCRM envoie en format Graph à `WHATSAPP_API_BASE_URL` ; la passerelle traduit vers `POST <SENDZEN_API_BASE>/v1/messages`.
- Les webhooks SendZen arrivent **directement** sur waCRM (format Meta, `X-Hub-Signature-256`) ✅ ; la passerelle n'est pas
  sur le chemin entrant.
- Idempotence : un même `wamid` reçu deux fois ne crée qu'un message (comportement waCRM à vérifier par un test ✅/❓).
- Types autorisés : `text`, `interactive` (boutons ≤ 3, liste ≤ 10 lignes). Le reste répond `501` explicite.
- Aucun appel réel à SendZen, aucun numéro réel, aucune clé réelle sans accord humain.

## 8. Gestion des secrets

Aucun secret dans Git (gitleaks en CI). Faux positif : changer la valeur de test ou ajouter une exception documentée
(empreinte dans `.gitleaksignore` + justification) ; jamais de désactivation. Les tests utilisent des valeurs factices visiblement fausses
(`ci-dummy-…`, `000…0`). Jamais de `.env` réel, de clé privée de sauvegarde, de jeton SendZen ni de numéro réel.

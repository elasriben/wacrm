# Tests d'isolation entre comptes (OraLink)

Ces tests vérifient, **au niveau de la base**, qu'un compte ne voit ni ne modifie les données d'un autre :
lecture et écriture sur 16 tables, stockage, fonctions d'appartenance, ex-membre, accès anonyme,
fonctions internes (migration 044), RLS sur les 37 tables. **74 contrôles** dans `isolation.sql` (71 sur le commit upstream audité + 3 contrôles « CONTROL » de rôle ajoutés par QUALITÉ le 24/10/2026),
plus **6 contrôles de couverture RLS** dans `rls-coverage.sql` (QUALITÉ, phase 1) : **80 au total** (77 sur `main` @ `5d6f212` avant les contrôles de rôle).

| Référence | Valeur |
|---|---|
| Upstream audité | `ArnasDon/wacrm` @ `34bce1a8abf56281505d90bac165123b6ab7d51a` |
| Fork avant mise à jour | `elasriben/wacrm` @ `80c3f9a1aecdaf21b98311f230fdaaaec7d85f7d` (134 commits de retard) |

## Exécution reproductible

Prérequis : `psql`, `perl` et un PostgreSQL **jetable** (un superutilisateur local, jamais une base de production).

```bash
# Option 1 — votre cluster PostgreSQL local jetable
PGUSER=postgres PGHOST=127.0.0.1 PGPORT=5432 ./supabase/tests/run.sh

# Option 2 — conteneur PostgreSQL jetable (Docker requis ; supprimé en fin de test)
./supabase/tests/run.sh --docker
```

Résultat attendu : `== SUMMARY pass=80 fail=0` (74 + 6) et code de sortie `0`. Code `1` = au moins un échec ;
code `2` = erreur d'environnement (migration en échec, outil manquant, garde-fou).

Ce que fait `run.sh` : crée la base `wacrm_isolation_test`, installe un substitut minimal de Supabase
(`standalone-bootstrap.sql`), applique les 54 migrations dans l'ordre, exécute `supabase/ci/verify-schema.sql`,
puis `isolation.sql` et `rls-coverage.sql` (chacun avec son résumé, additionnés dans le `SUMMARY` final),
puis supprime la base. Un fichier de test sans ligne `SUMMARY` = code 2. Un échec de `verify-schema.sql` = code 2
(simple avertissement seulement avec un `MIGRATIONS_DIR` personnalisé, voir plus bas).

### Couverture RLS (`rls-coverage.sql`)
Échoue si une table (ordinaire ou partitionnée) du schéma `public` n'a pas la RLS activée ou n'a **aucune politique**,
si une vue de `public` lisible par `anon`/`authenticated` n'est pas `security_invoker` (elle contournerait la RLS),
ou si la liste blanche nomme une table inexistante. Contrôle témoin : au moins 37 tables dans `public`.
Les contrôles sont agrégés : ajouter une table ne change pas le nombre attendu. Les 6 lignes = 5 contrôles + 1 ligne
`(info)` (contenu de la liste blanche, toujours `PASS`). Le fichier s'exécute avec `ON_ERROR_STOP on` : une requête en
erreur interrompt le fichier avant son `SUMMARY` (code 2) au lieu de faire disparaître un contrôle en silence.
En CI, le job exige en plus au moins 80 contrôles réussis (plancher, pas valeur exacte).

Liste blanche (en tête du fichier, une ligne justifiée par table, toute modification relue par QUALITÉ) :
`automation_pending_executions` et `pending_message_statuses` sont exemptées du seul contrôle « au moins une politique » :
RLS activée sans politique, donc fermées à `anon`/`authenticated` ; accès `service_role` uniquement (migrations 006 et 054).

Preuve de détection (exécutée en conteneur sur `main` @ `5d6f212`) : une migration factice ajoutant une table sans RLS, une table
sans politique et une vue « owner » lisible par `authenticated` donne `rls-coverage.sql : pass=3 fail=3` (`SUMMARY pass=73 fail=4`,
mesuré avant l'ajout des 3 contrôles de rôle).

### Anti faux succès (`isolation.sql` et `run.sh`, QUALITÉ 24/10/2026)
- `isolation.sql` tourne lui aussi avec `ON_ERROR_STOP on` ; `run.sh` ne masque plus le code de sortie de `psql` :
  une requête de contrôle en erreur (table renommée, faute de frappe) = code 2, jamais un `SUMMARY` vert avec des contrôles en moins.
- Un refus attendu ne compte `PASS` que s'il lève `insufficient_privilege` (SQLSTATE 42501) ; une fonction absente (42883)
  ou toute autre erreur arrête le fichier (code 2). Avant : n'importe quelle erreur comptait comme un refus réussi.
- 3 contrôles `CONTROL:` : les requêtes tournent bien sous `authenticated` et `anon`, sans `SUPERUSER` ni `BYPASSRLS`,
  et aucun de ces rôles ne possède de table de `public` (le propriétaire d'une table contourne la RLS).
- `run.sh` vérifie qu'il n'y a qu'une ligne `SUMMARY` par fichier, qu'elle correspond aux lignes `PASS`/`FAIL` réellement
  produites, et qu'au moins un contrôle a tourné.

Mutations rejouées en conteneur jetable (`postgres:17` épinglé, migrations du dépôt + CRM 900–902 assemblées hors dépôt) :

| Protection supprimée (migration factice ajoutée en dernier) | Code | SUMMARY |
|---|---|---|
| aucune (témoin positif) | 0 | `pass=80 fail=0` |
| RLS désactivée sur `contacts` | 1 | `pass=71 fail=9` |
| politique `contacts_select` sans `is_account_member` | 1 | `pass=78 fail=2` |
| politique `contacts_insert` sans `is_account_member` | 1 | `pass=78 fail=2` |
| `is_account_member` sans filtre `account_id` | 1 | `pass=51 fail=29` |
| `whatsapp_config_select USING (true)` | 1 | `pass=76 fail=4` |
| RLS désactivée sur `contact_consents` (CRM 900) | 1 | `pass=78 fail=2` |
| `ALTER ROLE authenticated BYPASSRLS` | 1 | `pass=49 fail=31` |
| `touch_presence` renommée (était `pass=77 fail=0`, code 0 : faux succès) | 2 | — |
| requête de contrôle cassée dans `isolation.sql` (était `pass=61 fail=0`, code 0) | 2 | — |

### Garde-fous (le script refuse de s'exécuter sinon)
- `PGHOST` doit être local (`127.0.0.1`, `localhost`, `::1` ou un socket).
- `TEST_DB` doit se terminer par `_test` ; seule cette base est supprimée.
- Les rôles `anon`, `authenticated`, `service_role`, `authenticator`, `postgres` sont créés **s'ils n'existent pas**
  et ne sont jamais supprimés. Ce sont des rôles du cluster : utilisez un cluster dédié aux tests.

### Variables
`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` · `TEST_DB` · `MIGRATIONS_DIR` (tester un autre jeu de migrations) · `KEEP_DB=1`.

### Vérifier que les tests savent détecter une faille
```bash
# 80c3f9a = le fork d'origine (avant mise à jour)
mkdir /tmp/fork-mig && for f in $(git ls-tree --name-only 80c3f9a supabase/migrations/); do git show 80c3f9a:$f > /tmp/fork-mig/$(basename $f); done
MIGRATIONS_DIR=/tmp/fork-mig PGUSER=postgres ./supabase/tests/run.sh   # attendu : SUMMARY pass=67 fail=13, code 1
# (verify-schema.sql échoue sur ce schéma ancien : avertissement, pas d'arrêt, car MIGRATIONS_DIR est personnalisé)
```
Dans `isolation.sql`, 11 échecs : 10 pour `GHSA-338g-rch4-mrjc` (stockage lisible) et `GHSA-3xcm-m99v-7h3r` (fonctions internes exposées),
plus le témoin « anon reads 0 rows in every public table (at least 37 scanned) » (ce schéma n'a que 36 tables).
Dans `rls-coverage.sql`, 2 échecs attendus et sans lien avec une faille : ce schéma ancien n'a que 36 tables (contrôle témoin)
et ne contient pas encore `pending_message_statuses` (entrée de liste blanche orpheline).

## Limites (à lire)
- Ce **n'est pas Supabase** : `auth.uid()` et les schémas `auth` / `storage` sont des substituts minimaux.
  Les politiques RLS et fonctions testées sont les vraies définitions SQL des migrations, mais le service d'authentification,
  l'API de stockage et Realtime ne sont pas exercés. Un test sur une vraie pile Supabase reste nécessaire avant production.
- **pgvector** : s'il est absent, la base de connaissances IA est neutralisée dans une *copie* de test (les fichiers du dépôt ne changent pas).
- Les failles qui se jouent dans les **routes de l'application** (clé `service_role`, par exemple `GHSA-xvrq-88hg-44q6`)
  ne sont pas couvertes ici ; elles le sont par les tests unitaires de l'upstream (`npm test`).
- Aucun secret : tous les identifiants, e-mails et jetons de ce dossier sont fictifs.

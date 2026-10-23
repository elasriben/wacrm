# CI OraLink (`.github/workflows/oralink-ci.yml`)

S'ajoute au workflow amont `ci.yml` (check « Lint, typecheck, test, build », déjà exigé par le ruleset de `main`) ;
ne le remplace pas.

## Déclencheurs
- `pull_request` : **toutes** les PR (donc toutes les PR vers `main`), types par défaut (ouverture, nouveau commit, réouverture).
- `push` sur `sync/**`, `exp/**`, `ci/**`, `feat/**`, `fix/**`, `chore/**`. Pas de `push` sur `main` (couvert par l'amont).
- Pas de `pull_request_target`, `permissions: contents: read`, aucun secret, actions et images épinglées par SHA/digest.
- Aucun filtre `paths` et aucun `if:` au niveau des jobs : chaque job rend un statut sur chaque PR, condition
  nécessaire pour en faire un check obligatoire (un job sauté resterait « en attente »).

## Jobs (noms exacts = noms des checks)

| Check | Garantit |
|---|---|
| `OraLink / app (typecheck, lint, vitest)` | `npm ci --ignore-scripts`, `tsc --noEmit`, `eslint` (0 erreur), `vitest run` (dont les `*.security.test.ts`, ex. 49 cas sur le webhook WhatsApp). |
| `OraLink / supabase isolation (migrations replay + RLS)` | PostgreSQL 17 vierge : rejeu de **toutes** les migrations, `supabase/ci/verify-schema.sql` (échec = job en échec), `isolation.sql` (isolation entre comptes) et `rls-coverage.sql` (RLS + politique sur toute table de `public`, vues `security_invoker`). Exige `SUMMARY … fail=0` **et** au moins 77 contrôles réussis (plancher : ajouter des tests ne casse pas le job, en perdre le casse). |
| `OraLink / secret scan (gitleaks)` | gitleaks v8.30.1 sur `origin/main..HEAD` (les commits de la PR). Faux positif : changer la valeur de test ou exception justifiée dans `.gitleaksignore`, jamais de désactivation. |
| `OraLink / node --test (oralink packages)` | `npm test` (sans installation) dans chaque `oralink/<paquet>/` ayant un `package.json` ; sur une PR, `oralink/sendzen-gateway` et `oralink/sendzen-test-kit` doivent exister avec des `test/*.test.mjs`, sinon échec. Jamais de `node --test` nu (il prendrait `send-test.mjs` pour un test). |
| `OraLink / workflow lint (actionlint)` | actionlint (avec shellcheck) sur tous les workflows. |

## Les rendre obligatoires (action humaine)
GitHub → *Settings* → *Rules* → *Rulesets* → ruleset de `main` → *Require status checks to pass* → *Add checks* :
ajouter les cinq noms ci-dessus **à l'identique**, en gardant « Lint, typecheck, test, build ». Un check n'est
proposé qu'après avoir tourné au moins une fois : ouvrir d'abord une PR qui contient ce workflow.
Renommer un job casse le check obligatoire correspondant : tout renommage passe par QUALITÉ et le ruleset.

## Reproduire en local (conteneurs jetables)
- Isolation : `supabase/tests/run.sh --docker`, ou dans `postgres:17` (voir `supabase/tests/README.md`).
- Application : `node:22`, `npm ci --ignore-scripts && npm run typecheck && npm run lint && npm test`.
  Sur une machine lente/chargée, `src/app/api/ai/usage/route.test.ts` (« flags truncation… ») peut dépasser 5 s.

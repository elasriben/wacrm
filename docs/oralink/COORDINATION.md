# OraLink — coordination des chantiers parallèles

Coordinateur : session Claude Code principale. Contrats : [`CONTRACTS.md`](CONTRACTS.md).
Mécanisme : sous-agents Claude Code, un worktree Git par chantier (pas d'Agent Teams, pas d'orchestrateur externe).

## Conventions (uniques, communes à ce document et à CONTRACTS.md)

- **Branches** : `feat/oralink-<chantier>` (ex. `feat/oralink-crm`). Aucun autre préfixe pour un nouveau chantier OraLink.
- **Migrations** : `supabase/migrations/9NN_oralink_<sujet>.sql` (900 à 999). La plage `001`–`899` reste à l'amont
  (ArnasDon/wacrm) pour éviter toute collision de numéros lors des synchronisations.

## Règles communes à tous les agents

1. Travailler **uniquement** dans son worktree et sa branche ; n'écrire que dans les chemins qu'on possède (CONTRACTS §1).
2. **Commits locaux seulement.** Aucun `git push`, aucune PR, aucune modification de `main`. Le coordinateur pousse après accord humain.
3. Jamais de `--force`, jamais de désactivation d'un test, d'une politique RLS ou d'un garde-fou pour faire passer une vérification.
4. Aucun secret, numéro réel, clé ou jeton dans le dépôt. `gitleaks` doit passer sur ses commits. Faux positif :
   modifier la valeur de test pour qu'elle ne ressemble plus à un secret, ou ajouter une exception **documentée** (empreinte
   précise dans `.gitleaksignore` avec un commentaire qui justifie) ; jamais de désactivation de règle ni de gitleaks.
5. Code tiers (npm, images) : uniquement dans un **conteneur Docker jetable** (`npm ci --ignore-scripts`). Rien installé sur l'hôte.
6. Aucune migration sur une base réelle, aucun appel réel à SendZen, aucune dépense, aucune action sur Oracle Cloud.
7. Réutiliser l'existant (flows natifs, étiquettes, champs personnalisés) avant d'écrire du code ; pas de nouveau moteur de chatbot.
8. Chaque chantier écrit **ses propres tests** et les fait passer avant de livrer.
9. Besoin d'un changement de contrat ou d'un fichier possédé par un autre : s'arrêter et le signaler dans le rapport.
10. Rapport final : commits (SHA), fichiers, tests exécutés avec résultats réels, blocages, décisions humaines nécessaires.

## Chantiers et ordre d'intégration

Intégration dans `main` par PR distinctes, dans cet ordre (une PR n'est fusionnée que CI verte + revue QUALITÉ) :

Protection de `main` (ruleset GitHub, **décision humaine : ne pas modifier**) : PR obligatoire, méthode « Merge » seule,
suppression et force-push interdits, check obligatoire « Lint, typecheck, test, build » (non strict). Pas d'approbation
obligatoire et « Migrations » non obligatoire (workflow conditionnel). La revue QUALITÉ et l'attente de
la CI de `main` entre deux fusions restent donc des règles de discipline, pas des contrôles GitHub.

Plan CI : QUALITÉ étend `oralink-ci.yml` à **toutes les PR vers `main`** (typecheck/tests, suite d'isolation + migrations
rejouées sur base vierge, gitleaks, `node --test` de `oralink/`), jobs non conditionnels. Une fois ces jobs verts sur 2 PR,
ils sont rendus obligatoires dans le ruleset (action humaine).

Déjà fusionné dans `main` (2026-10-23, méthode « Merge », CI de `main` verte après chaque fusion) — branches antérieures
à la convention `feat/oralink-*`, conservées sous leur nom d'origine :

| PR GitHub | Branche | Objet | Commit de fusion |
|---|---|---|---|
| #1 | `sync/upstream-34bce1a` | synchronisation amont + suite d'isolation + OraLink CI | — |
| #2 | `fix/lf-eol` | fins de ligne LF pour `*.sh` et `*.sql` | `9f15c06` |
| #3 | `exp/graph-base-url` | `WHATSAPP_API_BASE_URL` configurable (https obligatoire) | `53ed5e1` |
| #4 | `exp/z-prime-gateway` | prototype passerelle SendZen + kit de test de contrat | `d54bea6` |
| #6 | `feat/oralink-graph-http-allowlist` | liste blanche `WHATSAPP_API_ALLOWED_HTTP_HOSTS` + réserve « http interne uniquement » | `5d6f212` |

Reste à intégrer :

| # | PR | Dépend de | Remarque |
|---|---|---|---|
| 1 | `agent/skills` | — | ce document, contrats, skills v2, stratégie Codex (nom demandé explicitement, hors convention) |
| 2 | `feat/oralink-qa` (phase 1 : OraLink CI sur toutes les PR vers `main`, voir « Plan CI ») | 1 | doit précéder les autres pour les valider |
| 3 | `feat/oralink-sendzen` | PR #6 ✅ | passerelle + kit + tests d'intégration |
| 4 | `feat/oralink-devops` | 2 | pile ARM64, Caddy, scripts, sauvegardes, doc VM |
| 5 | `feat/oralink-crm` (migrations + consentement/STOP + scoring) | 2 | migrations `9NN_oralink_*` ; webhook ; points d'envoi en dernier commit |
| 6 | `feat/oralink-crm-content` (pipelines, flows FR/darija, semis) | 5 | |
| 7 | `feat/oralink-qa` (phase 2 : isolation des nouvelles tables, vérification des sauvegardes) | 4, 5 | |

Séquencement imposé (fichiers sensibles partagés) :
- `src/app/api/whatsapp/webhook/route.ts` : CRM MÉTIER seul. QUALITÉ n'y ajoute que des **nouveaux fichiers de test**.
- `supabase/migrations/9NN_oralink_*` : CRM MÉTIER seul. QUALITÉ étend `supabase/tests/` **après** la PR CRM (n° 5).
- `oralink-ci.yml` : QUALITÉ seul.

## Chemin critique vers le MVP (objectif 2 à 4 semaines, non garanti)

```
[Humain] VM Oracle ARM + domaine/DNS ─┐
                                       ├─▶ DEVOPS déploie staging ─▶ waCRM privé ─▶ comptes + pipelines (CRM) ─▶ QR → WhatsApp → lead
[Humain] compte SendZen sandbox ──────┘                                 ▲
SENDZEN (tests contre maquette, puis T-S1…T-S10 réels avec accord) ────┘
QUALITÉ : CI, isolation, webhooks, restauration ─▶ porte « ouverture publique »
```

- Le premier blocage n'est pas le code : c'est la **VM Oracle** (capacité ARM parfois indisponible ❓) et le **compte SendZen**.
- Alternative pour ne pas attendre la VM : staging sur **Supabase Cloud Free sans donnée réelle** (recommandé dans
  `oralink-autohebergement-supabase.md`, phase A) — décision humaine.
- Ouverture publique interdite tant que : restauration complète testée (T7), isolation Realtime vérifiée (T4), ports = {80, 443} (T11),
  STOP fonctionnel, liste STOP darija validée, texte de consentement validé.

## Décisions humaines attendues

| Décision | Bloque |
|---|---|
| Créer la VM Oracle (ou choisir Supabase Cloud Free pour le staging) | déploiement staging |
| Domaine et enregistrements DNS `crm.` / `sb.` | Caddy/TLS |
| Compte SendZen sandbox, numéros de test, autorisation des tests réels T-S1…T-S10 | validation SendZen |
| Destination des sauvegardes hors Oracle et gestion de la clé privée | sauvegardes |
| Textes FR/darija (questionnaires, consentement, accusé STOP), validés par un locuteur natif | contenu CRM |
| Base légale / déclaration CNDP (loi 09-08) | ouverture publique |
| Push des branches et ouverture des PR | intégration |
| Migrations sur une base réelle | mise en production |

## Codex (facultatif)

Voir [`CODEX.md`](CODEX.md). Utilisé seulement comme **second relecteur indépendant** des PR sensibles, via GitHub.

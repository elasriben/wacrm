# Audit — consentement, STOP, scoring et garde des envois dans waCRM (amont)

Chantier CRM MÉTIER · base auditée : `origin/main` @ `5d6f212` (avant tout code OraLink) · contrat de référence :
`docs/oralink/CONTRACTS.md` v2 (§1, §5, §6) sur `agent/skills`.

Méthode : lecture du code et des migrations `001`–`059`, recherches ciblées (`opt_out`, `unsubscrib`, `consent`, `blocked`,
`stop`, `score`, `qualif`, codes Meta `131049`/`131050`, appels `send*`/`engineSend*`). Les numéros de ligne renvoient à
`origin/main` @ `5d6f212`. Aucune exécution de l'application, aucun appel réseau.

Légende : **FAIT** = prouvé par le code cité · **HYPOTHÈSE** = non prouvé, à vérifier.

---

## 1. Ce que waCRM sait déjà faire

### 1.1 Schéma : aucune notion d'opt-out ni de consentement

- **FAIT** — `contacts` (`supabase/migrations/001_initial_schema.sql:36-46`) ne contient que `phone`, `name`, `email`,
  `company`, `avatar_url`, horodatages ; puis `account_id` (`017_account_sharing.sql:176`, NOT NULL `:276`),
  `phone_normalized` (`022_contact_phone_dedup.sql:30-32`), `wa_user_id`/`wa_parent_user_id`/`wa_username`
  (`040_contact_business_scoped_user_id.sql:28-31`). **Aucune colonne** de type `opt_out`, `unsubscribed`, `blocked`,
  `do_not_contact`, `marketing_consent`. La recherche `opt_?out|unsubscrib|blocked|consent|marketing` dans les migrations
  amont ne renvoie que la catégorie de modèle `'Marketing'` (`001_initial_schema.sql:215`) et un commentaire sur le code
  d'erreur 131049 (`042_message_failure_reason.sql:6-10`).
- **FAIT** — Le type TypeScript `Contact` (`src/types/index.ts:99-121`) n'a pas davantage de champ d'opt-out.
- **FAIT** — Les seuls « opt-out » existants concernent autre chose : miroir des médias entrants par compte
  (`whatsapp_config.mirror_inbound_media`, `039_inbound_media_mirror.sql:23,64` ; `src/app/api/whatsapp/webhook/route.ts:591`)
  et coupure de l'IA par conversation (`conversations.ai_autoreply_disabled`, `029_ai_reply.sql:101` ; lu dans
  `src/lib/ai/auto-reply.ts:89-96`). Ni l'un ni l'autre ne bloque les broadcasts, flows ou automatisations.

### 1.2 Étiquettes et champs personnalisés (réutilisables)

- **FAIT** — `tags` / `contact_tags` (`001_initial_schema.sql:58-88`), comptés par `account_id` depuis 017 ; `contact_tags`
  n'a pas d'`account_id` propre, sa RLS passe par le contact parent (`017_account_sharing.sql:486-489`, `is_account_member`).
- **FAIT** — `custom_fields` / `contact_custom_values` (`001_initial_schema.sql:92-121`), valeur `TEXT`, unicité
  `(contact_id, custom_field_id)`.
- **FAIT** — Écriture d'étiquette centralisée : `addContactTagAndDispatch` (`src/lib/contacts/tag-events.ts:30-68`), qui
  déclenche le trigger d'automatisation `tag_added` (avec limite de profondeur de chaîne). Utilisée par le nœud de flow
  `set_tag` (`src/lib/flows/engine.ts:796-829`), l'étape d'automatisation `add_tag` (`src/lib/automations/engine.ts:810-845`),
  la route `src/app/api/contacts/[id]/tags/route.ts` et l'API v1 (`src/lib/api/v1/contacts.ts`).
- **FAIT** — Les étiquettes et valeurs personnalisées sont **modifiables et supprimables** par tout membre `agent`+ (RLS
  `FOR ALL`/politiques par commande de 017) : aucun historique, aucun auteur, aucune preuve.

### 1.3 Seul filtre d'envoi existant : exclusion manuelle par étiquette dans les broadcasts

- **FAIT** — `AudienceConfig.excludeTagIds` (`src/lib/broadcast-audience.ts:21-27`) ; les contacts portant une étiquette
  exclue sont retirés de l'audience (`fetchExcludedIds`, `:96-104`, appliqué dans `resolveAudienceContacts`, `:125`).
  Exposé dans l'interface (`src/components/broadcasts/step2-select-audience.tsx:37,153`,
  `src/app/(dashboard)/broadcasts/new/page.tsx:41,61`). Les tests l'illustrent avec une étiquette `tag-optout`
  (`src/lib/broadcast-audience.test.ts:197-211`).
- **FAIT** — Ce filtre est **facultatif et côté client** : l'audience est résolue dans le navigateur
  (`src/hooks/use-broadcast-sending.ts:160-165,295-300`), puis le navigateur envoie des **numéros de téléphone** à
  `POST /api/whatsapp/broadcast` (`use-broadcast-sending.ts:432-456`). La route serveur n'applique aucun filtre et envoie à
  chaque numéro reçu (`src/app/api/whatsapp/broadcast/route.ts:89-110,172-201`).
- **FAIT** — L'API publique `POST /api/v1/broadcasts` n'a aucun filtre d'exclusion : elle prend des numéros bruts et crée les
  contacts manquants (`src/lib/whatsapp/broadcast-core.ts:148-167`, `findOrCreateContact`).
- **FAIT** — Conditions d'étiquette disponibles pour un auteur prudent : condition d'automatisation `tag_presence`
  (`src/lib/automations/engine.ts:1129-1140`) et sujet `tag` des nœuds `condition` de flow (`src/lib/flows/engine.ts:529-580`,
  `src/lib/flows/types.ts:145`). Rien ne les impose.

### 1.4 Webhook entrant (`src/app/api/whatsapp/webhook/route.ts`)

- **FAIT** — `processMessage` (`:579-933`) : identité (`:596-607`), contact trouvé/créé (`:610-616`, création `:1282`),
  conversation (`:619-625`), réactions court-circuitées (`:641-644`), analyse du contenu (`:647-652`), **insertion
  idempotente** par `(conversation_id, message_id)` (`:703-733`) suivie d'un `return` sur rejeu (`:740-746`) — c'est la
  frontière d'idempotence unique.
- **FAIT** — Ordre des traitements après insertion : compteur non lu (`:762-772`), réouverture (`:778`), réponse broadcast
  (`:783`), **flows** `dispatchInboundToFlows` (`:802-822`), reprise d'automatisation en attente `resumeAwaitingReply`
  (`:838-847`), **automatisations** `new_contact_created`/`first_inbound_message`/`new_message_received`/`keyword_match`/
  `interactive_reply` (`:850-900`), **IA** `dispatchInboundToAiReply` (`:907-917`), webhook public `message.received`
  (`:926-932`).
- **FAIT** — **Aucune détection de STOP** ni d'aucun mot-clé de désinscription. Un « STOP » entrant est traité comme
  n'importe quel texte : il peut être **capturé comme réponse** par un nœud `collect_input` actif
  (`src/lib/flows/engine.ts:1108-1125`, toute saisie non vide est acceptée), **démarrer un flow** `first_inbound_message`
  (`src/lib/flows/engine.ts:394-402`) ou un flow à mot-clé en mode `contains` par défaut (`:99-116`), déclencher une
  automatisation `keyword_match` (`src/lib/automations/engine.ts:1087-1103`) ou une **réponse IA** (`auto-reply.ts:50`).
- **FAIT** — Bouton de réponse rapide d'un **modèle** (type `button`) : `payload` et `text` sont récupérés
  (`route.ts:1111-1131`), donc un futur bouton « STOP » de modèle est techniquement détectable.
- **FAIT** — Statuts d'échec Meta : code/titre stockés sur le message et le destinataire de broadcast (`route.ts:413-470`) ;
  aucun code (ex. 131050, refus marketing par l'utilisateur) ne modifie l'état du contact.
- **HYPOTHÈSE** — Meta renvoie un statut `failed` avec le code 131050 lorsqu'un utilisateur a refusé les messages marketing
  via WhatsApp ; ce code pourrait être journalisé comme signal (pas comme consentement). À confirmer en sandbox SendZen.

### 1.5 Flows natifs (`src/lib/flows/`)

- **FAIT** — Déclencheurs : `keyword` (`exact`|`contains`, `contains` par défaut, casse ignorée par défaut),
  `first_inbound_message`, `manual` (`src/lib/flows/types.ts:202-237` ; `engine.ts:99-116,360-404`). Le texte d'un bouton
  et son `reply_id` sont aussi testés comme mots-clés (`engine.ts:131-137`).
- **FAIT** — Nœuds : `start`, `send_message`, `send_buttons`, `send_list`, `send_media`, `collect_input`, `condition`,
  `set_tag`, `handoff`, `end` (`types.ts:187-197`).
- **FAIT** — `collect_input` stocke la réponse dans `flow_runs.vars[var_key]` (`engine.ts:1114-1118`), **pas** dans
  `contact_custom_values` : aucun nœud de flow n'écrit un champ personnalisé (recherche `custom_field` dans
  `src/lib/flows/*.ts` : aucun résultat hors tests).
- **FAIT** — `handoff` passe la conversation en `pending`, assigne éventuellement un agent et termine le run
  (`engine.ts:504-526`) ; il n'envoie rien.
- **FAIT** — Le cron des flows (`src/app/api/flows/cron/route.ts`) ne fait que marquer les runs expirés ; il n'envoie aucun
  message (aucun appel `engineSend*` dans ce fichier ni dans `src/lib/flows/timeout.ts`).

### 1.6 Automatisations (`src/lib/automations/`)

- **FAIT** — Points d'entrée : webhook (`route.ts:888`), `POST /api/automations/engine` (déclenchement manuel par un agent,
  `src/app/api/automations/engine/route.ts:12-44`), `tag_added` (`tag-events.ts:52` et `engine.ts:831`), cron des étapes
  `wait` (`src/app/api/automations/cron/route.ts:41-70` → `resumePendingExecution`, `engine.ts:156`), reprise sur réponse
  (`resumeAwaitingReply`, `engine.ts:236`).
- **FAIT** — Étapes d'envoi : `send_message` (`engine.ts:739-753`), `send_buttons`/`send_list` (`:755-773`),
  `send_template` (`:775-808`). Elles passent toutes par `src/lib/automations/meta-send.ts` (`sendViaMeta`, `:116`, et
  `engineSendInteractive`, `:88-110`, qui délègue à `src/lib/flows/meta-send.ts`).
- **FAIT** — `update_contact_field` (`engine.ts:884-934`) peut écrire un champ personnalisé à partir de `{{message.text}}`
  ou `{{vars.*}}` (variables du contexte d'automatisation, pas celles d'un run de flow : `interpolate`, `:1172-1179`).

### 1.7 Scoring et qualification

- **FAIT** — Aucun score de lead dans le schéma ni dans le code (le seul `score` est le `quality_score` des modèles Meta,
  `src/app/api/whatsapp/templates/sync/route.ts:59-77`).
- **FAIT** — « Qualification » existante = (a) étape de pipeline par défaut `qualified` (`src/app/(dashboard)/pipelines/page.tsx:41-47`)
  sur `deals` ; (b) modèle d'automatisation `lead_qualifier` (`src/lib/automations/templates.ts:91-115`) : mot-clé →
  message → attente 10 min → assignation round-robin. Aucun calcul, aucune règle, aucune explication.

---

## 2. Inventaire exhaustif des points d'envoi sortant vers WhatsApp

Toutes les fonctions qui appellent l'API Graph pour envoyer sont dans `src/lib/whatsapp/meta-api.ts` (gelé) :
`sendTextMessage` (`:394`), `sendMediaMessage` (`:451`), `sendTemplateMessage` (`:536`), `sendReactionMessage` (`:839`),
`sendTypingIndicator` (`:890`), `sendInteractiveButtons` (`:973`), `sendInteractiveList` (`:1080`). Leurs appelants :

| # | Point d'appel | Déclenché par | Automatisé ? | `contact_id` disponible ? |
|---|---|---|---|---|
| A1 | `src/lib/flows/meta-send.ts:92` `engineSendText` (appel Meta `:127`) | nœuds `send_message` (`flows/engine.ts:672`), `collect_input` (`:730`), relance (`:1173`) ; **IA** (`ai/auto-reply.ts:213`) | oui | oui (`args.contactId`, contrôlé par compte `:98-106`) |
| A2 | `src/lib/flows/meta-send.ts:206` `engineSendMedia` (Meta `:241`) | nœud `send_media` (`flows/engine.ts:697`) | oui | oui |
| A3 | `src/lib/flows/meta-send.ts:359` `sendInteractiveViaMeta` (Meta `:398`, `:409`) | `send_buttons`/`send_list` de flow (`flows/engine.ts:427,468`) et d'automatisation (`automations/meta-send.ts:94,102`) | oui | oui |
| A4 | `src/lib/automations/meta-send.ts:116` `sendViaMeta` (Meta `:178`, `:189`) | étapes `send_message`/`send_template` (`automations/engine.ts:745,798`) | oui | oui (contrôlé par compte `:127-135`) |
| A5 | `src/lib/whatsapp/broadcast-core.ts:261` `deliverBroadcast` (Meta `:272`) | `POST /api/v1/broadcasts` (`src/app/api/v1/broadcasts/route.ts:64,80`) et reprise `POST /api/whatsapp/broadcast/[id]/resume` (`route.ts:104`) | oui (campagne) | oui (`plan.planned[].contactId`, `broadcast-core.ts:56-62`) |
| A6 | `src/app/api/whatsapp/broadcast/route.ts:191` (boucle sur numéros) | assistant de broadcast de l'interface (`use-broadcast-sending.ts:450`) | oui (campagne) | **non** : reçoit des numéros ; il faudra résoudre numéro → contact côté serveur |
| A7 | `src/lib/ai/auto-reply.ts:257` `sendTypingIndicator` | IA, avant génération | oui (accusé de lecture/indicateur, pas un message) | oui |
| H1 | `src/lib/whatsapp/send-message.ts:189` `sendMessageToConversation` (Meta `:348-402`) ← `POST /api/whatsapp/send` (`route.ts:159`) | agent humain dans la boîte de réception | non | via la conversation |
| H2 | même cœur ← `POST /api/v1/messages` (`route.ts:108`) | intégration externe par clé API | **ambigu** (machine, mais hors moteurs waCRM) | résolu par numéro |
| H3 | `src/app/api/whatsapp/react/route.ts:118` `sendReactionMessage` | agent humain | non | — |

Webhooks sortants (`src/lib/webhooks/deliver.ts`) : HTTP vers les intégrateurs, pas WhatsApp — hors périmètre.

**Points qui devront appeler `canSendAutomated(accountId, contactId)`** (commit séparé, sur accord humain) :

1. **A1** `flows/meta-send.ts` `engineSendText` — couvre flows (`send_message`, `collect_input`, relances) **et** l'IA.
2. **A2** `flows/meta-send.ts` `engineSendMedia`.
3. **A3** `flows/meta-send.ts` `sendInteractiveViaMeta` — couvre boutons/listes des flows et des automatisations.
4. **A4** `automations/meta-send.ts` `sendViaMeta` — couvre texte et modèles des automatisations (y compris reprises cron,
   `tag_added`, déclenchement manuel).
5. **A5** `broadcast-core.ts` `deliverBroadcast` — par destinataire, avant `sendTemplateMessage` ; marquer le destinataire
   `failed` avec un motif explicite (« opt-out ») plutôt que l'omettre.
6. **A6** `api/whatsapp/broadcast/route.ts` — résoudre chaque numéro en contact du compte (par `phone_normalized`) puis
   appliquer la garde ; un numéro sans contact = refus (pas de consentement connu).
7. **A7** `ai/auto-reply.ts` `showTypingIndicator` — inutile si l'IA est déjà court-circuitée après STOP ; à garder
   derrière la même garde par cohérence (le plus simple : un test `canSendAutomated` en tête de `dispatchInboundToAiReply`).

Ces quatre fichiers « goulots » (`flows/meta-send.ts`, `automations/meta-send.ts`, `broadcast-core.ts`,
`api/whatsapp/broadcast/route.ts`) suffisent à couvrir tous les envois automatisés recensés. **Décision humaine** pour
**H2** (`/api/v1/messages`) : le contrat §5 cite broadcast/flows/automatisations ; un envoi par API est automatisé du point
de vue du prospect — recommandation : appliquer la garde (ou au minimum pour `type=template`).

---

## 3. Rapport d'écart avec CONTRACTS §5

### 3.1 Existant à réutiliser (conforme au contrat)
- Étiquettes natives + `set_tag` pour `src:<CODE>` et `rappel` (§5 « Source, rappel ») : **FAIT**, utilisable tel quel.
- Déclencheur de flow `keyword` pour les codes QR `OL-TZ-BF1` / `OL-IM-BF1` (§6) : **FAIT**. Attention : mode `contains`
  par défaut — recommander `exact` ou au moins des codes non ambigus.
- `handoff` (§5 « rappel ») : **FAIT**.
- `collect_input` (§5 « réponses aux questionnaires ») : **FAIT** pour la capture, mais voir 3.2.
- `custom_fields` : **FAIT** comme stockage, alimentable seulement par automatisation (`update_contact_field`) ou API.
- `excludeTagIds` (broadcast) : utile comme **filtre d'affichage** complémentaire, pas comme garde.
- Frontière d'idempotence du webhook (`route.ts:703-746`) : l'accusé STOP placé **après** l'insertion est unique par wamid
  sans mécanisme supplémentaire.
- `is_account_member(account_id, min_role)` (`017_account_sharing.sql:136-167`) pour la RLS des nouvelles tables.

### 3.2 Manque (à construire, conformément au contrat)
1. Tout stockage du consentement / de l'opt-out (journal, état courant, preuve, auteur) — **rien n'existe**.
2. Détection STOP dans `processMessage`, **placée après l'insertion idempotente (`:733`) et avant `dispatchInboundToFlows`
   (`:802`)**, avec court-circuit des flows, des automatisations de contenu et de l'IA pour ce message (sinon le STOP est
   capturé par `collect_input` ou déclenche une réponse). Fermer le run de flow actif du contact est recommandé.
3. Garde sortante serveur `canSendAutomated` sur les 6–7 points listés au §2 ; aujourd'hui **aucun** chemin automatisé ne
   consulte un état de consentement.
4. Réabonnement `START` ❓.
5. Pont `collect_input` → `custom_fields` : aucun nœud de flow ne l'écrit. Options : (a) le scoring lit `flow_runs.vars` ;
   (b) un nouveau nœud (= modification du moteur de flows, hors périmètre CRM, décision coordinateur) ; (c) automatisation
   séparée. **Écart de contrat à signaler** : §5 suppose que variables de flow et champs personnalisés s'articulent, le
   code ne le fait pas.
6. Score de lead (stockage, règles versionnées, fonction pure) — **rien n'existe**.

### 3.3 Contradictions / risques vis-à-vis du contrat
- **A6** prend des numéros, pas des contacts : la signature `canSendAutomated(accountId, contactId)` ne s'applique qu'après
  résolution serveur numéro → contact. Ce n'est pas un changement de contrat, mais un travail supplémentaire dans la route.
- Les broadcasts CSV de l'interface (`use-broadcast-sending.ts:210-260`) et `POST /api/v1/broadcasts`
  (`broadcast-core.ts:157`) **créent des contacts** à la volée : ces contacts n'ont aucun consentement. Si la garde exige un
  `granted` marketing, ces campagnes seront entièrement refusées — c'est le comportement voulu par la loi 09-08, mais il
  faut le décider explicitement (voir §5 de ce document).
- Contrat : « aucun envoi automatisé après STOP » vs IA : l'IA est un envoi automatisé non cité dans §5 ; elle passe par A1,
  donc elle sera bloquée automatiquement — **conforme à l'esprit**, à mentionner dans le contrat.
- Contrat : le STOP révoque `service` **et** `marketing`. Conséquence : après STOP, même un flow de service démarré par le
  contact (ex. il renvoie le code QR) ne répondra plus, jusqu'au `START`. À confirmer (décision humaine) ; c'est le choix
  le plus protecteur.
- **HYPOTHÈSE** — La politique WhatsApp Business exige le respect des demandes d'opt-out ; le format exact de l'accusé (texte
  libre dans la fenêtre de 24 h) n'est pas un problème puisque le STOP ouvre la fenêtre. À confirmer avec SendZen.

---

## 4. Recommandation : tables `contact_consents` / `lead_scores`

**Conserver les deux tables** (sous réserve de la relecture de la phase 2).

- `contact_consents` : l'existant n'offre que les étiquettes, qui sont modifiables/supprimables par n'importe quel agent,
  sans horodatage d'événement, sans auteur, sans preuve et sans distinction de finalité (`service`/`marketing`). Elles ne
  permettent pas de démontrer un consentement ou une révocation (loi 09-08) ni de garantir qu'un STOP ne sera pas « effacé »
  par un retrait d'étiquette. Un journal en ajout seul avec RLS est le minimum. Les étiquettes peuvent rester un **miroir
  visuel** (ex. étiquette `stop` posée en plus de l'événement) mais jamais la source de vérité de `canSendAutomated`.
- `lead_scores` : rien d'existant. Un champ personnalisé texte ne porte ni `reasons`, ni `rules_version`, ni horodatage ;
  le contrat exige un score explicable. Option complémentaire non bloquante : recopier le score dans un champ personnalisé
  pour l'affichage/filtrage natif (filtre d'audience `custom_field`), la table restant la référence.

---

## 5. Décisions humaines identifiées par l'audit

1. Garde sur `POST /api/v1/messages` (H2) : oui/non, et pour quels types.
2. Contacts importés (CSV, API v1) sans consentement : refus systématique des broadcasts marketing tant qu'aucun `granted`
   n'est enregistré ? (recommandé) — et quelle source de preuve accepter (`import` + note) ? Aucun consentement ne doit être
   déduit d'un scan de QR ou d'une demande d'information.
3. STOP révoque aussi `service` (contrat actuel) : confirmer.
4. Liste STOP darija/arabe et texte d'accusé FR/darija ❓ : validation par un locuteur natif.
5. Pont `collect_input` → `custom_fields` (3.2 point 5) : choix d'option, éventuellement changement de contrat.
6. Les envois humains (H1, H3) restent possibles après STOP (contrat : « la boîte humaine reste lisible ») : confirmer que
   « lisible » autorise aussi la réponse manuelle d'un agent.

## 6. Limites de cet audit
- Lecture statique uniquement ; aucun test de bout en bout ni appel Meta/SendZen.
- Le comportement réel de Meta/SendZen (codes 131050, boutons d'opt-out des modèles marketing) n'est pas vérifié.
- Les composants d'interface n'ont été lus que pour l'audience des broadcasts.

# Correctifs du webhook WhatsApp : signature sur octets bruts et statuts de diffusion par compte

Chantier CRM MÉTIER, branche `feat/oralink-crm`. Fichiers concernés : `src/app/api/whatsapp/webhook/route.ts`,
`src/lib/whatsapp/webhook-body.ts`, `webhook-signature.ts`, `broadcast-recipient-webhook.ts` et leurs tests.
Aucun schéma ni migration modifié. Aucun secret par compte (hors périmètre).

## C — HMAC calculé sur les octets reçus (`fix(webhook): verify HMAC over raw request bytes`)

**Constat.** Le corps était décodé en chaîne UTF-8 permissive avant le calcul HMAC. Chaque séquence invalide devient
U+FFFD : la signature était donc vérifiée sur un **réencodage** du corps, pas sur les octets reçus. Concrètement, une
signature calculée sur la chaîne réencodée était acceptée pour un corps dont les octets diffèrent (cas N3c).

**Correctif.** `readCappedBodyBytes()` renvoie les octets exacts, avec les mêmes limites (Content-Length puis flux,
4 Mio). `verifyMetaWebhookSignature()` accepte `Buffer | string` : une chaîne reste acceptée pour les appelants
existants et pour le test de compatibilité SENDZEN. Ordre imposé dans `POST` :
1. lecture des octets ; dépassement → 413 ;
2. HMAC sur ces octets ; échec → 401 ;
3. décodage UTF-8 **strict** ; octets invalides → 400, même si la signature est valide ;
4. analyse JSON ; échec → 400.

Aucun accès à la base ni traitement différé (`after()`) avant la fin de ces quatre contrôles.

**Tests** (`route.raw-signature.test.ts`, vraie vérification, secret factice) : octet modifié (N3a), `0xFF` signé comme
`0xFE` (N3b), signature sur la chaîne réencodée (N3c), en-tête absent ou `sha1=` (N3d), UTF-8 invalide signé (400),
JSON invalide signé (400), corps > 4 Mio (413 avant vérification), et témoins positifs en français, arabe et darija,
plus un STOP darija signé. Les cas négatifs vérifient : aucune table lue, aucun `after()`, aucun moteur, aucun envoi.
Remarque : N3b était déjà refusé par l'ancien code. C'est N3c qui montre l'écart corrigé.

## A — Statuts de diffusion limités au compte résolu (`fix(webhook): scope broadcast recipient status updates to the resolved account`)

**Constat.** `applyBroadcastRecipientStatus` mettait à jour `broadcast_recipients` par `whatsapp_message_id` seul. Un
webhook de statut résolu pour le compte A pouvait donc modifier la ligne d'une diffusion du compte B. Un même wamid ne
peut pas exister dans deux comptes : l'index unique `idx_broadcast_recipients_wamid` (migration 003) porte sur toute la
table. La faille réelle est donc celle d'un webhook résolu pour A qui reçoit le wamid d'une ligne de B.

**Correctif.**
- `applyBroadcastRecipientStatus(db, accountId, event)` : `accountId` est obligatoire ; vide → `skipped`, sans requête.
- Lecture bornée : `select('id, broadcasts!inner(account_id)')`, filtrée sur `whatsapp_message_id`,
  `broadcasts.account_id` et les statuts prédécesseurs. `!inner` est indispensable : sans lui, PostgREST ignore le filtre
  sur la ressource embarquée.
- Mise à jour par `id in (…)` qui reprend le filtre `status in (prédécesseurs)` : un changement de statut concurrent entre
  la lecture et l'écriture n'est pas écrasé. C'est le schéma déjà utilisé par `flagBroadcastReply`.
- `handleStatusUpdate` : numéro absent, inconnu ou ambigu (0 ou ≥ 2 configurations) → aucune mise à jour de
  `broadcast_recipients` ni de `messages`. Le message de journal ne contient plus l'identifiant du numéro.

**Tests.**
- Numéro inconnu, absent ou ambigu → 200, aucune mise à jour, fonction non appelée.
- Statut résolu pour A portant le wamid d'une ligne de B → aucune modification, pour les statuts cibles `delivered`,
  `read` et `failed`.
- `!inner` vérifié.
- Changement de statut concurrent → pas d'écrasement.
- Témoins positifs pour le compte propriétaire.
- Cas « même wamid dans A et B », conservé en défense en profondeur (impossible avec le schéma actuel).
- Les assertions des tests #535 de `route.test.ts` ne sont pas modifiées. Seules les doublures ont été adaptées à la
  nouvelle requête. Elles appliquent désormais la règle PostgREST : un filtre sur ressource embarquée ne compte qu'avec
  `!inner`.

## Limites

- Les tests unitaires utilisent un faux client Supabase : ils ne **prouvent** pas le comportement de `!inner` sur un vrai
  PostgREST. QUALITÉ l'a vérifié sur un PostgREST jetable, pour le statut cible `delivered` uniquement. `read` et `failed`
  sont couverts ici en unitaire seulement.
- Aucun appel réel à Meta ou SendZen : le format réel des octets envoyés par SendZen n'est pas vérifié ici. Le test de
  compatibilité SENDZEN existant passe sans modification.
- Les secrets de webhook par compte ne sont pas traités ici (hors périmètre).

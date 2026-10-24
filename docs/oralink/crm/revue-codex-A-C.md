# Dossier de revue Codex indépendante — correctifs A et C (PR #9)

Chantier CRM MÉTIER, branche `feat/oralink-crm`. Ce dossier prépare une relecture **indépendante** (autre fournisseur,
autre modèle) des deux correctifs du webhook WhatsApp publiés dans la PR #9. Règles d'échange : `docs/oralink/CODEX.md`
(GitHub seul point d'échange, aucun secret, aucun constat appliqué automatiquement : le coordinateur le reproduit,
puis corrige ou réfute).

| Correctif | Commit | Objet |
|---|---|---|
| C | `f97ad83` | `fix(webhook): verify HMAC over raw request bytes` |
| A | `4ec6f23` | `fix(webhook): scope broadcast recipient status updates to the resolved account` |
| Note | `4c2993d` | `docs/oralink/crm/webhook-fixes.md` (constat, correctifs, limites) |

Hors périmètre de cette revue : secrets par compte (OL-13, attend le contrat réel de la passerelle), le reste de la
PR #9 (migrations `900`–`902`, garde STOP/START) sauf interaction directe avec A ou C.

## 1. Prompt à copier dans Codex

```text
Tu es relecteur de sécurité indépendant. Dépôt public : github.com/elasriben/wacrm, PR #9.
Contexte : CRM WhatsApp multi-comptes (Next.js + Supabase/PostgreSQL avec RLS). Deux comptes clients isolés par
account_id (appelés A et B ci-dessous). Envoi et réception WhatsApp via une passerelle SendZen qui relaie des webhooks
au format Meta (en-tête X-Hub-Signature-256). Données personnelles de prospects au Maroc (loi 09-08).
Contrats d'interface : docs/oralink/CONTRACTS.md. Règles : docs/oralink/COORDINATION.md.
Note des correctifs : docs/oralink/crm/webhook-fixes.md.

Périmètre : UNIQUEMENT les commits f97ad83 (correctif C) et 4ec6f23 (correctif A) de la PR #9, et les fichiers
qu'ils touchent. N'exécute rien qui contacte un service réel (ni Meta, ni SendZen, ni Supabase hébergé).
Tu peux lancer les tests unitaires ciblés dans un environnement jetable (npm ci --ignore-scripts, puis
npx vitest run <fichiers>).

Correctif C — signature HMAC sur les octets reçus.
Avant : le corps était décodé en UTF-8 permissif, puis HMACé ; une signature calculée sur la chaîne réencodée
était acceptée pour des octets différents. Après : lecture des octets exacts (plafond 4 Mio → 413), HMAC sur ces
octets (→ 401), décodage UTF-8 strict (→ 400), JSON (→ 400). Annoncé : aucun accès base, aucun after(), aucun moteur
avant la fin de ces quatre contrôles.
Attaque :
- N3a : un octet du corps modifié après signature → doit donner 401.
- N3b : corps reçu avec 0xFF, signature calculée sur 0xFE (même chaîne une fois décodée en permissif) → 401.
- N3c : signature calculée sur la chaîne réencodée au lieu des octets reçus → 401 (c'est le cas qui prouve le correctif).
- N3d : en-tête absent, ou préfixe sha1= → 401.
- Pour chaque cas : vérifie qu'aucune table n'est lue, qu'aucun flow/automatisation/IA ne tourne et qu'aucune réponse
  STOP n'est envoyée.
- Cherche aussi : comparaison non constante, en-tête mal parsé (casse, espaces, plusieurs valeurs), plusieurs secrets
  (META_APP_SECRET séparé par des virgules) dont un vide, Content-Length menteur, corps en flux qui dépasse le
  plafond, BOM UTF-8, chemin où une chaîne (et non les octets) serait encore passée à verifyMetaWebhookSignature.

Correctif A — statuts de diffusion limités au compte résolu.
Avant : applyBroadcastRecipientStatus mettait à jour broadcast_recipients par whatsapp_message_id (wamid) seul :
un webhook de statut résolu pour A pouvait modifier une ligne d'une diffusion de B. Après : accountId obligatoire
(vide → aucune requête) ; lecture bornée select('id, broadcasts!inner(account_id)') filtrée par wamid,
broadcasts.account_id et statuts prédécesseurs ; puis mise à jour par id en refiltrant les statuts prédécesseurs.
Sans compte unique résolu depuis metadata.phone_number_id (absent, inconnu, ambigu), ni broadcast_recipients ni
messages ne sont modifiés. Le journal ne contient plus l'identifiant du numéro.
Attaque :
- N1 : statut delivered sur un numéro inconnu (0 configuration), absent, ou ambigu (2 configurations), avec un wamid
  existant → aucune mise à jour, applyBroadcastRecipientStatus et applyMessageStatus non appelées, réponse 200.
- N2 : statut signé pour le numéro de A dont le wamid appartient à une diffusion de B (delivered, read, failed)
  → aucune ligne de B modifiée. Variante : même wamid dans A et B → seule la ligne de A change.
- Vérifie que le filtre de compte est réellement appliqué par PostgREST : sans !inner, un filtre sur une ressource
  embarquée ne restreint pas les lignes parentes. Le !inner est-il présent et le filtre porte-t-il sur
  broadcasts.account_id ?
- Course entre la lecture et la mise à jour : une ligne avancée entre les deux ne doit pas être écrasée.
- Autres appelants éventuels de applyBroadcastRecipientStatus ou d'une mise à jour de broadcast_recipients par wamid
  seul, ailleurs dans le code (service_role sans filtre account_id).
- Interaction avec la garde STOP/START de processMessage : un message entrant signé reste-t-il soumis à la garde
  après le correctif C ?

Pour chaque constat : fichier:ligne, scénario concret d'exploitation (entrée → effet), sévérité
(critique/haute/moyenne/basse), correction minimale. Sépare clairement « vérifié dans le code » et « supposition ».
Termine par la liste de ce que tu as vérifié et de ce que tu n'as pas pu vérifier.
Ne propose pas de refonte hors du périmètre de ces deux commits. N'ouvre aucune branche autre que
feat/oralink-codex-<sujet> et ne pousse rien sur feat/oralink-crm ni sur main.
```

## 2. Fichiers à lire

Correctif C (`f97ad83`) :
- `src/app/api/whatsapp/webhook/route.ts` — fonction `POST` (ordre 413 → 401 → 400 UTF-8 → 400 JSON, puis `after()`).
- `src/lib/whatsapp/webhook-body.ts` — `readCappedBodyBytes` (octets exacts) et `readCappedBody` (compatibilité).
- `src/lib/whatsapp/webhook-signature.ts` — `verifyMetaWebhookSignature(Buffer | string, …)`, `signatureMatches`,
  `parseAppSecrets`.
- `src/app/api/whatsapp/webhook/route.raw-signature.test.ts` — vraie vérification HMAC, secret factice.
- `src/lib/whatsapp/webhook-signature.test.ts`, `src/lib/whatsapp/webhook-body.test.ts`.
- `src/lib/whatsapp/webhook-signature.sendzen-compat.test.ts` — propriété SENDZEN, non modifié, doit rester vert.

Correctif A (`4ec6f23`) :
- `src/lib/whatsapp/broadcast-recipient-webhook.ts` — `applyBroadcastRecipientStatus(db, accountId, event)`.
- `src/app/api/whatsapp/webhook/route.ts` — `resolveAccountForPhoneNumber`, `handleStatusUpdate`.
- `src/lib/whatsapp/broadcast-recipient-webhook.test.ts`, `src/app/api/whatsapp/webhook/route.test.ts`
  (bloc « broadcast recipients scoped to the resolved account »).
- Pour contexte : la migration amont qui rend `broadcast_recipients.whatsapp_message_id` unique sur toute la table
  (la faille réelle est donc « webhook de A, wamid d'une ligne de B »).

## 3. Scénarios et tests existants correspondants

| Scénario | Attendu | Test existant |
|---|---|---|
| N1 numéro inconnu / absent / ambigu | 200, aucune mise à jour `broadcast_recipients` ni `messages`, journal sans identifiant | `route.test.ts` : 4 tests « N1 » |
| N2 wamid de B reçu sur A (`delivered`, `read`, `failed`) | aucune ligne de B modifiée | `broadcast-recipient-webhook.test.ts` : 3 tests « N2 » ; `route.test.ts` : 1 test « N2 » |
| N2 variante, même wamid dans A et B | seule la ligne de A change | un test dans chacun des deux fichiers |
| `!inner` obligatoire | filtre de compte effectif | `broadcast-recipient-webhook.test.ts` (doublure qui ignore un filtre embarqué sans `!inner`) |
| Course lecture / écriture | pas d'écrasement | `broadcast-recipient-webhook.test.ts` |
| N3a octet modifié | 401, rien traité | `route.raw-signature.test.ts` |
| N3b `0xFF` signé comme `0xFE` | 401 | `route.raw-signature.test.ts` (déjà refusé avant le correctif) |
| N3c signature sur la chaîne réencodée | 401 | `route.raw-signature.test.ts` (prouve l'écart corrigé) |
| N3d en-tête absent / `sha1=` | 401 | `route.raw-signature.test.ts` (2 tests) |
| UTF-8 invalide signé / JSON invalide signé | 400, rien traité | `route.raw-signature.test.ts` |
| Corps > 4 Mio | 413 avant la vérification | `route.raw-signature.test.ts` |
| Témoins positifs français, arabe, darija ; STOP darija signé | 200, texte identique, STOP détecté | `route.raw-signature.test.ts` |

## 4. Ce qui n'est pas prouvé

- **Filtre `!inner` sur un PostgREST réel** : vérifié sur une instance jetable pour le statut `delivered` seulement.
  `read` et `failed` ne sont couverts que par les tests unitaires, dont la doublure imite la règle PostgREST
  (un filtre embarqué ne s'applique qu'avec `!inner`) sans la prouver.
- **Octets réellement signés par SendZen** : inconnus, aucun appel réel. Si la passerelle signe autre chose que les
  octets exacts du corps relayé (réencodage, normalisation, autre en-tête, autre algorithme), des webhooks légitimes
  seront refusés en 401. Le correctif C ne peut pas le révéler sans un échange réel.
- **Présence de `metadata.phone_number_id` dans les statuts relayés par SendZen** : supposée (format Meta). Si elle
  manque, tous les statuts de diffusion et de messages sont désormais ignorés (comportement voulu côté sécurité, mais
  perte fonctionnelle des compteurs livrés/lus).
- **Isolation RLS et recherche de secrets en CI sur la PR #9** : non exécutées, le workflow OraLink CI n'étant pas
  encore sur `main`. Seuls les deux jobs amont (lint/typecheck/tests/build, application des migrations sur base vide)
  ont tourné.
- Aucun test de bout en bout de l'application.

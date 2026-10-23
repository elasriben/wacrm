# Passerelle SendZen « Z′ » — conception et état de vérification

**Statut : PROTOTYPE.** Aucun numéro réel n'est connecté. Aucun appel à SendZen n'a été fait. Les tests utilisent une
**maquette** de SendZen construite à partir de la documentation publique : elle prouve la logique de traduction,
pas le comportement réel de SendZen (celui-ci est établi par `../sendzen-test-kit/TEST-PLAN.md`).

## Principe
```
waCRM (code d'envoi Meta inchangé)  ──Graph-compatible──▶  passerelle  ──POST /v1/messages──▶  SendZen ──▶ WhatsApp
        ▲ WHATSAPP_API_BASE_URL (réseau interne uniquement)                  (Bearer transmis tel quel, rien stocké)
        └──────────────── webhooks signés (X-Hub-Signature-256) ◀────────────────────────────── SendZen
```
La **réception** ne passe pas par la passerelle : SendZen appelle directement `/api/whatsapp/webhook` de waCRM
(format Meta, signature HMAC-SHA256). Seule la **sortie** est traduite.

## Appel par appel (`src/lib/whatsapp/meta-api.ts` et `templates/sync/route.ts`)

| Appel waCRM (fonction) | Requête Graph | Comportement de la passerelle | État |
|---|---|---|---|
| `sendTextMessage` | `POST /{phoneNumberId}/messages` `type:text` | → `POST /v1/messages` + `from` | ✅ testé (maquette) · ❓ réel (T-S5) |
| `sendInteractiveButtons` (≤ 3) | idem `type:interactive/button` | idem, corps identique | ✅ maquette · schéma documenté par SendZen · ❓ réel (T-S3) |
| `sendInteractiveList` (≤ 10 lignes) | idem `type:interactive/list` | idem, corps transmis tel quel | ✅ maquette · ❓ **schéma SendZen non confirmé** (T-S4) |
| `sendTemplateMessage` | idem `type:template` | **501 explicite** (désactivé tant que non vérifié) | ⛔ par conception — requis pour relances hors 24 h |
| `sendMediaMessage` | idem `type:image/video/…` | **501** | ⛔ non vérifié |
| `sendReactionMessage` | idem `type:reaction` | **501** | ⛔ |
| `sendTypingIndicator` | idem `status:read` | **501** (usage IA uniquement, hors MVP) | ⛔ |
| `verifyPhoneNumber`, `getPhoneNumberHealth` | `GET /{id}?fields=…` | **501** « aucune vérification Meta n'a eu lieu » | ⛔ voir *Appels de configuration* |
| `registerPhoneNumber` | `POST /{id}/register` | **501** | ⛔ |
| `subscribeWabaToApp`, `getSubscribedApps`, `listWabaPhoneNumbers` | `/{waba}/subscribed_apps`, `/phone_numbers` | **501** | ⛔ |
| `submitMessageTemplate`, `editMessageTemplate`, `deleteMessageTemplate`, `uploadResumableMedia`, `template-header-handle` | `/{waba}/message_templates`, `/{app}/uploads` | **501** | ⛔ modèles gérés dans SendZen pour l'instant |
| `GET templates/sync` | `/{waba}/message_templates` | **501** | ⛔ dépend de l'API « liste des modèles » de SendZen (❓) |
| `getMediaUrl`, `downloadMedia` | `GET /{mediaId}` + URL CDN | **501** | ⛔ médias entrants non documentés ; **aucune pièce d'identité ne doit être collectée de toute façon** |

La passerelle **ne fabrique jamais** de succès : tout ce qui n'est pas établi renvoie une erreur de forme Meta
(`error.type = GatewayNotImplemented`, HTTP 501) que waCRM affiche comme une vraie erreur.

## Routage multi-numéros
- waCRM identifie un numéro par `phone_number_id` (colonne `whatsapp_config`, **un numéro par compte**) à l'envoi (chemin) **et** à la réception (`metadata.phone_number_id`).
- La passerelle a une table `NUMBER_MAP` : `phone_number_id → from`. Identifiant inconnu → **404**, SendZen non appelé.
- TranZit et Immerview sont deux comptes waCRM, chacun avec son numéro, sa clé SendZen (son projet) et son secret de webhook.
- Contrainte : `phone_number_id` doit être **le même** côté envoi et dans les webhooks SendZen. ❓ à confirmer (T-S2/T-S5). Si SendZen envoie un autre identifiant, la configuration waCRM doit utiliser celui des webhooks et la passerelle le convertir.
- Plusieurs secrets de webhook : `META_APP_SECRET` accepte une liste séparée par des virgules (déjà dans waCRM).

## Authentification
| Lien | Mécanisme | Remarque |
|---|---|---|
| waCRM → passerelle | `Authorization: Bearer <clé SendZen du numéro>` (le « jeton d'accès » stocké chiffré dans `whatsapp_config`) | La passerelle n'a **aucun secret** à stocker. Elle n'écoute que sur le réseau interne Docker/127.0.0.1, jamais publiquement. |
| passerelle → SendZen | même en-tête, transmis tel quel ; destination fixe `SENDZEN_API_BASE` (https) | Pas de SSRF possible : la destination n'est pas dérivée de la requête. |
| SendZen → waCRM | `X-Hub-Signature-256: sha256=<hex>` (annoncé) | Vérifié par le code existant de waCRM ; secret ajouté à `META_APP_SECRET`. Compatibilité côté waCRM testée ; côté SendZen ❓ (T-S1). |
- Journaux : méthode, forme de route, statut, latence uniquement. Jamais l'en-tête, les corps, les numéros ni le texte des messages (testé).
- Corps limité (256 Ko par défaut), délai de 15 s vers SendZen, types de message en liste blanche (`ALLOW_TYPES`).

## Appels de configuration (décision requise)
Le formulaire « Connecter WhatsApp » de waCRM appelle Meta (`verifyPhoneNumber`, `registerPhoneNumber`, `subscribeWabaToApp`, …).
Ces appels n'ont pas d'équivalent établi côté SendZen et **ne peuvent pas être simulés honnêtement**. Deux options :

| | A. Provisionnement hors interface (recommandée) | B. Mode « fournisseur » dans la route de configuration |
|---|---|---|
| Principe | un script crée/actualise la ligne `whatsapp_config` (jeton chiffré avec le code de chiffrement de waCRM) pour chaque numéro, après vérification dans le tableau de bord SendZen | modifier `src/app/api/whatsapp/config/route.ts` pour sauter les appels Meta quand `WHATSAPP_API_BASE_URL` est défini |
| Code upstream touché | **aucun** | route de configuration (zone sensible), divergence à chaque synchronisation |
| Interface waCRM | l'écran « santé du numéro » affiche une erreur explicite (501) | à adapter |
| Effort | ≈ 3 à 5 h 🔶 | ≈ 8 à 14 h 🔶 |
Le script de provisionnement n'est **pas** écrit : il touche aux jetons chiffrés et nécessite votre accord.

## Modèles de messages (templates)
Indispensables dès qu'on écrit à un prospect **hors de la fenêtre de 24 h** (relance, rappel). Le MVP « le prospect scanne le QR
et discute » reste dans la fenêtre de 24 h et n'en a pas besoin. À traiter après les tests T-S10 : mapping de l'envoi et de la
liste des modèles SendZen, puis activation de `template` dans `ALLOW_TYPES`.

## Ce que la passerelle ne résout pas
- **Réponse humaine depuis le tableau de bord SendZen** : si SendZen n'émet pas d'événement pour ces messages, ils n'apparaîtront
  pas dans la boîte de waCRM et le suivi de « prise en charge humaine » de waCRM sera désynchronisé (T-S9). Recommandation :
  répondre depuis la boîte de waCRM (elle envoie via la passerelle).
- **Désinscription automatique côté SendZen** : si SendZen bloque les envois vers un numéro désinscrit, waCRM doit le savoir
  (STOP transmis au webhook → enregistrer l'opposition dans waCRM). waCRM n'a **aucune** gestion STOP aujourd'hui (développement à prévoir).
- **Connexion Meta directe simultanée déconseillée** (SendZen) : cohérent avec Z′ — waCRM ne parle jamais à Meta dans ce mode, et
  `subscribeWabaToApp` n'est jamais appelé.

## Exploitation
`node server.mjs` (Node ≥ 22, aucune dépendance) ou l'image `Dockerfile` (`node:22-alpine`, multi-architecture, utilisateur non-root).
Santé : `GET /healthz`. Configuration : `.env.example` (sans secret).

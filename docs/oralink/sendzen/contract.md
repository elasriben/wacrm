# Contrat waCRM ↔ SendZen (voie Z′)

Version 1 · branche `feat/oralink-sendzen` · base `main` @ `5d6f212` · propriétaire : chantier SENDZEN (CONTRACTS §1).
Référence amont : `docs/oralink/CONTRACTS.md` v2 (§2, §3, §7) sur `agent/skills`.

## Légende — à lire avant tout

| Marque | Signification |
|---|---|
| ✅ code | Établi par le code de ce dépôt **et** couvert par un test automatique (identifiant entre crochets). |
| ❓ réel | Hypothèse sur le comportement **réel** de SendZen ou de WhatsApp. Non vérifiée. À confirmer par un test réel T-S*n* (`oralink/sendzen-test-kit/TEST-PLAN.md`), qui exige l'**accord humain**. |
| 📄 doc (non revérifiée) | Forme annoncée par la documentation publique SendZen **telle que relevée lors du prototype (PR #4)**. Je ne l'ai pas relue dans ce chantier (aucun accès réseau utilisé) : elle reste donc ❓ tant que T-S*n* n'est pas fait. |

**Toutes les vérifications automatiques utilisent une maquette (mock) de SendZen** (`oralink/sendzen-gateway/test/mock-sendzen.mjs`).
Elles prouvent la **traduction** faite par la passerelle et le comportement de waCRM face aux charges attendues ; elles ne prouvent
**rien** du comportement réel de SendZen. Aucun appel réel à SendZen ou à Meta n'a jamais été fait.

Identifiants de tests : `C-xx` = `oralink/sendzen-gateway/test/contract.mock.test.mjs` ; `I` = `interactive.test.mjs` ;
`G` = `gateway.test.mjs` ; `M` = `src/lib/whatsapp/meta-api.sendzen.gateway.test.ts` ; `W-xx` = `src/app/api/whatsapp/webhook/route.sendzen.gateway.test.ts` ;
`K` = `oralink/sendzen-test-kit/test/kit.test.mjs` ; `S` = `src/lib/whatsapp/webhook-signature.sendzen-compat.test.ts`.

## 1. Topologie

```
waCRM ──(format Graph, http interne)──▶ passerelle :8080 ──(https)──▶ SENDZEN_API_BASE/v1/messages ──▶ WhatsApp
  ▲                                                                                          │
  └───────────── webhooks format Meta, X-Hub-Signature-256 (https public via Caddy) ◀──────────┘
```

| Point | État |
|---|---|
| waCRM envoie à `WHATSAPP_API_BASE_URL` ; `http://sendzen-gateway:8080` accepté seulement si `WHATSAPP_API_ALLOWED_HTTP_HOSTS=sendzen-gateway` | ✅ code (PR #3, PR #6, `graph-base.test.ts`) |
| La passerelle n'est **jamais** exposée : http interne uniquement, pas de `ports:` Compose | règle de déploiement (CONTRACTS §2) — contrôle par `verify.sh` (DEVOPS), **pas** par ce chantier |
| La passerelle ne stocke aucun secret : le jeton `Authorization: Bearer` de waCRM (clé SendZen du numéro) est transmis tel quel | ✅ code [C-01, G] |
| Destination fixe (`SENDZEN_API_BASE`, https ; http seulement en boucle locale pour les tests ; ni identifiants ni query) : la destination ne dépend jamais de la requête → pas de SSRF | ✅ code [C-17, G] |
| Redirections amont jamais suivies (le jeton ne part pas vers un autre hôte) | ✅ code [C-13] |
| Les webhooks SendZen arrivent directement sur `/api/whatsapp/webhook` de waCRM ; la passerelle n'est pas sur le chemin entrant | ✅ code (route waCRM existante) · ❓ réel que SendZen les envoie au format Meta (T-S1, T-S2) |

## 2. Envoi : appel par appel

Forme commune de la requête waCRM (`src/lib/whatsapp/meta-api.ts`, gelé) :
`POST {WHATSAPP_API_BASE_URL}/{phone_number_id}/messages`, en-têtes `Authorization: Bearer <jeton>` et `Content-Type: application/json`.
Le segment de version (`/v21.0`) est ignoré par la passerelle ✅.

### 2.1 Texte — `sendTextMessage`

| Étape | Contenu | État |
|---|---|---|
| Requête Graph | `{messaging_product:"whatsapp", recipient_type:"individual", to, type:"text", text:{body}, context?:{message_id}}` | ✅ code (meta-api.ts) |
| Contrôles passerelle | jeton présent et bien formé (sinon 401, code 190) ; `phone_number_id` présent dans `NUMBER_MAP` (sinon 404, code 100) ; corps ≤ `MAX_BODY_BYTES` (sinon 413) ; JSON objet (sinon 400) ; `to` = chiffres, `+` facultatif (sinon 400 #131009) ; `text.body` non vide, ≤ 4096 caractères (sinon 400 #131009) | ✅ code [C-06, C-07, C-10, C-11, C-15] |
| Requête SendZen | `POST {SENDZEN_API_BASE}/v1/messages`, même `Authorization`, corps `{from, to, type:"text", text:{body}, context?:{message_id}}` construit par **liste blanche** ; `from` vient toujours de `NUMBER_MAP` (non modifiable par la requête) ; `messaging_product`, `recipient_type` et tout champ inconnu sont retirés | ✅ code [C-01, C-04, M] |
| Forme attendue par SendZen | `{from,to,type,text}` | 📄 doc (non revérifiée) · ❓ réel (T-S5) |
| Valeur de `from` : identifiant numérique ou numéro E.164 ? | inconnue — `NUMBER_MAP` se remplit après T-S5 | ❓ réel (T-S5) |
| `context.message_id` (réponse citée) accepté par SendZen | transmis, effet inconnu | ❓ réel (T-S3) |
| Limite de 4096 caractères | limite documentée par Meta ; comportement SendZen au-delà inconnu (la passerelle refuse avant) | ❓ réel |
| Réponse SendZen attendue | `202 {message_id, status, to, timestamp}` + en-tête `X-Request-ID` | 📄 doc (non revérifiée) · ❓ réel (T-S5) |
| Réponse à waCRM (succès) | `200 {messaging_product:"whatsapp", contacts:[{input:to}], messages:[{id:<message_id>}]}` — seul l'identifiant renvoyé par SendZen est repris ; `contacts[].wa_id` n'est **pas** fabriqué | ✅ code [C-01] |
| L'identifiant SendZen est le `wamid` WhatsApp (celui des webhooks de statut et de `context.id`) | indispensable pour les statuts et les réponses citées | ❓ réel (T-S3, T-S8) |

### 2.2 Boutons de réponse — `sendInteractiveButtons`

| Étape | Contenu | État |
|---|---|---|
| Requête Graph | `type:"interactive"`, `interactive:{type:"button", header?:{type:"text",text}, body:{text}, footer?:{text}, action:{buttons:[{type:"reply",reply:{id,title}}…]}}`, `context?` | ✅ code (meta-api.ts) |
| Limites waCRM (avant le réseau) | 1 à 3 boutons, titre ≤ 20, corps ≤ 1024, en-tête/pied ≤ 60 | ✅ code [M] |
| Limites passerelle (revérifiées) | 1 à 3 boutons `reply`, `id` non vide ≤ 256 et unique, titre non vide ≤ 20, corps ≤ 1024, en-tête **texte** ≤ 60, pied ≤ 60 ; comptage en caractères Unicode → sinon **400** `GatewayValidationError` code **131009**, SendZen non appelé | ✅ code [C-05, I] |
| En-tête média (image/vidéo/document) | valide pour WhatsApp mais non vérifié via SendZen → **501** | ✅ code [C-08, I] |
| Requête SendZen | `{from, to, type:"interactive", interactive:<objet identique>, context?}` | ✅ code [C-02, M] · 📄 doc (schéma boutons annoncé) · ❓ réel (T-S3) |
| Réponse | comme 2.1 | ✅ code · ❓ réel |
| Retour du clic | webhook `interactive.button_reply.{id,title}` + `context.id` | ❓ réel (T-S3) ; traitement waCRM ✅ code [W-03] |

### 2.3 Liste — `sendInteractiveList`

| Étape | Contenu | État |
|---|---|---|
| Requête Graph | `interactive:{type:"list", header?, body:{text}, footer?, action:{button, sections:[{title?, rows:[{id,title,description?}]}]}}` | ✅ code (meta-api.ts) |
| Limites passerelle | libellé du bouton ≤ 20 ; 1 à 10 sections ; **≤ 10 lignes au total** ; titre de section ≤ 24 (obligatoire s'il y a plusieurs sections) ; `id` de ligne ≤ 200 et unique ; titre ≤ 24 ; description ≤ 72 → sinon **400** #131009, SendZen non appelé | ✅ code [C-05, I] |
| Requête SendZen | `{from, to, type:"interactive", interactive:<objet identique>, context?}` | ✅ code [C-03, M] · ❓ **schéma liste non confirmé par la doc SendZen** (T-S4) |
| Refus côté SendZen d'une liste de 11 lignes (format d'erreur) | jamais atteint via la passerelle (refus local) ; à observer avec `send-test.mjs list11` | ❓ réel (T-S4) |
| Retour du choix | webhook `interactive.list_reply.{id,title,description?}` | ❓ réel (T-S4) ; traitement waCRM ✅ code [W-03] |

### 2.4 Tout le reste — **501 explicite**, SendZen jamais appelé

Corps : `{error:{message, type:"GatewayNotImplemented", code:501, fbtrace_id}}`, que waCRM lève comme une vraie erreur (`MetaApiError`, `httpStatus 501`).
La passerelle **ne fabrique jamais un succès**.

| Appel waCRM | Requête Graph | État |
|---|---|---|
| `sendTemplateMessage` | `type:"template"` | ✅ code 501 [C-08, M] — à activer après T-S10 (requis hors fenêtre de 24 h) |
| `sendMediaMessage` | `type:image/video/audio/document` (+ `sticker`) | ✅ code 501 [C-08] |
| `sendReactionMessage` | `type:"reaction"` | ✅ code 501 [C-08, M] |
| `location`, `contacts`, type absent | | ✅ code 501 [C-08] |
| `sendTypingIndicator` / accusé de lecture | `{status:"read", …}` | ✅ code 501 [C-08] |
| Interactif autre que `button`/`list` (`cta_url`, `flow`, `product`…) | | ✅ code 501 [C-08, I] |
| `verifyPhoneNumber`, `getPhoneNumberHealth` | `GET /{id}?fields=…` | ✅ code 501 « No Meta verification took place » [C-09, G] |
| `registerPhoneNumber`, `subscribeWabaToApp`, `getSubscribedApps`, `listWabaPhoneNumbers` | `/{id}/register`, `/{waba}/subscribed_apps`, `/{waba}/phone_numbers` | ✅ code 501 [C-09, G] |
| Modèles (`message_templates`, synchronisation), téléversements | | ✅ code 501 [C-09, G] |
| `getMediaUrl`, `downloadMedia` | `GET /{mediaId}` | ✅ code 501 [C-09, G] |
| Toute autre méthode ou chemin | | ✅ code 501 [C-09] |

`ALLOW_TYPES` ne peut que **restreindre** `text,interactive` : toute autre valeur fait échouer le démarrage ✅ code [C-17].

### 2.5 Erreurs et délais

| Situation | Réponse à waCRM | État |
|---|---|---|
| SendZen répond 4xx/5xx | même statut, `type:"SendZenError"`, `message` de SendZen (≤ 1000 car.), `code` numérique sinon 1, `fbtrace_id` = `X-Request-ID`, `error_data.details` seulement si chaîne | ✅ code [C-12, G, M] |
| Forme réelle des erreurs SendZen `{error:{code,message,details}}` | | 📄 doc (non revérifiée) · ❓ réel (T-S4, T-S5) |
| 2xx sans identifiant, non-JSON, ou réponse > 64 Ko | 502, code 2 | ✅ code [C-13, G] |
| Redirection amont | 502 (non suivie) | ✅ code [C-13] |
| Pas de réponse en `SENDZEN_TIMEOUT_MS` (15 s par défaut, 100 ms–60 s) | 504, code 2 | ✅ code [C-14, G, M] |
| SendZen injoignable | 502, code 2 | ✅ code [C-14] |
| Exception interne inattendue | 500 « Internal gateway error », sans détail ; le processus continue | ✅ code [C-14] |
| Délai de vie d'une requête entrante | en-têtes 10 s, requête ≥ 30 s | ✅ code (non testé automatiquement) |
| Ré-essai automatique côté passerelle | **aucun** (un ré-essai pourrait doubler un envoi ; décision laissée à waCRM) | ✅ code |

## 3. Réception : webhooks SendZen → waCRM

| Point | Contenu | État |
|---|---|---|
| Enveloppe | format Meta `{object:"whatsapp_business_account", entry[].changes[].value{metadata.phone_number_id, contacts[], messages[] | statuses[]}}` | ❓ réel (T-S2) · traitement waCRM ✅ code [W-03] avec la forme supposée |
| Signature | `X-Hub-Signature-256: sha256=<hex minuscule>` HMAC-SHA256 du corps brut ; secret(s) dans `META_APP_SECRET` (liste séparée par des virgules, un secret par projet SendZen) | ❓ réel (T-S1) · vérification waCRM ✅ code [W-01, S] |
| Refus | en-tête absent ou vide, mauvais secret, corps modifié, hex sans préfixe, hex majuscule, `sha1=`, base64 → 401, rien n'est traité ; `META_APP_SECRET` vide → 401 (échec fermé) | ✅ code [W-01, S] |
| Outil de diagnostic T-S1 | `analyze.mjs → signatureVerdict` dit si le schéma observé est accepté tel quel par waCRM (`compatible`) ou exige un changement waCRM (`incompatible`, à demander au chantier CRM) | ✅ code [K] |
| Idempotence | un même `wamid` (`messages[].id`) reçu plusieurs fois → **un** message, un contact, une conversation, un seul `unread`, un seul lancement de flow, **un seul** envoi sortant ; aussi si le corps est re-sérialisé autrement ou si deux livraisons arrivent en même temps. Mécanisme waCRM : index unique `(conversation_id, message_id)` (migration 037) + `upsert … ignoreDuplicates` | ✅ code [W-02] — avec une **fausse base Supabase en mémoire** qui reproduit l'index ; ❓ sur PostgreSQL réel (couvert par QUALITÉ) |
| SendZen ré-émet avec le **même** `wamid` | condition nécessaire à l'idempotence ci-dessus | ❓ réel (T-S7) |
| `metadata.phone_number_id` identique à celui utilisé à l'envoi (routage vers le bon compte) | waCRM route sur cette valeur | ❓ réel (T-S2, T-S5) · routage waCRM ✅ code [W-03] |
| Statuts `sent/delivered/read/failed` rapprochables de l'envoi | dépend de 2.1 « identifiant = wamid » | ❓ réel (T-S8) |
| STOP transmis au webhook ; blocage côté SendZen | | ❓ réel (T-S6) — traitement STOP = chantier CRM |
| Réponses humaines depuis le tableau de bord SendZen visibles dans waCRM | | ❓ réel (T-S9) |

## 4. Configuration de la passerelle

| Variable | Règle | État |
|---|---|---|
| `SENDZEN_API_BASE` | URL https sans identifiants, query ni fragment ; http seulement `localhost`/`127.0.0.1`/`[::1]` | ✅ code [C-17, G] |
| `NUMBER_MAP` | objet JSON `{ "<phone_number_id numérique>": { "from": "…" } }` ; recherche par propriété propre uniquement (`__proto__`, `constructor` → 404) | ✅ code [C-10, G] |
| `ALLOW_TYPES` | sous-ensemble de `text,interactive` | ✅ code [C-17] |
| `MAX_BODY_BYTES` | entier 1024–1048576 (défaut 262144) ; contrôlé sur `Content-Length` et sur flux chunked | ✅ code [C-15, C-17] |
| `SENDZEN_TIMEOUT_MS` | entier 100–60000 (défaut 15000) | ✅ code [C-17] |
| `HOST` / `PORT` | défaut `127.0.0.1:8080` ; l'image Docker écoute `0.0.0.0` **sur le réseau interne uniquement** | ✅ code · exposition = DEVOPS |

## 5. Journaux

Une ligne JSON par requête, clés exactement `m, route, status, ms, note`. `route` remplace chaque segment variable par `:id`.
Jamais : en-tête `Authorization`, corps, texte de message, numéro, `phone_number_id`, message d'erreur de SendZen ✅ code [C-16, G].

## 6. Ce qui reste à confirmer (accord humain requis)

| Test | Question ouverte |
|---|---|
| T-S1 | En-tête et encodage réels de la signature ; secret par projet |
| T-S2 | Enveloppe Meta réelle ; forme de `metadata.phone_number_id` et `wa_id` |
| T-S3 | Boutons acceptés tels quels ; `button_reply` et `context.id` au retour ; `context` à l'envoi |
| T-S4 | Schéma liste accepté ; `list_reply` au retour ; format d'erreur à 11 lignes |
| T-S5 | `from` = identifiant ou E.164 ; réponse `202 {message_id}` et `X-Request-ID` |
| T-S6 | STOP transmis ; blocage des envois suivants |
| T-S7 | Ré-essais : même `wamid`, intervalles |
| T-S8 | Statuts au format Meta, rapprochables par identifiant |
| T-S9 | Réponses depuis le tableau de bord SendZen |
| T-S10 | Modèles : liste et envoi (débloquerait `template`) |

Tant que ces tests ne sont pas faits, la passerelle reste un **prototype** : elle ne doit pas porter de trafic réel.

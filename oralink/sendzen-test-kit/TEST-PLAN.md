# Plan de test SendZen — vérifier les déclarations par l'expérience

**Rien de ce plan n'a été exécuté.** Il ne doit l'être qu'avec **votre accord explicite** pour (1) la création d'un projet/numéro
de test et (2) la configuration d'un webhook. Les numéros TranZit existants ne sont jamais utilisés.

## Règles de sécurité
1. Un **numéro dédié** de test, dans un **projet SendZen séparé** ; un téléphone de test à vous.
2. Ne rien changer sur les projets/numéros/webhooks TranZit. Avant et après : lister (lecture seule) les configurations de webhook
   des projets existants et comparer.
3. Aucune donnée personnelle réelle : des messages de test uniquement. Les captures contiennent les corps bruts : fichier `captures/` (mode 600, ignoré par git), à supprimer après analyse.
4. Le récepteur écoute sur `127.0.0.1`. L'exposer pour SendZen (tunnel HTTPS) est une décision de votre part, temporaire, avec un chemin secret aléatoire.
5. `send-test.mjs` est en **simulation par défaut** ; `--send` exige des listes blanches (`TEST_FROM`, `ALLOWED_TEST_RECIPIENTS`) et refuse tout numéro de `PROTECTED_FROM`.
6. Aucun secret dans GitHub : la clé API et le secret de webhook ne vivent que dans votre shell / gestionnaire de mots de passe.

## Déclarations à vérifier (fournisseur)
| # | Déclaration | Statut actuel |
|---|---|---|
| D1 | Signature `X-Hub-Signature-256`, HMAC-SHA256, `sha256=<hex>` | déclaré par SendZen — **à vérifier** (T-S1) |
| D2 | Messages STOP transmis aux webhooks | déclaré — **à vérifier** (T-S6) |
| D3 | Désinscriptions gérées automatiquement | déclaré — **à vérifier**, y compris l'effet sur les envois suivants (T-S6) |
| D4 | Réponse humaine possible depuis le tableau de bord SendZen | déclaré — à vérifier **et** à confronter à la boîte waCRM (T-S9) |
| D5 | Connexion Meta directe simultanée déconseillée | déclaré — cohérent avec Z′ ; pas de test |

## Séquence
Démarrage : `SENDZEN_WEBHOOK_SECRET=<secret de test> node capture-server.mjs` (affiche l'URL `/hook/<jeton>`).

| Test | Action | À relever | Réussite |
|---|---|---|---|
| **T-S1 Signature** | créer le webhook de test (événements « Incoming message » et « Delivery status », `secret` de test), envoyer un message depuis votre téléphone | nom exact de l'en-tête, encodage ; `signatureVerified` dans `/__summary` | `X-Hub-Signature-256` + `sha256=<hex>` vérifié sur 100 % des requêtes ; une requête altérée est rejetée par waCRM |
| T-S2 Réception texte | texte simple, avec accents et emoji | format Meta ? valeur et forme de `metadata.phone_number_id` ; `contacts[].wa_id` (avec/sans `+`) ; horodatage | `phone_number_id` identique à celui utilisé en émission |
| T-S3 Boutons | `send-test.mjs buttons3 --send`, appuyer sur un bouton | `interactive.button_reply.{id,title}`, `context.id` | `id` = `test_driver` etc. ; titres ≤ 20 caractères acceptés |
| T-S4 Liste | `list10 --send`, choisir une ligne ; puis `list11 --send` (négatif) | `list_reply.{id,title,description}` ; format d'erreur à 11 lignes | 10 lignes acceptées, `list_reply.id` restitué ; 11 lignes refusées proprement |
| T-S5 Champ `from` | envoyer avec l'identifiant du numéro puis avec le numéro E.164 | lequel est accepté ; réponse 202 `message_id`, `X-Request-ID` | une forme acceptée, l'autre refusée avec un message clair → renseigne `NUMBER_MAP` |
| **T-S6 STOP** | envoyer « STOP », « Stop », « ARRÊT », « arret » depuis le téléphone ; puis tenter un envoi API vers ce numéro | le STOP arrive-t-il au webhook ? SendZen bloque-t-il ensuite l'envoi ? code d'erreur ? comment se réinscrire ? | STOP reçu dans le webhook (→ waCRM pourra enregistrer l'opposition) ; comportement de blocage documenté |
| T-S7 Retries / déduplication | `FAIL_NEXT=2` puis envoi d'un message | nombre de tentatives, intervalles, `id` stable (`wamid`) | même `messages[0].id` à chaque tentative (waCRM déduplique déjà sur `(conversation, message_id)` — migration 037) |
| T-S8 Statuts | envoyer plusieurs messages API | `sent/delivered/read/failed`, codes d'échec (fenêtre de 24 h dépassée, par exemple) | statuts au format Meta ; `id` rapprochable de l'envoi |
| **T-S9 Réponse humaine** | répondre depuis le tableau de bord SendZen | un événement arrive-t-il au webhook ? | si non : décision « on répond uniquement depuis waCRM » |
| T-S10 Modèles | lister les modèles par l'API ; envoyer un modèle de test approuvé ; cliquer un bouton de réponse rapide | schémas de liste et d'envoi ; `button.payload` au retour | débloque `template` dans la passerelle |
| T-S11 Médias entrants (facultatif) | envoyer une image de test | format ; mode de téléchargement | à décider (aucune pièce d'identité n'est collectée) |
| **T-S12 Rejeu dans waCRM** | `node replay-to-wacrm.mjs captures/<fichier>.jsonl --send --url http://127.0.0.1:3000/api/whatsapp/webhook` (staging privé, base de test, `REPLAY_SECRET` = `META_APP_SECRET`) ; rejouer deux fois | contact + conversation dans le **bon** compte, rien dans l'autre ; pas de doublon au second rejeu | isolation et idempotence confirmées |

## Livrable
Un court rapport par test (observé / attendu / décision), la table `NUMBER_MAP` renseignée, la liste des opérations de la passerelle à
activer (`ALLOW_TYPES`), et la décision finale **X / Z′ / Z-code** pour les numéros concernés.

## Tests déjà faits (sans SendZen)
- Côté waCRM : si SendZen signe comme annoncé, le vérificateur existant l'accepte (plusieurs secrets possibles), et rejette signature fausse, corps altéré, préfixe erroné, hexadécimal nu (`webhook-signature.sendzen-compat.test.ts`).
- Côté kit : reconnaissance de la signature (hex/base64), extraction boutons/liste/STOP, détection des doublons et intervalles, garde-fous d'envoi et de rejeu (`npm test` dans ce dossier).

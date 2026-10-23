# OraLink — usage facultatif d'OpenAI Codex

## Recommandation

Codex n'est **pas nécessaire** pour livrer le MVP. Il apporte une valeur réelle à un seul endroit : un **second regard
indépendant** (autre fournisseur, autre modèle) sur les PR où une erreur coûte cher. Ne pas lui confier de développement
tant que le MVP n'est pas livré : deux producteurs de code sur un projet tenu par une personne doublent les relectures.

| PR | Relecture Codex conseillée ? |
|---|---|
| CRM MÉTIER — migrations `9NN_oralink_*`, RLS, consentement/STOP, webhook | **Oui** |
| DEVOPS — scripts de sauvegarde/restauration, exposition réseau, gestion des clés | **Oui** |
| SENDZEN — passerelle (authentification, SSRF, journaux) | Oui si temps disponible |
| Contenu (pipelines, textes), documentation | Non |

## Règles d'échange

- **GitHub est le seul point d'échange** : Codex lit la PR (dépôt public) et répond en commentaire de PR, ou pousse sur une
  branche `feat/oralink-codex-<sujet>` distincte (convention unique `feat/oralink-*`). Jamais sur une branche d'un agent Claude, jamais sur `main`.
- **Aucun secret, aucune session partagée** : pas de `.env`, pas de jeton GitHub de Claude Code, pas d'accès à la VM.
- Une contribution Codex passe **la même CI** (OraLink CI + CI upstream) et la même revue QUALITÉ que le reste.
- Un constat Codex n'est jamais appliqué automatiquement : le coordinateur le vérifie, le reproduit, puis corrige ou réfute.

## Prompt de revue réutilisable

Copier tel quel dans Codex en remplaçant `<N>` :

```text
Tu es relecteur de sécurité indépendant. Dépôt public : github.com/elasriben/wacrm, PR #<N>.
Contexte : CRM WhatsApp multi-comptes (Next.js + Supabase/PostgreSQL avec RLS). Deux comptes clients isolés par account_id
(TranZit, Immerview). Envoi WhatsApp via une passerelle SendZen. Données personnelles de prospects au Maroc (loi 09-08).
Contrats d'interface : docs/oralink/CONTRACTS.md. Règles : docs/oralink/COORDINATION.md.

Lis uniquement le diff de la PR et les fichiers qu'il touche. N'exécute rien qui contacte un service réel.
Cherche, par ordre de priorité :
1. Fuite entre comptes : table sans RLS, politique sans is_account_member, fonction SECURITY DEFINER sans contrôle,
   requête service_role sans filtre account_id, abonnement Realtime non filtré.
2. Webhooks : signature X-Hub-Signature-256 non vérifiée ou comparée sans temps constant, rejeu/duplication (wamid),
   corps non borné, erreur qui révèle des données.
3. Consentement/STOP : un envoi automatisé (broadcast, flow, automatisation) qui contourne canSendAutomated,
   journal de consentement modifiable, STOP non détecté selon la casse/les accents.
4. Secrets : valeur réelle commitée, secret journalisé, clé privée de sauvegarde présente sur le serveur.
5. Exploitation : port exposé hors 80/443, restauration qui écrase la base réelle sans drapeau explicite, script non idempotent.
6. Migrations : non rejouables, destructrices sans sauvegarde, numérotation en conflit.

Pour chaque constat : fichier:ligne, scénario concret d'exploitation (entrée → effet), sévérité (critique/haute/moyenne/basse),
correction minimale. Sépare clairement « vérifié dans le code » et « supposition ». Termine par la liste de ce que tu as vérifié et de ce que tu n'as pas pu vérifier.
Ne propose pas de refonte hors du périmètre de la PR.
```

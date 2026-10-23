---
name: oralink-security-review
description: Use to review a pull request or change touching webhooks, RLS/migrations, service_role routes, the SendZen gateway, consents/STOP or deployment scripts in OraLink waCRM. Produces evidence-based findings and never claims absence of vulnerabilities.
---

# OraLink — revue de sécurité

Principes
- Lecture et analyse d'abord ; n'exécuter du code du diff que dans un conteneur jetable sans secret ni donnée réelle.
- Distinguer FAIT (prouvé par le code ou un test) et HYPOTHÈSE (à tester). Un scanner négatif ne prouve pas l'absence de faille ou de backdoor.
- Si un changement suspect apparaît : ne pas exécuter, présenter les éléments, demander l'accord avant de continuer.
- Ne jamais désactiver un test ou une protection pour faire passer une vérification.

Points à contrôler
1. Isolation entre comptes : RLS, fonctions SECURITY DEFINER (search_path, GRANT/REVOKE), routes `service_role` (vérifier l'appartenance au compte), chemins storage `account-<uuid>/…`.
2. Webhooks : HMAC‑SHA256 sur le corps brut, comparaison à temps constant, secrets multiples, rejeu, idempotence `(conversation_id, message_id)`.
3. SSRF et URL configurables (`WHATSAPP_API_BASE_URL`) : https obligatoire, pas d'identifiants dans l'URL, hôtes privés refusés hors développement.
4. Consentements : aucun consentement marketing déduit d'un scan de QR ni d'une demande d'information ; STOP bloque tout envoi ultérieur ; aucune collecte de CIN, permis ou documents personnels dans le chatbot.
5. Journaux : pas de jetons, textes de messages ni numéros en clair.
6. Migrations : droits, idempotence, verrous, effet sur données existantes ; plage `9NN_oralink_*`.
7. Scripts : pas de secret en clair, chemins quotés, pas de `curl | sh`, suppressions bornées.
8. CI : actions épinglées par SHA, permissions minimales, aucun secret requis.

Sortie : tableau (gravité, fichier:ligne, FAIT/HYPOTHÈSE, scénario, correctif minimal, test), verdict BLOQUANT / ACCEPTABLE AVEC RÉSERVES / ACCEPTABLE, et la liste de ce qui n'a pas été vérifié.

# oralink/ — prototype Z′ (SendZen) — BRANCHE EXPÉRIMENTALE

Rien ici n'est déployé ni connecté à un numéro réel. Les éléments, du plus sûr au plus expérimental :

| Dossier | Rôle | Tests |
|---|---|---|
| `sendzen-gateway/` | Passerelle Graph-compatible → API SendZen (aucune dépendance, aucun secret) · `DESIGN.md` | `cd oralink/sendzen-gateway && npm test` (17) + `src/lib/whatsapp/meta-api.gateway.integration.test.ts` (waCRM réel → passerelle → maquette) |
| `sendzen-test-kit/` | Récepteur de capture, envoi de test protégé, rejeu signé, `TEST-PLAN.md` | `cd oralink/sendzen-test-kit && npm test` (7) |

Dépend de la branche `exp/graph-base-url` (variable `WHATSAPP_API_BASE_URL`).

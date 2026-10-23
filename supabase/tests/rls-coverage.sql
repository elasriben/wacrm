-- Couverture RLS du schéma public (OraLink QUALITÉ) — appelé par run.sh après isolation.sql.
--
-- But : qu'une table ajoutée par une migration future (060+ ou upstream) ne puisse pas
-- arriver en production sans RLS ou sans aucune politique. Une table RLS activée mais sans
-- politique est fermée pour `authenticated` (aucune ligne) : ce n'est pas une fuite, mais
-- c'est presque toujours un oubli ; on exige donc une décision explicite (liste blanche).
--
-- Contrôles agrégés (leur nombre ne dépend pas du nombre de tables) :
--   1. contrôle témoin : l'inventaire n'est pas vide (sinon tout le reste réussirait à vide) ;
--   2. RLS activée sur toute table (ordinaire ou partitionnée) de public ;
--   3. au moins une politique sur toute table de public ;
--   4. aucune vue de public lisible par anon/authenticated sans security_invoker
--      (une vue « owner » contourne la RLS des tables sous-jacentes) ;
--   5. la liste blanche ne référence que des tables existantes (pas d'exemption orpheline).
--
-- Exécuter UNIQUEMENT sur la base jetable créée par run.sh.
\set ON_ERROR_STOP off
SET client_min_messages = warning;
CREATE TEMP TABLE res(test text, ok boolean, info text);

-- LISTE BLANCHE — exemptions explicites, une ligne par table, avec la raison.
--   rls  : table dispensée du contrôle 2 (RLS activée)
--   pol  : table dispensée du contrôle 3 (au moins une politique)
-- Tout ajout doit être justifié ici ET relu par QUALITÉ. Une exemption « pol » ne dispense
-- PAS du contrôle 2 : la table reste sous RLS, donc fermée à anon/authenticated (aucune
-- politique = aucune ligne visible ni modifiable), seule la clé service_role y accède.
CREATE TEMP TABLE rls_whitelist(tbl text, rule text CHECK (rule IN ('rls','pol')), reason text NOT NULL);
INSERT INTO rls_whitelist VALUES
  -- 006_automations.sql : « Service-role only — the engine uses the service-role client. No user policy exposed. »
  ('automation_pending_executions', 'pol', 'file d''attente du moteur d''automatisations, service_role seul (006)'),
  -- 054_webhook_status_integrity.sql : RLS + REVOKE ALL FROM anon, authenticated ; écrite par le webhook (service_role).
  ('pending_message_statuses', 'pol', 'statuts webhook en attente, service_role seul, REVOKE anon/authenticated (054)');

CREATE TEMP VIEW public_tables AS
  SELECT c.oid, c.relname::text AS relname, c.relrowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     -- partitions héritent des politiques de leur parent : seul le parent est contrôlé
     AND NOT c.relispartition;

-- 37 tables publiques au f9ba8c6 (README). Le seuil prouve que les migrations ont bien été rejouées.
INSERT INTO res SELECT 'RLS coverage: control - public schema has at least 37 tables', count(*) >= 37, count(*)::text || ' tables'
  FROM public_tables;

INSERT INTO res SELECT 'RLS coverage: RLS enabled on every public table (whitelist aside)', count(*) = 0,
       coalesce(string_agg(relname, ',' ORDER BY relname), '')
  FROM public_tables t
 WHERE NOT t.relrowsecurity
   AND NOT EXISTS (SELECT 1 FROM rls_whitelist w WHERE w.tbl = t.relname AND w.rule = 'rls');

INSERT INTO res SELECT 'RLS coverage: at least one policy on every public table (whitelist aside)', count(*) = 0,
       coalesce(string_agg(relname, ',' ORDER BY relname), '')
  FROM public_tables t
 WHERE NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid)
   AND NOT EXISTS (SELECT 1 FROM rls_whitelist w WHERE w.tbl = t.relname AND w.rule = 'pol');

INSERT INTO res SELECT 'RLS coverage: no public view readable by anon/authenticated without security_invoker', count(*) = 0,
       coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
   AND (has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('authenticated', c.oid, 'SELECT'))
   AND (c.relkind = 'm' OR NOT coalesce(c.reloptions @> ARRAY['security_invoker=true']
                                     OR c.reloptions @> ARRAY['security_invoker=on']
                                     OR c.reloptions @> ARRAY['security_invoker=1'], false));

INSERT INTO res SELECT 'RLS coverage: whitelist only names existing public tables', count(*) = 0,
       coalesce(string_agg(w.tbl, ',' ORDER BY w.tbl), '')
  FROM rls_whitelist w
 WHERE NOT EXISTS (SELECT 1 FROM public_tables t WHERE t.relname = w.tbl);

INSERT INTO res SELECT '(info) RLS coverage whitelist', true, coalesce(string_agg(tbl || ':' || rule || ' (' || reason || ')', '; '), 'empty')
  FROM rls_whitelist;

SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END r, test, info FROM res ORDER BY ok, test;
SELECT 'SUMMARY pass=' || count(*) FILTER (WHERE ok) || ' fail=' || count(*) FILTER (WHERE NOT ok) FROM res;

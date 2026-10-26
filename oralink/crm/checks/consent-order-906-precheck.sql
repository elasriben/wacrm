-- Relevé préalable à 906 (lecture seule, comptages uniquement).
--
--   psql -X -v ON_ERROR_STOP=1 -At -F ' | ' -d <copie> -f oralink/crm/checks/consent-order-906-precheck.sql
--
-- Fonctionne avant 904 comme en 904 ; refuse une base où 906 est déjà appliquée. À lancer par le
-- propriétaire de public.contact_consents (lecture de la séquence et des privilèges), de préférence
-- sur une copie. Aucun identifiant, téléphone, nom ni preuve n'est affiché : seulement des nombres,
-- et des ventilations par canal, finalité et source.
--
-- Sortie : « P<n> | libellé | valeur | BLOQUANT/REVUE/INFO/OK ».
--   BLOQUANT : 906 s'arrêtera (ou ne doit pas être lancée) tant que ce n'est pas corrigé.
--   REVUE    : 906 passera, mais une décision humaine est requise avant la production (voir la fin).
--   INFO     : à archiver avec le compte rendu de migration.
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.contact_consents'::regclass
             AND attname = 'decision_order' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'relevé 906 : decision_order existe déjà (906 appliquée) ; relevé sans objet';
  END IF;
END $$;

-- P0 : état de départ
SELECT 'P0', 'version de schéma', CASE WHEN pg_get_viewdef('public.contact_consent_current'::regclass) ~ 'recorded_at DESC'
  THEN 'pré-904 (ordre recorded_at)' ELSE '904 (ordre seq)' END, 'INFO';
SELECT 'P0', 'lignes / couples (compte, contact, canal, finalité)',
  (SELECT count(*) FROM public.contact_consents) || ' / '
  || (SELECT count(*) FROM (SELECT DISTINCT account_id, contact_id, channel, purpose FROM public.contact_consents) d), 'INFO';

-- P1 : préconditions de 906 (chacune fait échouer 906, sans effet partiel)
SELECT 'P1', 'propriétaire table = propriétaire du déclencheur',
  (c.relowner = p.proowner)::text, CASE WHEN c.relowner = p.proowner THEN 'OK' ELSE 'BLOQUANT' END
FROM pg_class c, pg_proc p
WHERE c.oid = 'public.contact_consents'::regclass AND p.oid = 'public.oralink_consent_guard()'::regprocedure;
SELECT 'P1', 'objets réservés déjà présents (séquence, index decision_order)',
  (to_regclass('public.contact_consents_decision_order_seq') IS NOT NULL)::text || ' / '
  || (to_regclass('public.contact_consents_decision_order_key') IS NOT NULL)::text,
  CASE WHEN to_regclass('public.contact_consents_decision_order_seq') IS NULL
        AND to_regclass('public.contact_consents_decision_order_key') IS NULL THEN 'OK' ELSE 'BLOQUANT' END;
WITH q AS (SELECT pg_get_serial_sequence('public.contact_consents', 'seq')::regclass AS sq)
SELECT 'P1', 'séquence seq : incrément 1, sans cycle', (s.seqincrement = 1 AND NOT s.seqcycle)::text,
  CASE WHEN s.seqincrement = 1 AND NOT s.seqcycle THEN 'OK' ELSE 'BLOQUANT' END
FROM q JOIN pg_sequence s ON s.seqrelid = q.sq;
-- CRM 907 bis (V3) : n'est compté que l'UPDATE qui SURVIT au REVOKE de 906 (PUBLIC, anon, authenticated,
-- service_role), c'est-à-dire porté par un autre bénéficiaire explicite de l'ACL, ou un superutilisateur.
-- Un UPDATE accordé seulement à PUBLIC est retiré par 906 : ce n'est pas un blocage (faux positif corrigé).
WITH q AS (SELECT pg_get_serial_sequence('public.contact_consents', 'seq')::regclass AS sq),
keep AS (
  SELECT a.grantee FROM q, pg_class c, aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) a
  WHERE c.oid = q.sq AND a.privilege_type = 'UPDATE' AND a.grantee <> 0
    AND a.grantee NOT IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role'))
),
r AS (SELECT oid, rolname AS role, rolsuper FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')),
hit AS (SELECT r.role FROM r WHERE r.rolsuper OR EXISTS (SELECT 1 FROM keep WHERE pg_has_role(r.oid, keep.grantee, 'USAGE')))
SELECT 'P1', 'UPDATE hérité sur la séquence, après le REVOKE de 906 (rôles)',
  coalesce((SELECT string_agg(role, ',' ORDER BY role) FROM hit), 'aucun'),
  CASE WHEN EXISTS (SELECT 1 FROM hit) THEN 'BLOQUANT' ELSE 'OK' END;
-- Même règle que 906 corrigée (patch 02) : un UPDATE survivant porté par un rôle atteignable par SET ROLE
-- (16+ : option SET ; avant 16 : toute appartenance) depuis un rôle applicatif ou authenticator.
WITH q AS (SELECT pg_get_serial_sequence('public.contact_consents', 'seq')::regclass AS sq),
m AS (SELECT CASE WHEN current_setting('server_version_num')::int >= 160000 THEN 'SET' ELSE 'MEMBER' END AS mode),
keep AS (
  SELECT a.grantee FROM q, pg_class c, aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) a
  WHERE c.oid = q.sq AND a.privilege_type = 'UPDATE' AND a.grantee <> 0
    AND a.grantee NOT IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role'))
),
r AS (SELECT oid, rolname AS role FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'authenticator')),
hits AS (
  SELECT r.role, t.rolname AS via FROM m, r, pg_roles t
  WHERE t.rolname NOT IN ('anon', 'authenticated', 'service_role')
    AND pg_has_role(r.oid, t.oid, m.mode)
    AND (t.rolsuper OR EXISTS (SELECT 1 FROM keep WHERE pg_has_role(t.oid, keep.grantee, 'USAGE')))
)
SELECT 'P1', 'UPDATE sur la séquence atteignable par SET ROLE (rôle <- via)',
  coalesce(string_agg(DISTINCT role || ' <- ' || via, ', '), 'aucun'),
  CASE WHEN count(*) = 0 THEN 'OK' ELSE 'BLOQUANT' END
FROM hits;

-- P2 : marge de la séquence (906 refuse si max(seq, last_value) > seqmax - 2)
SELECT 'P2', 'marge restante de la séquence seq', (s.seqmax - greatest(coalesce(m.mx, 0), coalesce(sv.last_value, 0)))::text,
  CASE WHEN s.seqmax - greatest(coalesce(m.mx, 0), coalesce(sv.last_value, 0)) < 2 THEN 'BLOQUANT'
       WHEN s.seqmax - greatest(coalesce(m.mx, 0), coalesce(sv.last_value, 0)) < 1000000000 THEN 'REVUE' ELSE 'OK' END
FROM pg_sequence s, pg_sequences sv, (SELECT max(seq) AS mx FROM public.contact_consents) m
WHERE s.seqrelid = pg_get_serial_sequence('public.contact_consents', 'seq')::regclass
  AND sv.schemaname = 'public' AND sv.sequencename = (SELECT relname FROM pg_class WHERE oid = s.seqrelid);
SELECT 'P2', 'lignes à seq forgé au-dessus du compteur', count(*)::text,
  CASE WHEN count(*) = 0 THEN 'OK' ELSE 'INFO' END
FROM public.contact_consents, pg_sequences sv
WHERE sv.schemaname = 'public'
  AND sv.sequencename = (SELECT relname FROM pg_class WHERE oid = pg_get_serial_sequence('public.contact_consents', 'seq')::regclass)
  AND seq > coalesce(sv.last_value, 0);
-- 906 recale la séquence au-dessus : sans risque de collision après 906. Un seq forgé SOUS le compteur est indétectable.

-- P3 : effet du remplissage de 906 (même règle : revoked si l'un des deux anciens ordres dit revoked).
-- Une seule requête : une transaction READ ONLY interdit tout CREATE, même temporaire.
WITH t AS (
  SELECT DISTINCT ON (account_id, contact_id, channel, purpose)
    account_id, contact_id, channel, purpose, status, source, recorded_at
  FROM public.contact_consents
  ORDER BY account_id, contact_id, channel, purpose, recorded_at DESC, seq DESC, id DESC
), s AS (
  SELECT DISTINCT ON (account_id, contact_id, channel, purpose)
    account_id, contact_id, channel, purpose, status
  FROM public.contact_consents
  ORDER BY account_id, contact_id, channel, purpose, seq DESC, id DESC
), w AS (
  SELECT t.channel, t.purpose, t.source AS t_source, t.recorded_at AS t_at,
         t.status AS t_status, s.status AS s_status,
         (t.status = 'granted' AND s.status = 'revoked') AS a,   -- START écarté (vs pré-904)
         (s.status = 'granted' AND t.status = 'revoked') AS b    -- STOP rétabli (vs 904)
  FROM t JOIN s USING (account_id, contact_id, channel, purpose)
), lines AS (
  SELECT 1 AS o, 'couples divergents (ordre recorded_at ≠ ordre seq)' AS l, count(*) FILTER (WHERE t_status <> s_status)::text AS v,
    CASE WHEN count(*) FILTER (WHERE t_status <> s_status) = 0 THEN 'OK' ELSE 'INFO' END AS d FROM w
  UNION ALL
  SELECT 2, 'A. révoqués par 906 alors que l''ordre pré-904 disait granted (START écarté)', count(*) FILTER (WHERE a)::text,
    CASE WHEN count(*) FILTER (WHERE a) = 0 THEN 'OK' ELSE 'REVUE' END FROM w
  UNION ALL
  SELECT 3, 'B. révoqués par 906 alors que l''ordre 904 disait granted (STOP rétabli)', count(*) FILTER (WHERE b)::text,
    CASE WHEN count(*) FILTER (WHERE b) = 0 THEN 'OK' ELSE 'REVUE' END FROM w
  UNION ALL
  SELECT 4, 'A dont START enregistré depuis moins de 30 jours', count(*) FILTER (WHERE a AND t_at > now() - interval '30 days')::text, 'INFO' FROM w
  UNION ALL
  SELECT 5, 'ventilation A canal/finalité/source : ' || channel || '/' || purpose || '/' || t_source, count(*)::text, 'INFO'
    FROM w WHERE a GROUP BY channel, purpose, t_source
  UNION ALL
  SELECT 6, 'ventilation B canal/finalité/source : ' || channel || '/' || purpose || '/' || t_source, count(*)::text, 'INFO'
    FROM w WHERE b GROUP BY channel, purpose, t_source
)
SELECT 'P3', l, v, d FROM lines ORDER BY o, l;

-- P4 : dates futures (sans effet sur l'ordre de 906 ; à signaler car recorded_at reste affiché)
SELECT 'P4', 'lignes datées dans le futur', count(*)::text, CASE WHEN count(*) = 0 THEN 'OK' ELSE 'INFO' END
FROM public.contact_consents WHERE recorded_at > now();

ROLLBACK;

-- Décision (à consigner avec la sortie) :
--  * un BLOQUANT     -> ne pas lancer 906 ; corriger (DEVOPS) puis relancer le relevé.
--  * P3 A = 0 et B = 0 -> 906 peut s'appliquer ; le NOTICE de 906 doit annoncer « 0 … 0 ».
--  * P3 B > 0        -> aucune réconciliation des données (906 rétablit le STOP), mais base déjà en 904 :
--                       ces contacts ont pu recevoir des envois après leur STOP -> analyse conformité.
--  * P3 A > 0        -> revue humaine AVANT la production : 906 écarte ces START. Ne les rétablir
--                       qu'avec une preuve d'opt-in explicite (message START conservé), par une
--                       NOUVELLE décision ajoutée après 906 (preuve 'OL-14 reconciliation <réf>'),
--                       jamais en modifiant l'historique. Sans preuve : laisser revoked.
--  * La liste nominative des couples A/B n'est pas produite ici ; si nécessaire, l'extraire à part,
--    sous la procédure données personnelles, sur la copie uniquement.
--  * Le NOTICE de 906 doit donner les mêmes A et B que ce relevé (même instant, sans écriture entre-temps).

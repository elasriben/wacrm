-- OraLink CRM — test défensif de public.is_account_member (migration 903, OL-14).
--
-- Vérifie DIRECTEMENT la configuration (search_path, références qualifiées, propriétaire,
-- SECURITY DEFINER, privilèges EXECUTE, dépendances), puis le comportement : hiérarchie des
-- rôles et isolation entre deux comptes E et F, au niveau de la fonction et à travers les
-- politiques RLS qui l'appellent (contacts, lead_scores).
--
-- Autonome : utilisateurs e0…/f0… (distincts de a0/b0 et c0/d0), données fictives (@test.local,
-- +155555502xx). Exécuter UNIQUEMENT sur une base jetable où toutes les migrations, 903 comprise,
-- ont été appliquées (voir oralink/crm/tests/run-isolation-cases.sh).
-- Sortie : lignes « PASS | … » / « FAIL | … » puis « SUMMARY pass=<n> fail=<n> ».
-- ON_ERROR_STOP on : une requête de contrôle en erreur arrête le fichier avant SUMMARY. Un refus
-- attendu n'est compté que s'il lève insufficient_privilege (42501).
\set ON_ERROR_STOP on
SET client_min_messages = warning;
CREATE TEMP TABLE iam_res(test text, ok boolean, info text);
GRANT ALL ON iam_res TO PUBLIC;

-- ---------- configuration (assertions directes) ----------
CREATE TEMP TABLE iam_fn AS
SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig, p.proacl, p.prosrc,
       pg_get_userbyid(p.proowner) AS owner,
       pg_get_function_identity_arguments(p.oid) AS ident_args,
       pg_get_function_arguments(p.oid) AS args
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'is_account_member';

INSERT INTO iam_res SELECT 'is_account_member: exactly one overload in public', count(*) = 1, count(*)::text FROM iam_fn;
INSERT INTO iam_res SELECT 'is_account_member: signature and default unchanged',
  args = 'target_account_id uuid, min_role account_role_enum DEFAULT ''viewer''::account_role_enum', args FROM iam_fn;
INSERT INTO iam_res SELECT 'is_account_member: SECURITY DEFINER kept', prosecdef, prosecdef::text FROM iam_fn;
INSERT INTO iam_res SELECT 'is_account_member: STABLE kept', provolatile = 's', provolatile::text FROM iam_fn;
INSERT INTO iam_res SELECT 'is_account_member: proconfig is exactly search_path=pg_catalog, pg_temp',
  proconfig = ARRAY['search_path=pg_catalog, pg_temp'], coalesce(array_to_string(proconfig, ';'), '(none)') FROM iam_fn;
INSERT INTO iam_res SELECT 'is_account_member: pg_temp is the LAST search_path entry',
  coalesce(bool_or(c ~ '^search_path=.*,\s*pg_temp$'), false), coalesce(string_agg(c, ';'), '(none)')
  FROM iam_fn, unnest(coalesce(proconfig, '{}')) c;
INSERT INTO iam_res SELECT 'is_account_member: public is not on its search_path',
  NOT EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%' AND c ~ '\mpublic\M'), coalesce(array_to_string(proconfig, ';'), '') FROM iam_fn;
INSERT INTO iam_res SELECT 'is_account_member: reads public.profiles (qualified)', prosrc ~ '\mFROM\s+public\.profiles\M', '' FROM iam_fn;
INSERT INTO iam_res SELECT 'is_account_member: no unqualified relation after FROM/JOIN',
  NOT (prosrc ~* '\m(FROM|JOIN)\s+(?!public\.|auth\.|pg_catalog\.)[a-z_]'), '' FROM iam_fn;
INSERT INTO iam_res SELECT 'is_account_member: calls auth.uid() (qualified)', prosrc ~ '\mauth\.uid\(\)' AND prosrc !~ '(^|[^.\w])uid\(\)', '' FROM iam_fn;
INSERT INTO iam_res SELECT 'is_account_member: enum literals cast to public.account_role_enum',
  (SELECT count(*) FROM regexp_matches(prosrc, '''(owner|admin|agent|viewer)''::public\.account_role_enum', 'g')) = 8
  AND prosrc !~ '''(owner|admin|agent|viewer)''(?!::public\.account_role_enum)', '' FROM iam_fn;
INSERT INTO iam_res SELECT 'is_account_member: owner also owns public.profiles, no FORCE RLS (definer reads profiles without RLS)',
  f.owner = pg_get_userbyid(c.relowner) AND NOT c.relforcerowsecurity,
  f.owner || ' / profiles owner=' || pg_get_userbyid(c.relowner) || ' force_rls=' || c.relforcerowsecurity
  FROM iam_fn f, pg_class c WHERE c.oid = 'public.profiles'::regclass;

-- ---------- privilèges ----------
INSERT INTO iam_res SELECT 'is_account_member: explicit ACL (not the implicit PUBLIC default)', proacl IS NOT NULL, coalesce(array_to_string(proacl, ' '), '(null)') FROM iam_fn;
INSERT INTO iam_res SELECT 'is_account_member: no EXECUTE for PUBLIC',
  NOT EXISTS (SELECT 1 FROM iam_fn, aclexplode(proacl) a WHERE a.grantee = 0), '' ;
INSERT INTO iam_res SELECT 'is_account_member: EXECUTE kept for '||r, has_function_privilege(r, f.oid, 'EXECUTE'), ''
  FROM iam_fn f, unnest(ARRAY['anon', 'authenticated', 'service_role']) r;
INSERT INTO iam_res SELECT 'is_account_member: no grantee other than owner, anon, authenticated, service_role',
  coalesce(bool_and(pg_get_userbyid(a.grantee) IN ('postgres', 'anon', 'authenticated', 'service_role')), false),
  string_agg(DISTINCT pg_get_userbyid(a.grantee), ',')
  FROM iam_fn, aclexplode(proacl) a;
INSERT INTO iam_res SELECT 'is_account_member: no WITH GRANT OPTION', NOT coalesce(bool_or(a.is_grantable AND a.grantee <> a.grantor), false), ''
  FROM iam_fn, aclexplode(proacl) a;
-- Rôle témoin sans aucun droit explicite : avant 903 il héritait d'EXECUTE via PUBLIC.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oralink_iam_probe_test') THEN CREATE ROLE oralink_iam_probe_test NOLOGIN; END IF;
END $$;
INSERT INTO iam_res SELECT 'is_account_member: role with no explicit grant cannot EXECUTE',
  NOT has_function_privilege('oralink_iam_probe_test', oid, 'EXECUTE'), '' FROM iam_fn;
DROP ROLE oralink_iam_probe_test;

-- ---------- dépendances ----------
INSERT INTO iam_res SELECT 'is_account_member: RLS policies still depend on it (>= 115, on contacts, lead_scores, contact_consents)',
  count(*) >= 115 AND bool_or(pol.polrelid = 'public.contacts'::regclass) AND bool_or(pol.polrelid = 'public.lead_scores'::regclass)
    AND bool_or(pol.polrelid = 'public.contact_consents'::regclass),
  count(*) || ' policies on ' || count(DISTINCT pol.polrelid) || ' tables'
  FROM pg_depend d JOIN pg_policy pol ON d.classid = 'pg_policy'::regclass AND d.objid = pol.oid
 WHERE d.refobjid = (SELECT oid FROM iam_fn);

-- ---------- comportement : comptes E (owner, admin, agent, viewer) et F (owner) ----------
INSERT INTO auth.users(id, email) VALUES
 ('e0000000-0000-0000-0000-0000000000e1', 'e1@test.local'),
 ('e0000000-0000-0000-0000-0000000000e2', 'e2@test.local'),
 ('e0000000-0000-0000-0000-0000000000e3', 'e3@test.local'),
 ('e0000000-0000-0000-0000-0000000000e4', 'e4@test.local'),
 ('e0000000-0000-0000-0000-0000000000e5', 'e5@test.local'),
 ('f0000000-0000-0000-0000-0000000000f1', 'f1@test.local');
DO $$ DECLARE acc_e uuid; r record; BEGIN
  SELECT account_id INTO acc_e FROM public.profiles WHERE user_id = 'e0000000-0000-0000-0000-0000000000e1';
  FOR r IN SELECT * FROM (VALUES ('e0000000-0000-0000-0000-0000000000e2'::uuid, 'admin'),
                                 ('e0000000-0000-0000-0000-0000000000e3'::uuid, 'agent'),
                                 ('e0000000-0000-0000-0000-0000000000e4'::uuid, 'viewer'),
                                 ('e0000000-0000-0000-0000-0000000000e5'::uuid, 'agent')) v(u, role) LOOP
    UPDATE public.profiles SET account_id = acc_e, account_role = r.role::public.account_role_enum WHERE user_id = r.u;
    DELETE FROM public.accounts WHERE owner_user_id = r.u AND id <> acc_e;
  END LOOP;
END $$;
CREATE TEMP TABLE iam_ids AS SELECT
 (SELECT account_id FROM public.profiles WHERE user_id = 'e0000000-0000-0000-0000-0000000000e1') acc_e,
 (SELECT account_id FROM public.profiles WHERE user_id = 'f0000000-0000-0000-0000-0000000000f1') acc_f;
GRANT SELECT ON iam_ids TO PUBLIC;
DO $$ DECLARE e uuid; f uuid; ce uuid; cf uuid; BEGIN
  SELECT acc_e, acc_f INTO e, f FROM iam_ids;
  INSERT INTO public.contacts(user_id, phone, account_id, name) VALUES ('e0000000-0000-0000-0000-0000000000e1', '+15555550201', e, 'Lead E') RETURNING id INTO ce;
  INSERT INTO public.contacts(user_id, phone, account_id, name) VALUES ('f0000000-0000-0000-0000-0000000000f1', '+15555550201', f, 'Lead F') RETURNING id INTO cf;
  INSERT INTO public.lead_scores(account_id, contact_id, score, rules_version) VALUES (e, ce, 40, 'test'), (f, cf, 60, 'test');
END $$;
INSERT INTO iam_res SELECT 'SEED control: E and F each have 1 contact and 1 lead score',
  (SELECT count(*) FROM public.contacts WHERE account_id IN (acc_e, acc_f)) = 2 AND (SELECT count(*) FROM public.lead_scores WHERE account_id IN (acc_e, acc_f)) = 2,
  '' FROM iam_ids;

-- Table de vérité : 7 identités × 4 cibles × 5 rôles minimaux (dont la valeur par défaut) = 140 appels.
CREATE TEMP TABLE iam_truth(who text, acct text, min_role text, result boolean);
GRANT ALL ON iam_truth TO PUBLIC;
DO $$ DECLARE w record; t record; m text; res boolean; e uuid; f uuid; BEGIN
  SELECT acc_e, acc_f INTO e, f FROM iam_ids;
  FOR w IN SELECT * FROM (VALUES ('owner E', 'authenticated', 'e0000000-0000-0000-0000-0000000000e1'),
                                 ('admin E', 'authenticated', 'e0000000-0000-0000-0000-0000000000e2'),
                                 ('agent E', 'authenticated', 'e0000000-0000-0000-0000-0000000000e3'),
                                 ('viewer E', 'authenticated', 'e0000000-0000-0000-0000-0000000000e4'),
                                 ('owner F', 'authenticated', 'f0000000-0000-0000-0000-0000000000f1'),
                                 ('unknown uid', 'authenticated', 'e0000000-0000-0000-0000-0000000000e9'),
                                 ('anon', 'anon', NULL)) v(who, rol, sub) LOOP
    PERFORM set_config('request.jwt.claim.sub', coalesce(w.sub, ''), false);
    PERFORM set_config('request.jwt.claims', CASE WHEN w.sub IS NULL THEN '{"role":"anon"}' ELSE json_build_object('sub', w.sub, 'role', w.rol)::text END, false);
    EXECUTE format('SET ROLE %I', w.rol);
    FOR t IN SELECT * FROM (VALUES ('E', e), ('F', f), ('random', 'e0000000-0000-0000-0000-0000000000d9'::uuid), ('NULL', NULL::uuid)) v(lbl, id) LOOP
      FOREACH m IN ARRAY ARRAY['owner', 'admin', 'agent', 'viewer', '(default)'] LOOP
        IF m = '(default)' THEN res := public.is_account_member(t.id);
        ELSE res := public.is_account_member(t.id, m::public.account_role_enum); END IF;
        INSERT INTO iam_truth VALUES (w.who, t.lbl, m, res);
      END LOOP;
    END LOOP;
    RESET ROLE;
  END LOOP;
END $$;
INSERT INTO iam_res SELECT 'is_account_member: 140 calls, none NULL', count(*) = 140 AND count(result) = 140, count(*) || ' calls' FROM iam_truth;
INSERT INTO iam_res SELECT 'is_account_member: role hierarchy owner>admin>agent>viewer on own account (19 true)',
  count(*) FILTER (WHERE result) = 19
  AND bool_and(result = (
        ((acct = 'E' AND who LIKE '% E') OR (acct = 'F' AND who = 'owner F'))
    AND (min_role IN ('viewer', '(default)')
         OR (min_role = 'agent' AND who <> 'viewer E')
         OR (min_role = 'admin' AND who IN ('owner E', 'admin E', 'owner F'))
         OR (min_role = 'owner' AND who IN ('owner E', 'owner F'))))),
  count(*) FILTER (WHERE result) || ' true' FROM iam_truth;
INSERT INTO iam_res SELECT 'is_account_member: false for other account, random/NULL account, unknown uid and anon',
  NOT coalesce(bool_or(result), false), coalesce(string_agg(who || '->' || acct || ':' || min_role, ',') FILTER (WHERE result), '')
  FROM iam_truth WHERE NOT ((acct = 'E' AND who LIKE '% E') OR (acct = 'F' AND who = 'owner F'));

-- À travers les politiques RLS dépendantes.
RESET ROLE; SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-0000000000e4', false),
       set_config('request.jwt.claims', '{"sub":"e0000000-0000-0000-0000-0000000000e4","role":"authenticated"}', false) \gset
INSERT INTO iam_res SELECT 'RLS via is_account_member: viewer E sees E contact and lead score only',
  (SELECT count(*) FROM public.contacts WHERE account_id = acc_e) = 1 AND (SELECT count(*) FROM public.contacts WHERE account_id = acc_f) = 0
  AND (SELECT count(*) FROM public.lead_scores WHERE account_id = acc_e) = 1 AND (SELECT count(*) FROM public.lead_scores WHERE account_id = acc_f) = 0, '' FROM iam_ids;
DO $$ DECLARE ok boolean := false; BEGIN
  BEGIN INSERT INTO public.contacts(user_id, phone, account_id, name) SELECT 'e0000000-0000-0000-0000-0000000000e4', '+15555550202', acc_e, 'x' FROM iam_ids;
  EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  INSERT INTO iam_res VALUES ('RLS via is_account_member: viewer E cannot INSERT a contact (agent required)', ok, '');
END $$;

RESET ROLE; SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-0000000000f1', false),
       set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-0000000000f1","role":"authenticated"}', false) \gset
INSERT INTO iam_res SELECT 'RLS via is_account_member: owner F sees no E contact or lead score',
  (SELECT count(*) FROM public.contacts WHERE account_id = acc_e) = 0 AND (SELECT count(*) FROM public.lead_scores WHERE account_id = acc_e) = 0
  AND (SELECT count(*) FROM public.contacts WHERE account_id = acc_f) = 1, '' FROM iam_ids;
DO $$ DECLARE ok boolean := false; BEGIN
  BEGIN INSERT INTO public.contacts(user_id, phone, account_id, name) SELECT 'f0000000-0000-0000-0000-0000000000f1', '+15555550203', acc_e, 'x' FROM iam_ids;
  EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  INSERT INTO iam_res VALUES ('RLS via is_account_member: owner F cannot INSERT a contact into E', ok, '');
END $$;
WITH u AS (UPDATE public.lead_scores SET score = 99 WHERE account_id = (SELECT acc_e FROM iam_ids) RETURNING 1)
INSERT INTO iam_res SELECT 'RLS via is_account_member: owner F UPDATE on E lead score touches 0 rows', count(*) = 0, count(*)::text FROM u;

RESET ROLE; SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-0000000000e3', false),
       set_config('request.jwt.claims', '{"sub":"e0000000-0000-0000-0000-0000000000e3","role":"authenticated"}', false) \gset
WITH i AS (INSERT INTO public.contacts(user_id, phone, account_id, name)
            SELECT 'e0000000-0000-0000-0000-0000000000e3', '+15555550204', acc_e, 'Lead E2' FROM iam_ids RETURNING 1)
INSERT INTO iam_res SELECT 'RLS via is_account_member: agent E can INSERT a contact into E (legitimate access kept)', count(*) = 1, count(*)::text FROM i;

RESET ROLE; SET ROLE anon;
SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '{"role":"anon"}', false) \gset
INSERT INTO iam_res SELECT 'RLS via is_account_member: anon reads 0 E/F contacts and lead scores (no error)',
  (SELECT count(*) FROM public.contacts WHERE account_id IN (acc_e, acc_f)) = 0 AND (SELECT count(*) FROM public.lead_scores WHERE account_id IN (acc_e, acc_f)) = 0, '' FROM iam_ids;

RESET ROLE;
INSERT INTO iam_res SELECT 'is_account_member: lead score of E unchanged after F attempt', score = 40, score::text
  FROM public.lead_scores WHERE account_id = (SELECT acc_e FROM iam_ids);

-- ---------- appartenance révoquée : agent e5 retiré de E par la RPC réelle remove_account_member ----------
CREATE TEMP TABLE iam_rev(step text, ok boolean);
GRANT ALL ON iam_rev TO PUBLIC;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-0000000000e5', false),
       set_config('request.jwt.claims', '{"sub":"e0000000-0000-0000-0000-0000000000e5","role":"authenticated"}', false) \gset
INSERT INTO iam_rev SELECT 'before', public.is_account_member(acc_e, 'agent') AND (SELECT count(*) FROM public.contacts WHERE account_id = acc_e) >= 1 FROM iam_ids;
RESET ROLE; SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-0000000000e1', false),
       set_config('request.jwt.claims', '{"sub":"e0000000-0000-0000-0000-0000000000e1","role":"authenticated"}', false) \gset
SELECT public.remove_account_member('e0000000-0000-0000-0000-0000000000e5') IS NOT NULL AS removed \gset
RESET ROLE; SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-0000000000e5', false),
       set_config('request.jwt.claims', '{"sub":"e0000000-0000-0000-0000-0000000000e5","role":"authenticated"}', false) \gset
INSERT INTO iam_rev SELECT 'after', NOT public.is_account_member(acc_e) AND NOT public.is_account_member(acc_e, 'agent')
  AND (SELECT count(*) FROM public.contacts WHERE account_id = acc_e) = 0 AND (SELECT count(*) FROM public.lead_scores WHERE account_id = acc_e) = 0
  FROM iam_ids;
DO $$ DECLARE ok boolean := false; BEGIN
  BEGIN INSERT INTO public.contacts(user_id, phone, account_id, name) SELECT 'e0000000-0000-0000-0000-0000000000e5', '+15555550205', acc_e, 'x' FROM iam_ids;
  EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  INSERT INTO iam_rev VALUES ('after insert refused', ok);
END $$;
INSERT INTO iam_rev SELECT 'owner of own new account',
  public.is_account_member((SELECT account_id FROM public.profiles WHERE user_id = 'e0000000-0000-0000-0000-0000000000e5'), 'owner');
RESET ROLE;
INSERT INTO iam_res SELECT 'revoked membership: agent removed via remove_account_member loses E (function, SELECT, INSERT)',
  count(*) = 4 AND bool_and(ok), string_agg(step || '=' || ok, ',' ORDER BY step) FROM iam_rev;

-- ---------- preuve directe du correctif : résolution des noms ----------
-- Un objet homonyme placé dans le schéma temporaire de la session (consulté EN PREMIER pour les
-- noms de tables non qualifiés lorsque pg_temp n'est pas cité dans le search_path) ne doit avoir
-- aucun effet. Témoin fictif : il déclare viewer E et owner F « owner » de E. Résultat attendu :
-- la fonction ne le lit pas. Cet objet est supprimé aussitôt (d'autres fonctions DEFINER du schéma
-- utilisent encore des noms non qualifiés : liste confiée à QUALITÉ).
CREATE TEMP TABLE profiles(user_id uuid, account_id uuid, account_role public.account_role_enum);
INSERT INTO pg_temp.profiles SELECT u, acc_e, 'owner' FROM iam_ids,
  unnest(ARRAY['e0000000-0000-0000-0000-0000000000e4', 'f0000000-0000-0000-0000-0000000000f1']::uuid[]) u;
GRANT SELECT ON pg_temp.profiles TO PUBLIC;
CREATE TEMP TABLE iam_shadow(who text, result boolean);
GRANT ALL ON iam_shadow TO PUBLIC;
DO $$ DECLARE w text; e uuid := (SELECT acc_e FROM iam_ids); BEGIN
  FOREACH w IN ARRAY ARRAY['e0000000-0000-0000-0000-0000000000e4', 'f0000000-0000-0000-0000-0000000000f1'] LOOP
    PERFORM set_config('request.jwt.claim.sub', w, false);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', w, 'role', 'authenticated')::text, false);
    SET ROLE authenticated;
    INSERT INTO iam_shadow VALUES (w, public.is_account_member(e, 'owner'));
    RESET ROLE;
  END LOOP;
END $$;
DROP TABLE pg_temp.profiles;
INSERT INTO iam_res SELECT 'name resolution: a session-local profiles object does not change the result (viewer E, owner F stay non-owner of E)',
  count(*) = 2 AND NOT bool_or(result), string_agg(result::text, ',') FROM iam_shadow;
DO $$ DECLARE sp text; unq regclass; BEGIN
  SELECT substr(c, length('search_path=') + 1) INTO sp FROM iam_fn, unnest(proconfig) c WHERE c LIKE 'search_path=%';
  PERFORM set_config('search_path', coalesce(sp, 'public'), true);  -- local à cette transaction
  unq := to_regclass('profiles');
  INSERT INTO pg_temp.iam_res VALUES ('name resolution: under the function search_path, unqualified profiles resolves to nothing',
    sp IS NOT NULL AND unq IS NULL AND to_regclass('public.profiles') IS NOT NULL, coalesce(sp, '(none)') || ' -> ' || coalesce(unq::text, 'unresolved'));
END $$;

SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END r, test, info FROM iam_res ORDER BY ok, test;
SELECT 'SUMMARY pass=' || count(*) FILTER (WHERE ok) || ' fail=' || count(*) FILTER (WHERE NOT coalesce(ok, false)) FROM iam_res;

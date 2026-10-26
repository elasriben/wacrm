-- OraLink CRM : non-régression de la migration 904 (correctifs résiduels OL-14).
--   A. privilèges de table sur lead_scores / contact_consents (TRUNCATE, TRIGGER, REFERENCES, écritures anon)
--   B. redeem_invitation : résolution des noms, privilèges, contrôles métier
--   C. contact_consent_current : ordre déterministe, la dernière révocation n'est jamais supplantée
-- plus l'isolation multi-comptes et le STOP sur ces objets.
--
-- Autonome : utilisateurs 9a…/9b…/9c…, téléphones +155555504xx, tout est fictif (@test.local).
-- Base JETABLE uniquement (voir run-ol14-residual.sh). Sortie : « PASS | … » / « FAIL | … » puis « SUMMARY pass=<n> fail=<n> ».
\set ON_ERROR_STOP on
SET client_min_messages = warning;
CREATE TEMP TABLE r14(test text, ok boolean, info text);
GRANT ALL ON r14 TO PUBLIC;

-- G : owner g1 + agent g2 · H : owner h1 · i1, i2 : seuls dans un compte vide · j1 : seul, compte avec données
INSERT INTO auth.users(id,email) VALUES
 ('9a000000-0000-0000-0000-000000000001','g1@test.local'),
 ('9a000000-0000-0000-0000-000000000002','g2@test.local'),
 ('9b000000-0000-0000-0000-000000000001','h1@test.local'),
 ('9c000000-0000-0000-0000-000000000001','i1@test.local'),
 ('9c000000-0000-0000-0000-000000000002','i2@test.local'),
 ('9c000000-0000-0000-0000-000000000003','j1@test.local');
UPDATE public.profiles SET account_id=(SELECT account_id FROM public.profiles WHERE user_id='9a000000-0000-0000-0000-000000000001'), account_role='agent'
 WHERE user_id='9a000000-0000-0000-0000-000000000002';
DELETE FROM public.accounts WHERE owner_user_id='9a000000-0000-0000-0000-000000000002';

CREATE TEMP TABLE k14 AS SELECT
 (SELECT account_id FROM public.profiles WHERE user_id='9a000000-0000-0000-0000-000000000001') accG,
 (SELECT account_id FROM public.profiles WHERE user_id='9b000000-0000-0000-0000-000000000001') accH,
 (SELECT account_id FROM public.profiles WHERE user_id='9c000000-0000-0000-0000-000000000001') accI1,
 (SELECT account_id FROM public.profiles WHERE user_id='9c000000-0000-0000-0000-000000000003') accJ1,
 NULL::uuid ctG, NULL::uuid ctH, NULL::uuid ctJ;
GRANT SELECT ON k14 TO PUBLIC;

DO $$ DECLARE k record; x uuid; y uuid; z uuid; BEGIN
 SELECT * INTO k FROM k14;
 INSERT INTO public.contacts(user_id,phone,account_id,name) VALUES ('9a000000-0000-0000-0000-000000000001','+15555550401',k.accG,'Lead G') RETURNING id INTO x;
 INSERT INTO public.contacts(user_id,phone,account_id,name) VALUES ('9b000000-0000-0000-0000-000000000001','+15555550401',k.accH,'Lead H') RETURNING id INTO y; -- même numéro, autre compte
 INSERT INTO public.contacts(user_id,phone,account_id,name) VALUES ('9c000000-0000-0000-0000-000000000003','+15555550403',k.accJ1,'Lead J') RETURNING id INTO z;
 UPDATE k14 SET ctG=x, ctH=y, ctJ=z;
 INSERT INTO public.lead_scores(account_id,contact_id,score,rules_version) VALUES (k.accG,x,30,'ol14'),(k.accH,y,60,'ol14');
 INSERT INTO public.contact_consents(account_id,contact_id,purpose,status,source,evidence) VALUES
  (k.accG,x,'marketing','granted','inbound','ol14-G'),(k.accH,y,'marketing','granted','inbound','ol14-H');
 INSERT INTO public.account_invitations(account_id,token_hash,role,expires_at) VALUES
  (k.accG,'ol14-valid','agent',now()+interval '1 day'),
  (k.accG,'ol14-expired','agent',now()-interval '1 minute'),
  (k.accG,'ol14-for-member','viewer',now()+interval '1 day'),
  (k.accG,'ol14-for-data','viewer',now()+interval '1 day');
END $$;

CREATE OR REPLACE FUNCTION pg_temp.as_user(uid text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM set_config('request.jwt.claim.sub', coalesce(uid,''), false);
 PERFORM set_config('request.jwt.claims', CASE WHEN uid IS NULL THEN '{"role":"anon"}' ELSE json_build_object('sub',uid,'role','authenticated')::text END, false);
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.as_user(text) TO PUBLIC;

-- ============ A. privilèges de table ============
INSERT INTO r14 SELECT 'A: no '||p||' on '||t||' for '||r, NOT has_table_privilege(r,t,p), ''
 FROM unnest(ARRAY['public.lead_scores','public.contact_consents']) t,
      unnest(ARRAY['anon','authenticated','service_role']) r,
      unnest(ARRAY['TRUNCATE','TRIGGER','REFERENCES']) p;
INSERT INTO r14 SELECT 'A: no '||p||' on '||t||' for anon', NOT has_table_privilege('anon',t,p), ''
 FROM unnest(ARRAY['public.lead_scores','public.contact_consents']) t, unnest(ARRAY['INSERT','UPDATE','DELETE']) p;
INSERT INTO r14 SELECT 'A: legit privilege kept: '||r||' '||p||' on '||t, has_table_privilege(r,t,p), ''
 FROM (VALUES ('authenticated','public.lead_scores','SELECT'),('authenticated','public.lead_scores','INSERT'),
              ('authenticated','public.lead_scores','UPDATE'),('authenticated','public.lead_scores','DELETE'),
              ('authenticated','public.contact_consents','SELECT'),('authenticated','public.contact_consents','INSERT'),
              ('service_role','public.lead_scores','SELECT'),('service_role','public.lead_scores','INSERT'),
              ('service_role','public.lead_scores','UPDATE'),('service_role','public.lead_scores','DELETE'),
              ('service_role','public.contact_consents','SELECT'),('service_role','public.contact_consents','INSERT'),
              ('authenticated','public.contact_consent_current','SELECT'),('service_role','public.contact_consent_current','SELECT')) v(r,t,p);
INSERT INTO r14 SELECT 'A: contact_consents still has no UPDATE/DELETE for authenticated (900)',
 NOT has_table_privilege('authenticated','public.contact_consents','UPDATE') AND NOT has_table_privilege('authenticated','public.contact_consents','DELETE'), '';

SET ROLE authenticated; SELECT pg_temp.as_user('9a000000-0000-0000-0000-000000000001');
DO $$ BEGIN
 BEGIN TRUNCATE public.lead_scores; INSERT INTO r14 VALUES ('A: authenticated cannot TRUNCATE lead_scores', false, 'succeeded');
 EXCEPTION WHEN insufficient_privilege THEN INSERT INTO r14 VALUES ('A: authenticated cannot TRUNCATE lead_scores', true, SQLSTATE); END;
 BEGIN TRUNCATE public.contact_consents; INSERT INTO r14 VALUES ('A: authenticated cannot TRUNCATE contact_consents', false, 'succeeded');
 EXCEPTION WHEN insufficient_privilege THEN INSERT INTO r14 VALUES ('A: authenticated cannot TRUNCATE contact_consents', true, SQLSTATE); END;
 EXECUTE 'CREATE FUNCTION pg_temp.ol14_trg() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$';
 BEGIN EXECUTE 'CREATE TRIGGER ol14_trg BEFORE INSERT ON public.lead_scores FOR EACH ROW EXECUTE FUNCTION pg_temp.ol14_trg()';
   INSERT INTO r14 VALUES ('A: authenticated cannot CREATE TRIGGER on lead_scores', false, 'succeeded');
 EXCEPTION WHEN insufficient_privilege THEN INSERT INTO r14 VALUES ('A: authenticated cannot CREATE TRIGGER on lead_scores', true, SQLSTATE); END;
 BEGIN EXECUTE 'CREATE TRIGGER ol14_trg BEFORE INSERT ON public.contact_consents FOR EACH ROW EXECUTE FUNCTION pg_temp.ol14_trg()';
   INSERT INTO r14 VALUES ('A: authenticated cannot CREATE TRIGGER on contact_consents', false, 'succeeded');
 EXCEPTION WHEN insufficient_privilege THEN INSERT INTO r14 VALUES ('A: authenticated cannot CREATE TRIGGER on contact_consents', true, SQLSTATE); END;
END $$;
-- accès légitime et isolation : l'agent g2 met à jour le score de G, pas celui de H
SELECT pg_temp.as_user('9a000000-0000-0000-0000-000000000002');
DO $$ DECLARE n int; k record; BEGIN SELECT * INTO k FROM k14;
 UPDATE public.lead_scores SET score=35 WHERE contact_id=k.ctG; GET DIAGNOSTICS n=ROW_COUNT;
 INSERT INTO r14 VALUES ('A: agent G updates own-account lead score (legit)', n=1, n::text);
 UPDATE public.lead_scores SET score=0 WHERE account_id=k.accH; GET DIAGNOSTICS n=ROW_COUNT;
 INSERT INTO r14 VALUES ('A: agent G cannot update account-H lead scores', n=0, n::text);
 DELETE FROM public.lead_scores WHERE account_id=k.accH; GET DIAGNOSTICS n=ROW_COUNT;
 INSERT INTO r14 VALUES ('A: agent G cannot delete account-H lead scores', n=0, n::text);
 INSERT INTO r14 SELECT 'A: agent G sees only own-account lead scores', count(*)=1 AND bool_and(account_id=k.accG), count(*)::text FROM public.lead_scores;
END $$;
RESET ROLE;
SET ROLE service_role;
DO $$ BEGIN
 BEGIN TRUNCATE public.lead_scores; INSERT INTO r14 VALUES ('A: service_role cannot TRUNCATE lead_scores', false, 'succeeded');
 EXCEPTION WHEN insufficient_privilege THEN INSERT INTO r14 VALUES ('A: service_role cannot TRUNCATE lead_scores', true, SQLSTATE); END;
END $$;
RESET ROLE;
SET ROLE anon; SELECT pg_temp.as_user(NULL);
DO $$ DECLARE k record; BEGIN SELECT * INTO k FROM k14;
 BEGIN INSERT INTO public.lead_scores(account_id,contact_id,score,rules_version) VALUES (k.accG,k.ctG,1,'anon');
   INSERT INTO r14 VALUES ('A: anon cannot INSERT lead_scores (privilege, not only RLS)', false, 'succeeded');
 -- RLS refuse aussi en 42501 : seul « permission denied » prouve que le privilège est retiré
 EXCEPTION WHEN OTHERS THEN INSERT INTO r14 VALUES ('A: anon cannot INSERT lead_scores (privilege, not only RLS)', SQLSTATE='42501' AND SQLERRM LIKE 'permission denied%', SQLSTATE||' '||SQLERRM); END;
 INSERT INTO r14 SELECT 'A: anon reads 0 lead_scores (SELECT kept, RLS filters)', count(*)=0, count(*)::text FROM public.lead_scores;
END $$;
RESET ROLE;
INSERT INTO r14 SELECT 'A: lead_scores of both accounts intact', count(*)=2, count(*)::text FROM public.lead_scores WHERE rules_version='ol14';

-- ============ B. redeem_invitation ============
INSERT INTO r14 SELECT 'B: proconfig is exactly search_path=pg_catalog, pg_temp', proconfig = ARRAY['search_path=pg_catalog, pg_temp'], coalesce(array_to_string(proconfig,';'),'(none)')
 FROM pg_proc WHERE oid='public.redeem_invitation(text)'::regprocedure;
INSERT INTO r14 SELECT 'B: SECURITY DEFINER kept', prosecdef, '' FROM pg_proc WHERE oid='public.redeem_invitation(text)'::regprocedure;
INSERT INTO r14 SELECT 'B: no EXECUTE for PUBLIC', NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl, acldefault('f',proowner))) a WHERE a.grantee=0), coalesce(array_to_string(proacl,' '),'(null)')
 FROM pg_proc WHERE oid='public.redeem_invitation(text)'::regprocedure;
INSERT INTO r14 SELECT 'B: no EXECUTE for anon', NOT has_function_privilege('anon','public.redeem_invitation(text)','EXECUTE'), '';
INSERT INTO r14 SELECT 'B: EXECUTE kept for authenticated', has_function_privilege('authenticated','public.redeem_invitation(text)','EXECUTE'), '';
INSERT INTO r14 SELECT 'B: every table reference is schema-qualified',
 d !~* '(from|join|update|into)\s+(profiles|accounts|account_invitations|contacts|lead_scores|contact_consents)\M' AND d ~* 'public\.account_invitations%rowtype', ''
 FROM (SELECT pg_get_functiondef('public.redeem_invitation(text)'::regprocedure) d) f;
INSERT INTO r14 SELECT 'B: owner bypasses RLS (superuser or BYPASSRLS)', r.rolsuper OR r.rolbypassrls, r.rolname
 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.redeem_invitation(text)'::regprocedure;

SET ROLE authenticated;
-- résolution des noms : une table temporaire account_invitations fabriquée (compte G, rôle owner) doit être ignorée
SELECT pg_temp.as_user('9c000000-0000-0000-0000-000000000001');
DO $$ DECLARE r uuid; BEGIN
 CREATE TEMP TABLE account_invitations (LIKE public.account_invitations INCLUDING DEFAULTS);
 INSERT INTO pg_temp.account_invitations(account_id,role,token_hash,expires_at) SELECT accG,'owner','ol14-forged',now()+interval '1 day' FROM k14;
 BEGIN r := public.redeem_invitation('ol14-forged'); INSERT INTO r14 VALUES ('B: forged pg_temp.account_invitations is ignored', false, 'joined '||r);
 EXCEPTION WHEN OTHERS THEN INSERT INTO r14 VALUES ('B: forged pg_temp.account_invitations is ignored', SQLSTATE='22023' AND SQLERRM='Invitation not found', SQLSTATE||' '||SQLERRM); END;
 DROP TABLE pg_temp.account_invitations;
END $$;
RESET ROLE;
INSERT INTO r14 SELECT 'B: i1 still alone in own account after forged attempt', account_id=(SELECT accI1 FROM k14) AND account_role='owner', account_role::text FROM public.profiles WHERE user_id='9c000000-0000-0000-0000-000000000001';

CREATE OR REPLACE FUNCTION pg_temp.try_redeem(uid text, tok text, label text, want text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r uuid; BEGIN
 PERFORM pg_temp.as_user(uid);
 BEGIN r := public.redeem_invitation(tok); INSERT INTO pg_temp.r14 VALUES (label, want='OK', 'returned '||r);
 EXCEPTION WHEN OTHERS THEN INSERT INTO pg_temp.r14 VALUES (label, want<>'OK' AND SQLSTATE||' '||SQLERRM LIKE want, SQLSTATE||' '||SQLERRM); END;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.try_redeem(text,text,text,text) TO PUBLIC;

SET ROLE authenticated;
SELECT pg_temp.try_redeem('9c000000-0000-0000-0000-000000000001','ol14-unknown','B: unknown token refused','22023 Invitation not found');
SELECT pg_temp.try_redeem('9c000000-0000-0000-0000-000000000001','ol14-expired','B: expired invitation refused','22023 Invitation has expired');
SELECT pg_temp.try_redeem('9a000000-0000-0000-0000-000000000002','ol14-for-member','B: already a member refused','23505 You are already a member%');
SELECT pg_temp.try_redeem('9c000000-0000-0000-0000-000000000003','ol14-for-data','B: caller whose account holds data refused','23505 Your account already contains data%');
SELECT pg_temp.try_redeem('9c000000-0000-0000-0000-000000000001','ol14-valid','B: valid invitation redeemed','OK');
SELECT pg_temp.try_redeem('9c000000-0000-0000-0000-000000000002','ol14-valid','B: already-used invitation refused','22023 Invitation has already been redeemed');
RESET ROLE;
SET ROLE anon; SELECT pg_temp.as_user(NULL);
DO $$ DECLARE r uuid; BEGIN
 BEGIN r := public.redeem_invitation('ol14-for-data'); INSERT INTO r14 VALUES ('B: anon cannot call redeem_invitation (privilege, not only Unauthorized)', false, 'returned');
 -- « Unauthorized » est aussi 42501 : seul « permission denied » prouve que EXECUTE est retiré
 EXCEPTION WHEN OTHERS THEN INSERT INTO r14 VALUES ('B: anon cannot call redeem_invitation (privilege, not only Unauthorized)', SQLSTATE='42501' AND SQLERRM LIKE 'permission denied%', SQLSTATE||' '||SQLERRM); END;
END $$;
RESET ROLE;
INSERT INTO r14 SELECT 'B: valid redeem moved i1 into G as agent', account_id=(SELECT accG FROM k14) AND account_role='agent', account_role::text FROM public.profiles WHERE user_id='9c000000-0000-0000-0000-000000000001';
INSERT INTO r14 SELECT 'B: valid redeem marked the invitation accepted by i1', accepted_at IS NOT NULL AND accepted_by_user_id='9c000000-0000-0000-0000-000000000001', '' FROM public.account_invitations WHERE token_hash='ol14-valid';
INSERT INTO r14 SELECT 'B: valid redeem deleted i1''s empty old account', NOT EXISTS (SELECT 1 FROM public.accounts WHERE id=(SELECT accI1 FROM k14)), '';
INSERT INTO r14 SELECT 'B: refused redeem left j1, its data and the invitation untouched',
 (SELECT account_id FROM public.profiles WHERE user_id='9c000000-0000-0000-0000-000000000003')=(SELECT accJ1 FROM k14)
 AND EXISTS (SELECT 1 FROM public.contacts WHERE id=(SELECT ctJ FROM k14))
 AND (SELECT accepted_at FROM public.account_invitations WHERE token_hash='ol14-for-data') IS NULL, '';
INSERT INTO r14 SELECT 'B: i2 (refused, already used) still in own account', account_role='owner' AND account_id<>(SELECT accG FROM k14), '' FROM public.profiles WHERE user_id='9c000000-0000-0000-0000-000000000002';

-- ============ C. ordre des consentements, STOP ============
INSERT INTO r14 SELECT 'C: unique index on contact_consents(seq)', count(*)=1, string_agg(c.relname,',')
 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
 WHERE i.indrelid='public.contact_consents'::regclass AND i.indisunique AND i.indnkeyatts=1
   AND i.indkey[0]=(SELECT attnum FROM pg_attribute WHERE attrelid='public.contact_consents'::regclass AND attname='seq');
INSERT INTO r14 SELECT 'C: no duplicate seq in contact_consents', count(*)=0, count(*)::text FROM (SELECT seq FROM public.contact_consents GROUP BY seq HAVING count(*)>1) d;
-- Keep this regression label stable for the 904 mutation harness. After 906,
-- the protected decision_order supersedes seq; restoring either old view fails.
INSERT INTO r14 SELECT 'C: contact_consent_current orders by seq only',
 CASE WHEN EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.contact_consents'::regclass AND attname='decision_order' AND NOT attisdropped)
   THEN v ~ 'ORDER BY .*purpose, decision_order DESC;?\s*$'
   ELSE v ~ 'ORDER BY .*purpose, seq DESC;?\s*$' END
 AND v !~ 'ORDER BY .*recorded_at', substring(v from 'ORDER BY.*$')
 FROM (SELECT pg_get_viewdef('public.contact_consent_current'::regclass) v) x;
INSERT INTO r14 SELECT 'C: contact_consent_current is security_invoker', coalesce(bool_or(o='security_invoker=true'),false), '' FROM pg_class c, unnest(coalesce(c.reloptions,'{}')) o WHERE c.oid='public.contact_consent_current'::regclass;
INSERT INTO r14 SELECT 'C: anon has no SELECT on contact_consent_current', NOT has_table_privilege('anon','public.contact_consent_current','SELECT'), '';
INSERT INTO r14 SELECT 'C: oralink_consent_guard search_path is pg_catalog, pg_temp', proconfig = ARRAY['search_path=pg_catalog, pg_temp'], coalesce(array_to_string(proconfig,';'),'(none)')
 FROM pg_proc WHERE oid='public.oralink_consent_guard()'::regprocedure;
INSERT INTO r14 SELECT 'C: oralink_consent_guard not executable by anon/authenticated', NOT has_function_privilege('anon','public.oralink_consent_guard()','EXECUTE') AND NOT has_function_privilege('authenticated','public.oralink_consent_guard()','EXECUTE'), '';

SET ROLE authenticated; SELECT pg_temp.as_user('9a000000-0000-0000-0000-000000000002');
DO $$ DECLARE k record; s1 bigint; s2 bigint; t1 timestamptz; t2 timestamptz; mx bigint; BEGIN SELECT * INTO k FROM k14;
 -- seq imposé égal à une valeur existante : écarté, nouvelle valeur unique
 SELECT max(seq) INTO mx FROM public.contact_consents;
 BEGIN
  INSERT INTO public.contact_consents(seq,account_id,contact_id,purpose,status,source,recorded_by) OVERRIDING SYSTEM VALUE
   VALUES (mx,k.accG,k.ctG,'service','granted','manual','9a000000-0000-0000-0000-000000000002') RETURNING seq INTO s1;
  INSERT INTO r14 VALUES ('C: caller-supplied seq (OVERRIDING SYSTEM VALUE) is replaced', s1<>mx, 'forced '||mx||' got '||s1);
 EXCEPTION WHEN OTHERS THEN INSERT INTO r14 VALUES ('C: caller-supplied seq (OVERRIDING SYSTEM VALUE) is replaced', false, SQLSTATE||' '||SQLERRM); END;
 -- même transaction : opt-in avec seq énorme imposé, puis STOP -> la révocation gagne
 BEGIN
  INSERT INTO public.contact_consents(seq,account_id,contact_id,purpose,status,source,recorded_by) OVERRIDING SYSTEM VALUE
   VALUES (9000000000000000000,k.accG,k.ctG,'marketing','granted','manual','9a000000-0000-0000-0000-000000000002') RETURNING seq, recorded_at INTO s1, t1;
  INSERT INTO public.contact_consents(account_id,contact_id,purpose,status,source,recorded_by)
   VALUES (k.accG,k.ctG,'marketing','revoked','inbound','9a000000-0000-0000-0000-000000000002') RETURNING seq, recorded_at INTO s2, t2;
  INSERT INTO r14 VALUES ('C: within one transaction seq and recorded_at both increase', s2>s1 AND t2>t1, s1||'<'||s2);
 EXCEPTION WHEN OTHERS THEN INSERT INTO r14 VALUES ('C: within one transaction seq and recorded_at both increase', false, SQLSTATE||' '||SQLERRM); END;
END $$;
INSERT INTO r14 SELECT 'C: STOP after a forged-high-seq opt-in stays revoked', status='revoked', status FROM public.contact_consent_current WHERE contact_id=(SELECT ctG FROM k14) AND purpose='marketing';
-- START après STOP dans la même transaction : la décision la plus récente (granted) gagne, contrat de 900 inchangé
DO $$ DECLARE k record; BEGIN SELECT * INTO k FROM k14;
 INSERT INTO public.contact_consents(account_id,contact_id,purpose,status,source,recorded_by) VALUES
  (k.accG,k.ctG,'service','revoked','inbound','9a000000-0000-0000-0000-000000000002'),
  (k.accG,k.ctG,'service','granted','inbound','9a000000-0000-0000-0000-000000000002');
END $$;
INSERT INTO r14 SELECT 'C: START after STOP in one batch -> granted (latest wins)', status='granted', status FROM public.contact_consent_current WHERE contact_id=(SELECT ctG FROM k14) AND purpose='service';
-- isolation : le STOP de G ne touche pas le contact de H (même numéro), et G ne voit rien de H
INSERT INTO r14 SELECT 'C: G sees no account-H row in contact_consent_current', count(*)=0, count(*)::text FROM public.contact_consent_current WHERE account_id=(SELECT accH FROM k14);
DO $$ DECLARE k record; ok boolean; BEGIN SELECT * INTO k FROM k14;
 BEGIN INSERT INTO public.contact_consents(account_id,contact_id,purpose,status,source,recorded_by) VALUES (k.accH,k.ctH,'marketing','revoked','manual','9a000000-0000-0000-0000-000000000002'); ok:=false;
 EXCEPTION WHEN insufficient_privilege THEN ok:=true; END;
 INSERT INTO r14 VALUES ('C: agent G cannot record a STOP for an account-H contact', ok, '');
END $$;
RESET ROLE;
INSERT INTO r14 SELECT 'C: account-H marketing consent still granted', status='granted', status FROM public.contact_consent_current WHERE contact_id=(SELECT ctH FROM k14) AND purpose='marketing';
INSERT INTO r14 SELECT 'C: no duplicate seq after the scenarios', count(*)=0, count(*)::text FROM (SELECT seq FROM public.contact_consents GROUP BY seq HAVING count(*)>1) d;
INSERT INTO r14 SELECT 'C: back-dated recorded_at still ignored (server time)', bool_and(recorded_at > now() - interval '1 hour'), '' FROM public.contact_consents WHERE contact_id=(SELECT ctG FROM k14);

SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, test, info FROM r14 ORDER BY ok, test;
SELECT 'SUMMARY pass=' || count(*) FILTER (WHERE ok) || ' fail=' || count(*) FILTER (WHERE ok IS NOT TRUE) FROM r14;

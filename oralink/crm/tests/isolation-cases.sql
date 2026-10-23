-- OraLink CRM MÉTIER — cas d'isolation pour les tables 900/901 (9NN_oralink_*)
-- (contact_consents, contact_consent_current, lead_scores).
--
-- À intégrer par QUALITÉ dans supabase/tests (ce fichier ne modifie rien de supabase/tests).
-- Autonome : crée ses propres utilisateurs (préfixes c0…/d0…) et ses propres données,
-- distincts de ceux de supabase/tests/isolation.sql (a0…/b0…), donc exécutable avant ou après.
-- Sortie au même format : lignes « PASS | … » / « FAIL | … » puis « SUMMARY pass=<n> fail=<n> ».
--
-- Exécuter UNIQUEMENT sur une base jetable où les migrations amont puis 900_oralink_* et 901_oralink_* ont été appliquées
-- (voir oralink/crm/tests/run-isolation-cases.sh). Tout est fictif (@test.local, +155555501xx).
\set ON_ERROR_STOP off
SET client_min_messages = warning;
CREATE TEMP TABLE ores(test text, ok boolean, info text);
GRANT ALL ON ores TO PUBLIC;

INSERT INTO auth.users(id,email) VALUES
 ('c0000000-0000-0000-0000-000000000001','c1@test.local'),
 ('c0000000-0000-0000-0000-000000000002','c2@test.local'),
 ('c0000000-0000-0000-0000-000000000003','c3@test.local'),
 ('d0000000-0000-0000-0000-000000000001','d1@test.local');
-- c2 = agent, c3 = viewer of account C (the signup trigger gave each its own account first).
UPDATE public.profiles SET account_id=(SELECT account_id FROM public.profiles WHERE user_id='c0000000-0000-0000-0000-000000000001'), account_role='agent'
 WHERE user_id='c0000000-0000-0000-0000-000000000002';
UPDATE public.profiles SET account_id=(SELECT account_id FROM public.profiles WHERE user_id='c0000000-0000-0000-0000-000000000001'), account_role='viewer'
 WHERE user_id='c0000000-0000-0000-0000-000000000003';
DELETE FROM public.accounts WHERE owner_user_id IN ('c0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000003');

CREATE TEMP TABLE oids AS SELECT
 (SELECT account_id FROM public.profiles WHERE user_id='c0000000-0000-0000-0000-000000000001') accC,
 (SELECT account_id FROM public.profiles WHERE user_id='d0000000-0000-0000-0000-000000000001') accD,
 NULL::uuid ctC, NULL::uuid ctC2, NULL::uuid ctD;
GRANT SELECT ON oids TO PUBLIC;

DO $$ DECLARE c uuid; d uuid; uc uuid:='c0000000-0000-0000-0000-000000000001'; ud uuid:='d0000000-0000-0000-0000-000000000001'; xc uuid; xc2 uuid; xd uuid;
BEGIN
 SELECT accC, accD INTO c, d FROM oids;
 INSERT INTO contacts(user_id,phone,account_id,name) VALUES (uc,'+15555550190',c,'Lead C') RETURNING id INTO xc;
 INSERT INTO contacts(user_id,phone,account_id,name) VALUES (uc,'+15555550191',c,'Lead C2') RETURNING id INTO xc2;
 INSERT INTO contacts(user_id,phone,account_id,name) VALUES (ud,'+15555550190',d,'Lead D') RETURNING id INTO xd; -- même numéro, autre compte
 UPDATE oids SET ctC=xc, ctC2=xc2, ctD=xd;
 INSERT INTO contact_consents(account_id,contact_id,purpose,status,source,evidence) VALUES
  (c,xc,'service','granted','OL-TZ-BF1','wamid.TEST-C'),
  (c,xc2,'service','granted','inbound','wamid.TEST-C2'),
  (d,xd,'service','granted','OL-IM-BF1','wamid.TEST-D');
 INSERT INTO lead_scores(account_id,contact_id,score,reasons,rules_version) VALUES
  (c,xc,40,'[{"rule":"r1","points":40,"valeur":"x"}]','test-1'),
  (d,xd,70,'[{"rule":"r1","points":70,"valeur":"y"}]','test-1');
END $$;

INSERT INTO ores SELECT 'SEED control contact_consents rows (superuser)', count(*)=3, count(*)::text FROM contact_consents WHERE evidence LIKE 'wamid.TEST-%';
INSERT INTO ores SELECT 'SEED control lead_scores rows (superuser)', count(*)=2, count(*)::text FROM lead_scores WHERE rules_version='test-1';

CREATE OR REPLACE FUNCTION pg_temp.as_user(uid uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('request.jwt.claim.sub', uid::text, false); PERFORM set_config('request.jwt.claim.role','authenticated',false); END $$;

-- ---------- lecture ----------
SET ROLE authenticated; SELECT pg_temp.as_user('c0000000-0000-0000-0000-000000000001');
INSERT INTO ores SELECT 'C1 sees own-account consents', count(*)=2, count(*)::text FROM contact_consents WHERE account_id=(SELECT accC FROM oids);
INSERT INTO ores SELECT 'C1 sees NO account-D consents', count(*)=0, count(*)::text FROM contact_consents WHERE account_id=(SELECT accD FROM oids) OR evidence='wamid.TEST-D';
INSERT INTO ores SELECT 'C1 sees NO account-D row in contact_consent_current', count(*)=0, count(*)::text FROM contact_consent_current WHERE account_id=(SELECT accD FROM oids);
INSERT INTO ores SELECT 'C1 sees own row in contact_consent_current', count(*)=1, count(*)::text FROM contact_consent_current WHERE contact_id=(SELECT ctC FROM oids);
INSERT INTO ores SELECT 'C1 sees NO account-D lead_scores', count(*)=0, count(*)::text FROM lead_scores WHERE account_id=(SELECT accD FROM oids) OR score=70;
INSERT INTO ores SELECT 'C1 sees own lead_scores', count(*)=1, count(*)::text FROM lead_scores;
SELECT pg_temp.as_user('c0000000-0000-0000-0000-000000000003');
INSERT INTO ores SELECT 'C3 (viewer) reads own-account consents', count(*)=2, count(*)::text FROM contact_consents;

-- ---------- écriture : contact_consents ----------
SELECT pg_temp.as_user('c0000000-0000-0000-0000-000000000001');
DO $$ DECLARE n int; ok boolean; o record; BEGIN
 SELECT * INTO o FROM oids;
 BEGIN INSERT INTO contact_consents(account_id,contact_id,purpose,status,source,recorded_by) VALUES (o.accD,o.ctD,'marketing','revoked','manual','c0000000-0000-0000-0000-000000000001'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('C1 cannot INSERT consent into account D', ok, '');
 BEGIN INSERT INTO contact_consents(account_id,contact_id,purpose,status,source,recorded_by) VALUES (o.accC,o.ctD,'marketing','revoked','manual','c0000000-0000-0000-0000-000000000001'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('C1 cannot INSERT consent in C pointing at a D contact', ok, '');
 BEGIN UPDATE contact_consents SET status='revoked' WHERE account_id=o.accD; GET DIAGNOSTICS n=ROW_COUNT; ok:=(n=0); EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('C1 cannot UPDATE D consents', ok, '');
 BEGIN DELETE FROM contact_consents WHERE account_id=o.accD; GET DIAGNOSTICS n=ROW_COUNT; ok:=(n=0); EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('C1 cannot DELETE D consents', ok, '');
 -- journal en ajout seul, même pour le propriétaire du compte
 BEGIN UPDATE contact_consents SET status='revoked' WHERE account_id=o.accC; GET DIAGNOSTICS n=ROW_COUNT; ok:=(n=0); EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('owner C1 cannot UPDATE own-account consents (append-only)', ok, '');
 BEGIN DELETE FROM contact_consents WHERE account_id=o.accC; GET DIAGNOSTICS n=ROW_COUNT; ok:=(n=0); EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('owner C1 cannot DELETE own-account consents (append-only)', ok, '');
 BEGIN INSERT INTO contact_consents(account_id,contact_id,purpose,status,source,recorded_by) VALUES (o.accC,o.ctC,'marketing','revoked','manual','c0000000-0000-0000-0000-000000000002'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('C1 cannot INSERT consent impersonating recorded_by=C2', ok, '');
END $$;
SELECT pg_temp.as_user('c0000000-0000-0000-0000-000000000002');
DO $$ DECLARE ok boolean; o record; ts timestamptz; BEGIN
 SELECT * INTO o FROM oids;
 BEGIN INSERT INTO contact_consents(account_id,contact_id,purpose,status,source,evidence,recorded_by,recorded_at) VALUES (o.accC,o.ctC,'marketing','revoked','manual','test-backdate','c0000000-0000-0000-0000-000000000002','2000-01-01') RETURNING recorded_at INTO ts; ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; ts:=NULL; END;
 INSERT INTO ores VALUES ('C2 (agent) can INSERT consent for own-account contact', ok, '');
 INSERT INTO ores VALUES ('recorded_at is server time (back-dating ignored)', ts IS NOT NULL AND ts > '2020-01-01', coalesce(ts::text,'null'));
END $$;
SELECT pg_temp.as_user('c0000000-0000-0000-0000-000000000003');
DO $$ DECLARE ok boolean; o record; BEGIN
 SELECT * INTO o FROM oids;
 BEGIN INSERT INTO contact_consents(account_id,contact_id,purpose,status,source,recorded_by) VALUES (o.accC,o.ctC,'marketing','granted','manual','c0000000-0000-0000-0000-000000000003'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('C3 (viewer) cannot INSERT consent', ok, '');
END $$;
SELECT pg_temp.as_user('c0000000-0000-0000-0000-000000000001');
INSERT INTO ores SELECT 'current state = latest event (marketing revoked for ctC)', count(*)=1, string_agg(status,',') FROM contact_consent_current WHERE contact_id=(SELECT ctC FROM oids) AND purpose='marketing' AND status='revoked';

-- ---------- écriture : lead_scores ----------
DO $$ DECLARE n int; ok boolean; o record; BEGIN
 SELECT * INTO o FROM oids;
 BEGIN INSERT INTO lead_scores(account_id,contact_id,score,rules_version) VALUES (o.accD,o.ctD,99,'x'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('C1 cannot INSERT lead_score into account D', ok, '');
 BEGIN INSERT INTO lead_scores(account_id,contact_id,score,rules_version) VALUES (o.accC,o.ctC2,10,'x'); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END;
 INSERT INTO ores VALUES ('C1 can INSERT lead_score for own contact', ok, '');
 BEGIN INSERT INTO lead_scores(account_id,contact_id,score,rules_version) VALUES (o.accC,o.ctD,99,'x'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('C1 cannot INSERT lead_score in C pointing at a D contact', ok, '');
 BEGIN UPDATE lead_scores SET contact_id=o.ctD WHERE contact_id=o.ctC; ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('C1 cannot re-point own lead_score at a D contact', ok, '');
 BEGIN UPDATE lead_scores SET account_id=o.accD WHERE contact_id=o.ctC; GET DIAGNOSTICS n=ROW_COUNT; ok:=(n=0); EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('C1 cannot move own lead_score into account D', ok, '');
 UPDATE lead_scores SET score=0 WHERE account_id=o.accD; GET DIAGNOSTICS n=ROW_COUNT; INSERT INTO ores VALUES ('C1 cannot UPDATE D lead_scores', n=0, n::text);
 DELETE FROM lead_scores WHERE account_id=o.accD; GET DIAGNOSTICS n=ROW_COUNT; INSERT INTO ores VALUES ('C1 cannot DELETE D lead_scores', n=0, n::text);
 BEGIN INSERT INTO lead_scores(account_id,contact_id,score,rules_version) VALUES (o.accC,o.ctC2,101,'x') ON CONFLICT (contact_id) DO UPDATE SET score=EXCLUDED.score; ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('lead_score > 100 rejected', ok, '');
END $$;
SELECT pg_temp.as_user('c0000000-0000-0000-0000-000000000003');
DO $$ DECLARE n int; ok boolean; BEGIN
 BEGIN UPDATE lead_scores SET score=1 WHERE true; GET DIAGNOSTICS n=ROW_COUNT; ok:=(n=0); EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('C3 (viewer) cannot UPDATE lead_scores', ok, '');
END $$;

-- ---------- anon ----------
RESET ROLE; SET ROLE anon; SELECT set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claim.role','anon',false);
DO $$ DECLARE n int; ok boolean; BEGIN
 BEGIN SELECT count(*) INTO n FROM contact_consents; ok:=(n=0); EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('anon reads 0 contact_consents', ok, '');
 BEGIN SELECT count(*) INTO n FROM contact_consent_current; ok:=(n=0); EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('anon reads 0 contact_consent_current', ok, '');
 BEGIN SELECT count(*) INTO n FROM lead_scores; ok:=(n=0); EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('anon reads 0 lead_scores', ok, '');
 BEGIN INSERT INTO contact_consents(account_id,contact_id,purpose,status,source) SELECT accC,ctC,'service','granted','inbound' FROM oids; ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('anon cannot INSERT consent', ok, '');
END $$;
RESET ROLE;

-- ---------- privilégié (service_role / superuser) ----------
DO $$ DECLARE ok boolean; o record; n int; BEGIN
 SELECT * INTO o FROM oids;
 BEGIN UPDATE contact_consents SET status='revoked' WHERE evidence='wamid.TEST-D'; ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('append-only even for superuser (UPDATE refused by trigger)', ok, '');
 BEGIN INSERT INTO contact_consents(account_id,contact_id,purpose,status,source) VALUES (o.accC,o.ctD,'service','revoked','inbound'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('service path: consent with contact of another account refused', ok, '');
 BEGIN INSERT INTO lead_scores(account_id,contact_id,score,rules_version) VALUES (o.accD,o.ctC,1,'x'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('service path: lead_score with contact of another account refused', ok, '');
 BEGIN INSERT INTO contact_consents(account_id,contact_id,purpose,status,source) VALUES (o.accC,o.ctC,'service','granted','QR-CODE-LIBRE'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('source outside inbound/manual/import/OL-… refused', ok, '');
END $$;
-- effacement d'un contact (loi 09-08) : ses événements partent avec lui, par l'utilisateur C1
SET ROLE authenticated; SELECT pg_temp.as_user('c0000000-0000-0000-0000-000000000001');
DELETE FROM contacts WHERE id=(SELECT ctC2 FROM oids);
RESET ROLE;
INSERT INTO ores SELECT 'deleting a contact cascades its consents and score', (SELECT count(*) FROM contact_consents WHERE contact_id=o.ctC2)=0 AND (SELECT count(*) FROM lead_scores WHERE contact_id=o.ctC2)=0 AND (SELECT count(*) FROM contacts WHERE id=o.ctC2)=0, '' FROM oids o;

-- recorded_by ON DELETE SET NULL : la seule mise à jour tolérée par le journal.
DO $$ DECLARE ok boolean; BEGIN
 -- un UPDATE qui annule recorded_by ET change autre chose reste refusé
 BEGIN UPDATE contact_consents SET recorded_by=NULL, status='granted' WHERE evidence='test-backdate'; ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO ores VALUES ('append-only: nulling recorded_by together with another column refused', ok, '');
 -- supprimer l'utilisateur auteur (C2) doit réussir et conserver l'événement, recorded_by à NULL
 BEGIN DELETE FROM auth.users WHERE id='c0000000-0000-0000-0000-000000000002'; ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; RAISE WARNING 'delete user: %', SQLERRM; END;
 INSERT INTO ores VALUES ('deleting the auth user who recorded a consent succeeds', ok, '');
 INSERT INTO ores SELECT 'consent kept with recorded_by NULL after its author is deleted', count(*)=1, count(*)::text FROM contact_consents WHERE evidence='test-backdate' AND recorded_by IS NULL AND status='revoked';
END $$;

-- ---------- structure ----------
INSERT INTO ores SELECT 'redeem_invitation data check covers contact_consents and lead_scores (902)',
  d ~ 'FROM contact_consents WHERE account_id = v_old_account_id' AND d ~ 'FROM lead_scores WHERE account_id = v_old_account_id', ''
 FROM (SELECT pg_get_functiondef('public.redeem_invitation(text)'::regprocedure) d) f;
INSERT INTO ores SELECT 'index on contact_consents(contact_id) for erasure cascade', count(*)=1, string_agg(indexname,',') FROM pg_indexes WHERE schemaname='public' AND tablename='contact_consents' AND indexdef ~ '\(contact_id\)$';
INSERT INTO ores SELECT 'RLS enabled on contact_consents and lead_scores', count(*)=2, string_agg(relname,',') FROM pg_class WHERE oid IN ('public.contact_consents'::regclass,'public.lead_scores'::regclass) AND relrowsecurity;
INSERT INTO ores SELECT 'no UPDATE/DELETE policy on contact_consents', count(*)=0, string_agg(policyname,',') FROM pg_policies WHERE schemaname='public' AND tablename='contact_consents' AND cmd IN ('UPDATE','DELETE','ALL');
INSERT INTO ores SELECT 'contact_consent_current is security_invoker', coalesce(bool_or(o = 'security_invoker=true'),false), coalesce(string_agg(o,','),'') FROM pg_class c, unnest(coalesce(c.reloptions,'{}')) o WHERE c.oid='public.contact_consent_current'::regclass;
INSERT INTO ores SELECT 'EXECUTE revoked from anon/authenticated: '||p.oid::regprocedure::text,
  NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE'), ''
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('oralink_consent_guard','oralink_lead_score_guard');
INSERT INTO ores SELECT 'oralink SECURITY DEFINER funcs have fixed search_path', count(*)=0, string_agg(p.proname,',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'oralink_%' AND p.prosecdef AND (p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));

SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END r, test, info FROM ores ORDER BY ok, test;
SELECT 'SUMMARY pass=' || count(*) FILTER (WHERE ok) || ' fail=' || count(*) FILTER (WHERE NOT ok) FROM ores;

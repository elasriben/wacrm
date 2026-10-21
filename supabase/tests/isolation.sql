-- Suite d'isolation entre deux comptes (OraLink) — 71 contrôles au 34bce1a.
--
-- Exécuter UNIQUEMENT sur une base jetable (voir supabase/tests/README.md et run.sh).
-- Le script crée des utilisateurs et des données de test, puis rejoue des
-- requêtes sous les rôles `authenticated` et `anon` avec de faux JWT.
--
-- Chaque ligne du résultat est PASS ou FAIL. Les contrôles « SEED control »
-- prouvent que les données de test existent réellement : sans eux, un test
-- du type « A ne voit rien du compte B » pourrait réussir sur une base vide.
-- Aucun secret réel : tout est fictif (@test.local, +2126000000xx, tokA/tokB).
\set ON_ERROR_STOP off
SET client_min_messages = warning;
CREATE TEMP TABLE res(test text, ok boolean, info text);
GRANT ALL ON res TO PUBLIC;
-- users (trigger creates account+profile owner)
INSERT INTO auth.users(id,email) VALUES
 ('a0000000-0000-0000-0000-000000000001','a1@test.local'),
 ('a0000000-0000-0000-0000-000000000002','a2@test.local'),
 ('b0000000-0000-0000-0000-000000000001','b1@test.local');
-- A2 joins account A as agent
UPDATE public.profiles SET account_id=(SELECT account_id FROM public.profiles WHERE user_id='a0000000-0000-0000-0000-000000000001'), account_role='agent' WHERE user_id='a0000000-0000-0000-0000-000000000002';
DELETE FROM public.accounts WHERE owner_user_id='a0000000-0000-0000-0000-000000000002' AND id<>(SELECT account_id FROM public.profiles WHERE user_id='a0000000-0000-0000-0000-000000000002');
CREATE TEMP TABLE ids AS SELECT
 (SELECT account_id FROM public.profiles WHERE user_id='a0000000-0000-0000-0000-000000000001') accA,
 (SELECT account_id FROM public.profiles WHERE user_id='b0000000-0000-0000-0000-000000000001') accB;
GRANT SELECT ON ids TO PUBLIC;
-- seed (superuser)
DO $$ DECLARE a uuid; b uuid; ua uuid:='a0000000-0000-0000-0000-000000000001'; ub uuid:='b0000000-0000-0000-0000-000000000001'; ca uuid; cb uuid; va uuid; vb uuid; pa uuid; pb uuid; sa uuid; sb uuid;
BEGIN
 SELECT accA,accB INTO a,b FROM ids;
 INSERT INTO contacts(user_id,phone,account_id,name) VALUES (ua,'+212600000001',a,'Lead A') RETURNING id INTO ca;
 INSERT INTO contacts(user_id,phone,account_id,name) VALUES (ub,'+212600000001',b,'Lead B') RETURNING id INTO cb; -- same phone, other account
 INSERT INTO conversations(user_id,contact_id,account_id) VALUES (ua,ca,a) RETURNING id INTO va;
 INSERT INTO conversations(user_id,contact_id,account_id) VALUES (ub,cb,b) RETURNING id INTO vb;
 INSERT INTO messages(conversation_id,sender_type,content_text) VALUES (va,'customer','secret A'),(vb,'customer','secret B');
 INSERT INTO tags(user_id,name,account_id) VALUES (ua,'tagA',a),(ub,'tagB',b);
 INSERT INTO pipelines(user_id,name,account_id) VALUES (ua,'pipeA',a) RETURNING id INTO pa;
 INSERT INTO pipelines(user_id,name,account_id) VALUES (ub,'pipeB',b) RETURNING id INTO pb;
 INSERT INTO pipeline_stages(pipeline_id,name) VALUES (pa,'sA') RETURNING id INTO sa;
 INSERT INTO pipeline_stages(pipeline_id,name) VALUES (pb,'sB') RETURNING id INTO sb;
 INSERT INTO deals(user_id,pipeline_id,stage_id,title,account_id) VALUES (ua,pa,sa,'dealA',a),(ub,pb,sb,'dealB',b);
 INSERT INTO automations(user_id,name,trigger_type,account_id) VALUES (ua,'autoA','new_contact',a),(ub,'autoB','new_contact',b);
 INSERT INTO flows(user_id,name,trigger_type,account_id) VALUES (ua,'flowA','keyword',a),(ub,'flowB','keyword',b);
 INSERT INTO whatsapp_config(user_id,phone_number_id,access_token,account_id) VALUES (ua,'PNID_A','tokA',a),(ub,'PNID_B','tokB',b);
 INSERT INTO message_templates(user_id,name,body_text,account_id) VALUES (ua,'tplA','x',a),(ub,'tplB','x',b);
 INSERT INTO contact_notes(contact_id,user_id,note_text,account_id) VALUES (ca,ua,'noteA',a),(cb,ub,'noteB',b);
 INSERT INTO custom_fields(user_id,field_name,account_id) VALUES (ua,'fA',a),(ub,'fB',b);
 INSERT INTO webhook_endpoints(account_id,url,secret) VALUES (a,'https://example.com/a','s'),(b,'https://example.com/b','s');
 INSERT INTO storage.objects(bucket_id,name) VALUES ('chat-media','account-'||a||'/img.png'),('chat-media','account-'||b||'/img.png'),('flow-media','account-'||a||'/f.png'),('flow-media','account-'||b||'/f.png');
END $$;
INSERT INTO res SELECT 'SEED control (superuser sees both accounts rows) '||t, c=2, c::text FROM (
 SELECT 'contacts' t,(SELECT count(*) FROM contacts) c UNION ALL SELECT 'conversations',(SELECT count(*) FROM conversations) UNION ALL
 SELECT 'messages',(SELECT count(*) FROM messages WHERE content_text LIKE 'secret%') UNION ALL SELECT 'tags',(SELECT count(*) FROM tags) UNION ALL
 SELECT 'pipelines',(SELECT count(*) FROM pipelines) UNION ALL SELECT 'pipeline_stages',(SELECT count(*) FROM pipeline_stages) UNION ALL
 SELECT 'deals',(SELECT count(*) FROM deals) UNION ALL SELECT 'automations',(SELECT count(*) FROM automations) UNION ALL SELECT 'flows',(SELECT count(*) FROM flows) UNION ALL
 SELECT 'whatsapp_config',(SELECT count(*) FROM whatsapp_config) UNION ALL SELECT 'message_templates',(SELECT count(*) FROM message_templates) UNION ALL
 SELECT 'contact_notes',(SELECT count(*) FROM contact_notes) UNION ALL SELECT 'custom_fields',(SELECT count(*) FROM custom_fields) UNION ALL
 SELECT 'webhook_endpoints',(SELECT count(*) FROM webhook_endpoints)) q;
INSERT INTO res SELECT 'SEED control storage objects', count(*)=4, count(*)::text FROM storage.objects;
-- helper: run as user
CREATE OR REPLACE FUNCTION pg_temp.as_user(uid uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('request.jwt.claim.sub', uid::text, false); PERFORM set_config('request.jwt.claim.role','authenticated',false); END $$;

-- READ isolation, user A1 vs account B rows
SET ROLE authenticated; SELECT pg_temp.as_user('a0000000-0000-0000-0000-000000000001');
INSERT INTO res SELECT 'A1 sees own contacts', count(*)=1, count(*)::text FROM contacts;
INSERT INTO res SELECT 'A1 sees NO account-B '||t, c=0, c::text FROM (
 SELECT 'contacts' t,(SELECT count(*) FROM contacts WHERE account_id=(SELECT accB FROM ids)) c UNION ALL
 SELECT 'conversations',(SELECT count(*) FROM conversations WHERE account_id=(SELECT accB FROM ids)) UNION ALL
 SELECT 'messages',(SELECT count(*) FROM messages WHERE content_text='secret B') UNION ALL
 SELECT 'tags',(SELECT count(*) FROM tags WHERE name='tagB') UNION ALL
 SELECT 'pipelines',(SELECT count(*) FROM pipelines WHERE name='pipeB') UNION ALL
 SELECT 'pipeline_stages',(SELECT count(*) FROM pipeline_stages WHERE name='sB') UNION ALL
 SELECT 'deals',(SELECT count(*) FROM deals WHERE title='dealB') UNION ALL
 SELECT 'automations',(SELECT count(*) FROM automations WHERE name='autoB') UNION ALL
 SELECT 'flows',(SELECT count(*) FROM flows WHERE name='flowB') UNION ALL
 SELECT 'whatsapp_config',(SELECT count(*) FROM whatsapp_config WHERE phone_number_id='PNID_B') UNION ALL
 SELECT 'message_templates',(SELECT count(*) FROM message_templates WHERE name='tplB') UNION ALL
 SELECT 'contact_notes',(SELECT count(*) FROM contact_notes WHERE note_text='noteB') UNION ALL
 SELECT 'custom_fields',(SELECT count(*) FROM custom_fields WHERE field_name='fB') UNION ALL
 SELECT 'webhook_endpoints',(SELECT count(*) FROM webhook_endpoints WHERE account_id=(SELECT accB FROM ids)) UNION ALL
 SELECT 'accounts',(SELECT count(*) FROM accounts WHERE id=(SELECT accB FROM ids)) UNION ALL
 SELECT 'profiles',(SELECT count(*) FROM profiles WHERE user_id='b0000000-0000-0000-0000-000000000001')
) q;
-- team mate A2 (same account) DOES see A data
SELECT pg_temp.as_user('a0000000-0000-0000-0000-000000000002');
INSERT INTO res SELECT 'A2 (agent, same account) sees account-A conversation', count(*)=1, count(*)::text FROM conversations;
-- WRITE isolation as A1
SELECT pg_temp.as_user('a0000000-0000-0000-0000-000000000001');
DO $$ DECLARE n int; accB uuid; ok boolean; BEGIN
 SELECT ids.accB INTO accB FROM ids;
 BEGIN INSERT INTO contacts(user_id,phone,account_id) VALUES ('a0000000-0000-0000-0000-000000000001','+212611111111',accB); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO res VALUES ('A1 cannot INSERT contact into account B', ok, '');
 BEGIN INSERT INTO contacts(user_id,phone,account_id) VALUES ('b0000000-0000-0000-0000-000000000001','+212622222222',accB); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO res VALUES ('A1 cannot INSERT contact as user B into B', ok, '');
 UPDATE contacts SET name='hacked' WHERE account_id=accB; GET DIAGNOSTICS n=ROW_COUNT; INSERT INTO res VALUES ('A1 cannot UPDATE B contacts', n=0, n::text);
 DELETE FROM contacts WHERE account_id=accB; GET DIAGNOSTICS n=ROW_COUNT; INSERT INTO res VALUES ('A1 cannot DELETE B contacts', n=0, n::text);
 UPDATE automations SET name='hacked' WHERE name='autoB'; GET DIAGNOSTICS n=ROW_COUNT; INSERT INTO res VALUES ('A1 cannot UPDATE B automations', n=0, n::text);
 UPDATE whatsapp_config SET access_token='x' WHERE phone_number_id='PNID_B'; GET DIAGNOSTICS n=ROW_COUNT; INSERT INTO res VALUES ('A1 cannot UPDATE B whatsapp_config', n=0, n::text);
 BEGIN INSERT INTO messages(conversation_id,sender_type,content_text) SELECT id,'agent','injected' FROM conversations WHERE account_id=accB LIMIT 1; GET DIAGNOSTICS n=ROW_COUNT; ok:=(n=0); EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO res VALUES ('A1 cannot INSERT message into B conversation', ok, '');
 BEGIN UPDATE profiles SET account_id=accB, account_role='owner' WHERE user_id='a0000000-0000-0000-0000-000000000001'; GET DIAGNOSTICS n=ROW_COUNT; ok:=(n=0); EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO res VALUES ('A1 cannot move own profile into account B', ok, '');
 BEGIN UPDATE profiles SET account_role='owner' WHERE user_id='a0000000-0000-0000-0000-000000000002'; GET DIAGNOSTICS n=ROW_COUNT; INSERT INTO res VALUES ('(info) owner promoting teammate allowed?', true, 'rows='||n); EXCEPTION WHEN OTHERS THEN INSERT INTO res VALUES ('(info) owner promote teammate error', true, SQLERRM); END;
END $$;
-- agent A2 privilege escalation
SELECT pg_temp.as_user('a0000000-0000-0000-0000-000000000002');
DO $$ DECLARE n int; ok boolean; BEGIN
 BEGIN UPDATE profiles SET account_role='owner' WHERE user_id='a0000000-0000-0000-0000-000000000002'; GET DIAGNOSTICS n=ROW_COUNT; ok:=(n=0 OR (SELECT account_role FROM profiles WHERE user_id='a0000000-0000-0000-0000-000000000002')<>'owner'); EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO res VALUES ('agent cannot self-promote to owner', ok, '');
 BEGIN UPDATE accounts SET name='hijack' WHERE id=(SELECT accA FROM ids); GET DIAGNOSTICS n=ROW_COUNT; ok:=(n=0); EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO res VALUES ('agent cannot rename account', ok, 'rows='||coalesce(n,0));
END $$;
-- ANON
RESET ROLE; SET ROLE anon; SELECT set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claim.role','anon',false);
DO $$ DECLARE t text; n int; bad text:=''; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
  BEGIN EXECUTE format('SELECT count(*) FROM public.%I',t) INTO n; IF n>0 THEN bad:=bad||t||'('||n||') '; END IF; EXCEPTION WHEN OTHERS THEN NULL; END;
 END LOOP;
 INSERT INTO res VALUES ('anon reads 0 rows in all 37 public tables', bad='', bad);
END $$;
INSERT INTO res SELECT 'anon cannot list storage objects (chat-media/flow-media)', count(*)=0, count(*)::text FROM storage.objects WHERE bucket_id IN ('chat-media','flow-media');
-- STORAGE as A1
RESET ROLE; SET ROLE authenticated; SELECT pg_temp.as_user('a0000000-0000-0000-0000-000000000001');
INSERT INTO res SELECT 'A1 storage: sees only own-account folder', count(*) FILTER (WHERE name LIKE 'account-'||(SELECT accA FROM ids)||'/%')=count(*) AND count(*)>0, count(*)::text FROM storage.objects WHERE bucket_id IN ('chat-media','flow-media');
INSERT INTO res SELECT 'A1 storage: sees NO account-B objects', count(*)=0, count(*)::text FROM storage.objects WHERE name LIKE 'account-'||(SELECT accB FROM ids)||'/%';
-- internal functions (migration 044)

-- cross-account use of membership RPCs
SELECT pg_temp.as_user('a0000000-0000-0000-0000-000000000001');
DO $$ DECLARE ok boolean; BEGIN
 BEGIN PERFORM public.remove_account_member('b0000000-0000-0000-0000-000000000001'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO res VALUES ('owner A cannot remove_account_member of account B user', ok, '');
 BEGIN PERFORM public.set_member_role('b0000000-0000-0000-0000-000000000001','admin'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO res VALUES ('owner A cannot set_member_role of account B user', ok, '');
 BEGIN PERFORM public.transfer_account_ownership('b0000000-0000-0000-0000-000000000001'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO res VALUES ('owner A cannot transfer ownership to account B user', ok, '');
 BEGIN PERFORM public.is_account_member((SELECT accB FROM ids)); INSERT INTO res SELECT 'is_account_member(B) false for A1', NOT public.is_account_member((SELECT accB FROM ids)), ''; EXCEPTION WHEN OTHERS THEN INSERT INTO res VALUES ('is_account_member(B) false for A1', true, SQLERRM); END;
END $$;
-- removed member keeps nothing (ex-member scenario at DB layer)
RESET ROLE;
SELECT public.remove_account_member('a0000000-0000-0000-0000-000000000002') WHERE false;
SET ROLE authenticated; SELECT pg_temp.as_user('a0000000-0000-0000-0000-000000000001');
SELECT public.remove_account_member('a0000000-0000-0000-0000-000000000002');
SELECT pg_temp.as_user('a0000000-0000-0000-0000-000000000002');
INSERT INTO res SELECT 'ex-member A2 sees 0 account-A conversations after removal', count(*)=0, count(*)::text FROM conversations;
INSERT INTO res SELECT 'ex-member A2 sees 0 account-A automations after removal', count(*)=0, count(*)::text FROM automations WHERE name='autoA';
INSERT INTO res SELECT 'ex-member A2 sees 0 account-A whatsapp_config after removal', count(*)=0, count(*)::text FROM whatsapp_config WHERE phone_number_id='PNID_A';
RESET ROLE; SET ROLE anon; SELECT set_config('request.jwt.claim.sub','',false);
DO $$ DECLARE ok boolean; BEGIN
 BEGIN PERFORM public.remove_account_member('a0000000-0000-0000-0000-000000000001'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO res VALUES ('anon cannot call remove_account_member', ok, '');
 BEGIN PERFORM public.transfer_account_ownership('a0000000-0000-0000-0000-000000000001'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO res VALUES ('anon cannot call transfer_account_ownership', ok, '');
 BEGIN PERFORM public.set_member_role('a0000000-0000-0000-0000-000000000001','viewer'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO res VALUES ('anon cannot call set_member_role', ok, '');
 BEGIN PERFORM public.touch_presence('x'); ok:=false; EXCEPTION WHEN OTHERS THEN ok:=true; END;
 INSERT INTO res VALUES ('anon cannot call touch_presence', ok, '');
END $$;
RESET ROLE;
-- internal functions (migration 044)
INSERT INTO res SELECT 'EXECUTE revoked from anon/authenticated: '||p.oid::regprocedure::text,
  NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE'), ''
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('_bcast_bump','recompute_broadcast_counts','claim_ai_reply_slot','record_webhook_failure','merge_duplicate_contacts','merge_duplicate_conversations');
-- generic structure checks
INSERT INTO res SELECT 'RLS enabled on every public table', count(*)=0, string_agg(relname,',') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity;
INSERT INTO res SELECT 'no policy with USING/CHECK literally true (non-service)', count(*)=0, string_agg(tablename||'.'||policyname,',') FROM pg_policies WHERE schemaname IN ('public','storage') AND (qual='true' OR with_check='true') ;
INSERT INTO res SELECT 'no public-role policies on storage.objects for anon', count(*)=0, string_agg(policyname,',') FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND ('anon'=ANY(roles) OR 'public'=ANY(roles)) AND cmd IN ('SELECT','ALL');
INSERT INTO res SELECT 'SECURITY DEFINER funcs without fixed search_path', count(*)=0, string_agg(p.oid::regprocedure::text,',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND (p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));
INSERT INTO res SELECT '(info) SECURITY DEFINER funcs EXECUTABLE by anon', true, coalesce(string_agg(p.oid::regprocedure::text,', '),'none') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('anon',p.oid,'EXECUTE');
INSERT INTO res SELECT '(info) SECURITY DEFINER funcs EXECUTABLE by authenticated', true, coalesce(string_agg(p.proname,', ' ORDER BY p.proname),'none') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('authenticated',p.oid,'EXECUTE');
SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END r, test, info FROM res ORDER BY ok, test;
SELECT 'SUMMARY pass=' || count(*) FILTER (WHERE ok) || ' fail=' || count(*) FILTER (WHERE NOT ok) FROM res;

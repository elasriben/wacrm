#!/usr/bin/env python3
"""Disposable PostgreSQL regression tests. No production database option."""
import argparse
import json
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
IMAGE = 'pgvector/pgvector@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d'
OWNER = 'e9060000-0000-0000-0000-000000000001'
BOWNER = 'f9060000-0000-0000-0000-000000000001'
DB = 'consent906_test'


def command(args, text=None, timeout=180):
    return subprocess.run(args, input=text, capture_output=True, text=True, timeout=timeout)



def masked_error_sql(statement):
    directive = "\\set ON_ERROR_STOP on"
    if statement.count(directive) != 1:
        raise RuntimeError('Masked-error mutation target missing or ambiguous')
    mutated = statement.replace(directive, "\\set ON_ERROR_STOP off", 1)
    if mutated == statement:
        raise RuntimeError('Masked-error mutation did not change SQL')
    return mutated


def write_negative_sql(docker, statement):
    path = '/tmp/negative/oralink/crm/tests/ol14-residual.sql'
    write = docker('bash', '-c', 'cat > '+path, text=statement)
    if write.returncode:
        raise RuntimeError('Cannot write SQL error mutation: '+write.stderr)
    readback = docker('cat', path)
    if readback.returncode or readback.stdout != statement:
        raise RuntimeError('SQL error mutation readback differs from requested content')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='/tmp/crm906-results.json')
    args = parser.parse_args()
    name = 'oralink-crm906-' + uuid.uuid4().hex[:10]
    results = []
    evidence = {}

    def docker(*words, text=None, timeout=180):
        return command(['docker', 'exec', '-i', name, *words], text, timeout)

    def sql(statement, role=None, uid=None, database=DB):
        prefix = ''
        if role:
            prefix = f"SET ROLE {role}; SET request.jwt.claim.sub='{uid or ''}';\n"
        return docker('psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-U', 'postgres', '-d', database, text=prefix+statement)

    def must(statement, **kw):
        r = sql(statement, **kw)
        if r.returncode:
            raise RuntimeError(r.stderr)
        return r.stdout.strip()

    def check(label, statement, expected, role='authenticated', uid=OWNER, code=None):
        r = sql(statement, role=role, uid=uid)
        ok = (r.returncode != 0 and code in r.stderr) if code else (r.returncode == 0 and r.stdout.strip() == expected)
        results.append({'label': label, 'ok': bool(ok), 'expected': code or expected,
                        'actual': r.stderr.strip() if r.returncode else r.stdout.strip()})
        print(('PASS' if ok else 'FAIL') + ' | ' + label, flush=True)

    def migration(number, database=DB, messages=False):
        files = list((ROOT/'supabase/migrations').glob(str(number)+'_*.sql'))
        if len(files) != 1:
            raise RuntimeError('Migration not unique: '+str(number))
        # messages=True: full NOTICE text (VERBOSITY=sqlstate prints only the code).
        verbosity = '\\set VERBOSITY default\n' if messages else ''
        return sql(verbosity+'\\i /repo/supabase/migrations/'+files[0].name, database=database)

    def apply(number, database=DB):
        r = migration(number, database)
        if r.returncode:
            raise RuntimeError(r.stderr)

    def contact(n):
        return f'e9160000-0000-0000-0000-{n:012d}'

    def consent(n, status, purpose='service', seq=None):
        fields = 'seq,' if seq is not None else ''
        values = str(seq)+',' if seq is not None else ''
        overriding = ' OVERRIDING SYSTEM VALUE' if seq is not None else ''
        return f"INSERT INTO public.contact_consents({fields}account_id,contact_id,purpose,status,source,recorded_by){overriding} SELECT {values}account_id,'{contact(n)}','{purpose}','{status}','manual',user_id FROM public.profiles WHERE user_id=auth.uid();"

    def state(n, purpose='service'):
        return f"SELECT status FROM public.contact_consent_current WHERE contact_id='{contact(n)}' AND purpose='{purpose}';"

    try:
        r = command(['docker', 'run', '-d', '--name', name, '--network', 'none', '--memory=1g', '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-v', str(ROOT)+':/repo:ro', IMAGE])
        if r.returncode:
            raise RuntimeError(r.stderr)
        for _ in range(100):
            ready = docker('bash', '-c', 'test "$(cat /proc/1/comm)" = postgres && pg_isready -q -U postgres')
            if ready.returncode == 0:
                break
            time.sleep(.2)
        else:
            raise RuntimeError('Database startup timed out')
        r = docker('bash', '-c', 'mkdir /tmp/pre904; for f in /repo/supabase/migrations/*.sql; do n=$(basename "$f"); version=${n%%_*}; [[ "$version" =~ ^[0-9]+$ ]] || exit 2; if ((10#$version > 903)); then continue; fi; cp "$f" /tmp/pre904/; done; PGUSER=postgres PGHOST=/var/run/postgresql MIGRATIONS_DIR=/tmp/pre904 TEST_DB=consent906_test KEEP_DB=1 bash /repo/supabase/tests/run.sh')
        evidence['bootstrap_exit'] = r.returncode
        evidence['bootstrap_summary'] = [x for x in r.stdout.splitlines() if 'SUMMARY' in x or 'schéma' in x]
        if r.returncode:
            raise RuntimeError(r.stdout+'\n'+r.stderr)
        evidence['postgres'] = must('SELECT version();', database='postgres')
        seed = f"INSERT INTO auth.users(id,email) VALUES ('{OWNER}','owner-a@example.invalid'),('{BOWNER}','owner-b@example.invalid')"
        for n, role in [(2,'admin'), (3,'agent'), (4,'viewer'), (5,'agent')]:
            seed += f",('e9060000-0000-0000-0000-{n:012d}','role-{n}@example.invalid')"
        seed += ';'
        seed += f"UPDATE public.profiles SET account_id=(SELECT account_id FROM public.profiles WHERE user_id='{OWNER}'),account_role=CASE right(user_id::text,1) WHEN '2' THEN 'admin'::public.account_role_enum WHEN '4' THEN 'viewer'::public.account_role_enum ELSE 'agent'::public.account_role_enum END WHERE user_id::text LIKE 'e906%' AND user_id<>'{OWNER}';"
        seed += f"DELETE FROM public.accounts WHERE owner_user_id::text LIKE 'e906%' AND owner_user_id<>'{OWNER}';"
        for n in range(1,7):
            seed += f"INSERT INTO public.contacts(id,user_id,account_id,phone,name) SELECT '{contact(n)}',user_id,account_id,'+120255501{n:02d}','TEST-{n}' FROM public.profiles WHERE user_id='{OWNER}';"
        seed += f"INSERT INTO public.contacts(id,user_id,account_id,phone,name) SELECT 'f9160000-0000-0000-0000-000000000001',user_id,account_id,'+12025550101','TEST-B' FROM public.profiles WHERE user_id='{BOWNER}';"
        must(seed)
        for statement in [consent(1,'granted',seq=1000000000), consent(1,'revoked'), consent(2,'granted',seq=2000000000), consent(3,'revoked',seq=3000000000), consent(3,'granted'), consent(4,'granted'), consent(5,'revoked')]:
            must(statement, role='authenticated', uid=OWNER)
        for status in ['granted','revoked']:
            must(f"INSERT INTO public.contact_consents(account_id,contact_id,purpose,status,source,recorded_by) SELECT account_id,'f9160000-0000-0000-0000-000000000001','service','{status}','manual',user_id FROM public.profiles WHERE user_id=auth.uid();",role='authenticated',uid=BOWNER)
        check('pre904 historical high grant then STOP is revoked', state(1), 'revoked')
        check('pre904 explicit later START is granted', state(3), 'granted')
        apply(904)
        check('reproduce 904 historical regression', state(1), 'granted')
        must(consent(1,'revoked'), role='authenticated', uid=OWNER)
        check('reproduce 904 new STOP masked', state(1), 'granted')
        check('reproduce SQL setval privilege before906', "SELECT has_sequence_privilege(current_user,'public.contact_consents_seq_seq','UPDATE');", 't')
        # Before/after snapshots prove events are unchanged apart from the new order.
        must('CREATE TABLE public.audit906_history AS SELECT to_jsonb(c) AS event FROM public.contact_consents c;')
        # Check atomic failure before first installation on populated copies.
        for variant in ['exhausted', 'inherited', 'badindex']:
            db = 'consent906_' + variant + '_test'
            must(f'CREATE DATABASE {db} TEMPLATE {DB};', database='postgres')
            if variant == 'exhausted':
                must("SELECT setval('public.contact_consents_seq_seq',9223372036854775807,true);", database=db)
                code = '54000'
            elif variant == 'inherited':
                must('CREATE ROLE crm906_parent; GRANT UPDATE ON SEQUENCE public.contact_consents_seq_seq TO crm906_parent; GRANT crm906_parent TO authenticated;', database=db)
                code = '42501'
            else:
                must('CREATE INDEX contact_consents_decision_order_key ON public.contact_consents(account_id);', database=db)
                code = '55000'
            previous = must('SELECT last_value FROM public.contact_consents_seq_seq;', database=db)
            failure = migration(906, db)
            results.append({'label':'first migration fails safely: '+variant, 'ok':failure.returncode!=0 and code in failure.stderr, 'actual':failure.stderr.strip()})
            clean = must("SELECT NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.contact_consents'::regclass AND attname='decision_order' AND NOT attisdropped) AND to_regclass('public.contact_consents_decision_order_seq') IS NULL;", database=db)
            unchanged = must('SELECT last_value FROM public.contact_consents_seq_seq;', database=db)
            results.append({'label':'atomic rollback and sequence restart: '+variant, 'ok':clean=='t' and unchanged==previous})
            if variant == 'inherited':
                must('REVOKE crm906_parent FROM authenticated; DROP OWNED BY crm906_parent; DROP ROLE crm906_parent;', database=db)
            must(f'DROP DATABASE {db};', database='postgres')
        first = migration(906, messages=True)
        if first.returncode:
            raise RuntimeError(first.stderr)
        # Counts only: C3 (high-seq STOP, later START) vs pre-904; C1 (high-seq grant, later STOP) vs 904.
        results.append({'label': 'first migration reports automatic revocation counts', 'ok': '906: 1 consent pair(s) revoked versus the pre-904 order, 1 versus the 904 order' in first.stderr, 'actual': first.stderr.strip()})
        check('906 restores legacy revoked decision', state(1), 'revoked')
        check('906 preserves current revoked on ambiguous historical START', state(3), 'revoked')
        check('906 preserves granted when both old orders agree', state(4), 'granted')
        check('906 preserves ordinary revoked', state(5), 'revoked')
        check('906 preserves historical events and old seq', "SELECT NOT EXISTS ((SELECT event FROM public.audit906_history EXCEPT SELECT to_jsonb(c)-'decision_order' FROM public.contact_consents c) UNION ALL (SELECT to_jsonb(c)-'decision_order' FROM public.contact_consents c EXCEPT SELECT event FROM public.audit906_history));", 't', role=None)
        must(consent(2,'revoked'), role='authenticated', uid=OWNER)
        check('new STOP beats historical high grant', state(2), 'revoked')
        must(consent(1,'granted'), role='authenticated', uid=OWNER)
        check('new explicit START may grant', state(1), 'granted')
        must('CREATE TABLE public.audit906_order AS SELECT id,decision_order FROM public.contact_consents;')
        replay = migration(906, messages=True)
        if replay.returncode:
            raise RuntimeError(replay.stderr)
        results.append({'label': 'replay reports no automatic revocation', 'ok': '906:' not in replay.stderr, 'actual': replay.stderr.strip()})
        check('idempotence does not undo later START', state(1), 'granted')
        check('idempotence preserves every allocated order', 'SELECT bool_and(c.decision_order=o.decision_order) FROM public.contact_consents c JOIN public.audit906_order o USING(id);', 't', role=None)
        check('old sequence avoids historical collisions', "SELECT max(seq)>3000000000 FROM public.contact_consents WHERE contact_id='"+contact(1)+"';", 't')
        for role, uid in [('authenticated',OWNER),('authenticated','e9060000-0000-0000-0000-000000000002'),('authenticated','e9060000-0000-0000-0000-000000000003'),('authenticated','e9060000-0000-0000-0000-000000000004'),('anon',None),('service_role',None)]:
            label = role + '/' + (uid[-1] if uid else '-')
            for sequence in ['contact_consents_seq_seq','contact_consents_decision_order_seq']:
                check(label+'/setval denied/'+sequence, f"SELECT setval('public.{sequence}',1,true);", '', role=role, uid=uid, code='42501')
            # The identity default needs no sequence privilege: application roles cannot draw values directly.
            check(label+'/nextval denied/contact_consents_seq_seq', "SELECT nextval('public.contact_consents_seq_seq');", '', role=role, uid=uid, code='42501')
            if role=='authenticated' and uid != 'e9060000-0000-0000-0000-000000000004':
                check(label+'/legitimate consent INSERT', consent(6,'revoked')+'SELECT 1;', '1', role=role, uid=uid)
        check('viewer INSERT denied', consent(6,'revoked'), '', uid='e9060000-0000-0000-0000-000000000004', code='42501')
        check('anon INSERT denied', consent(6,'revoked'), '', role='anon', uid=None, code='42501')
        check('service legitimate INSERT remains possible', f"INSERT INTO public.contact_consents(account_id,contact_id,purpose,status,source) SELECT account_id,'{contact(6)}','marketing','revoked','inbound' FROM public.contacts WHERE id='{contact(6)}'; SELECT 1;", '1', role='service_role', uid=None)
        check('caller supplied decision order ignored', f"INSERT INTO public.contact_consents(account_id,contact_id,purpose,status,source,recorded_by,decision_order) SELECT account_id,'{contact(6)}','service','revoked','manual',user_id,9223372036854775807 FROM public.profiles WHERE user_id=auth.uid() RETURNING decision_order<9223372036854775807;", 't')
        check('owner B sees real own consent rows', "SELECT count(*) FROM public.contact_consents WHERE contact_id='f9160000-0000-0000-0000-000000000001';", '2', uid=BOWNER)
        check('owner B retains own STOP', "SELECT status FROM public.contact_consent_current WHERE contact_id='f9160000-0000-0000-0000-000000000001';", 'revoked', uid=BOWNER)
        check('B cannot see account A consent rows', "SELECT count(*) FROM public.contact_consents WHERE contact_id='"+contact(1)+"';", '0', uid=BOWNER)
        check('A cannot see account B consent view', "SELECT count(*) FROM public.contact_consent_current WHERE contact_id='f9160000-0000-0000-0000-000000000001';", '0')
        check('cross account SELECT denied' , "SELECT count(*) FROM public.contact_consents WHERE contact_id='f9160000-0000-0000-0000-000000000001';", '0')
        baccount=must(f"SELECT account_id FROM public.profiles WHERE user_id='{BOWNER}';")
        check('account forgery denied', f"INSERT INTO public.contact_consents(account_id,contact_id,purpose,status,source,recorded_by) VALUES('{baccount}','f9160000-0000-0000-0000-000000000001','service','revoked','manual','{OWNER}');", '', code='42501')
        must("SELECT public.remove_account_member('e9060000-0000-0000-0000-000000000005');", role='authenticated', uid=OWNER)
        aaccount=must(f"SELECT account_id FROM public.profiles WHERE user_id='{OWNER}';")
        check('revoked member cannot INSERT into old account', f"INSERT INTO public.contact_consents(account_id,contact_id,purpose,status,source,recorded_by) VALUES('{aaccount}','{contact(6)}','service','revoked','manual','e9060000-0000-0000-0000-000000000005');", '', uid='e9060000-0000-0000-0000-000000000005', code='42501')
        # A real writer holds its row changes while migration replay waits.
        writer = subprocess.Popen(['docker','exec','-i',name,'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d',DB], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        writer.stdin.write(f"BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='{OWNER}';"+consent(2,'revoked')+"SELECT pg_sleep(1.5) /*906-writer*/; COMMIT;")
        writer.stdin.close()
        for _ in range(60):
            sleeping=must("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%906-writer%' AND wait_event='PgSleep';", database='postgres')
            if sleeping=='1': break
            time.sleep(.05)
        else: raise RuntimeError('Concurrent writer did not synchronize')
        started=time.monotonic()
        apply(906)
        elapsed=time.monotonic()-started
        writer.wait(timeout=10)
        if writer.returncode: raise RuntimeError(writer.stderr.read())
        results.append({'label':'migration replay waits for active writer', 'ok':elapsed>.2, 'actual':round(elapsed,3)})
        check('concurrent STOP preserved after migration replay', state(2), 'revoked')
        # Guard rejects update tampering even for the RLS-bypassing service role.
        check('service cannot rewrite decision_order', f"UPDATE public.contact_consents SET decision_order=1 WHERE contact_id='{contact(1)}';", '', role='service_role', uid=None, code='42501')
        # Fail closed when an inherited privilege cannot be removed by direct REVOKE.
        must('CREATE ROLE crm906_sequence_parent; GRANT UPDATE ON SEQUENCE public.contact_consents_seq_seq TO crm906_sequence_parent; GRANT crm906_sequence_parent TO authenticated;')
        failed=migration(906)
        results.append({'label':'inherited sequence UPDATE aborts corrective migration', 'ok':failed.returncode!=0 and '42501' in failed.stderr, 'actual':failed.stderr.strip()})
        must('REVOKE crm906_sequence_parent FROM authenticated; DROP OWNED BY crm906_sequence_parent; DROP ROLE crm906_sequence_parent;')
        # SET ROLE paths (CRM 907, risk C): no inherited privilege, but reachable with SET ROLE.
        # PostgreSQL 16+ grants membership WITH INHERIT FALSE, SET TRUE; before 16 the
        # equivalent is a NOINHERIT member role (that syntax does not exist on 15).
        modern = int(must('SHOW server_version_num;', database='postgres')) >= 160000
        set_only_grant = ('GRANT crm906_set_only TO authenticated WITH INHERIT FALSE, SET TRUE;' if modern
                          else 'ALTER ROLE authenticated NOINHERIT; GRANT crm906_set_only TO authenticated;')
        set_only_undo = 'REVOKE crm906_set_only FROM authenticated;' + ('' if modern else ' ALTER ROLE authenticated INHERIT;')
        for label, setup, cleanup in [
            ('SET-only membership sequence UPDATE aborts corrective migration',
             'CREATE ROLE crm906_set_only; GRANT UPDATE ON SEQUENCE public.contact_consents_seq_seq TO crm906_set_only; ' + set_only_grant,
             set_only_undo + ' DROP OWNED BY crm906_set_only; DROP ROLE crm906_set_only;'),
            ('transitive NOINHERIT chain sequence UPDATE aborts corrective migration',
             'CREATE ROLE crm906_top; CREATE ROLE crm906_mid NOINHERIT; GRANT UPDATE ON SEQUENCE public.contact_consents_decision_order_seq TO crm906_top; GRANT crm906_top TO crm906_mid; GRANT crm906_mid TO authenticated;',
             'REVOKE crm906_mid FROM authenticated; REVOKE crm906_top FROM crm906_mid; DROP OWNED BY crm906_top; DROP ROLE crm906_mid; DROP ROLE crm906_top;'),
        ]:
            must(setup)
            failed=migration(906)
            results.append({'label':label, 'ok':failed.returncode!=0 and '42501' in failed.stderr, 'actual':failed.stderr.strip()})
            must(cleanup)
        apply(906)
        check('new order sequence nextval is private', "SELECT nextval('public.contact_consents_decision_order_seq');", '', code='42501')
        check('setval is not a public RPC function', "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='setval';", '0')
        # Transaction starts before opt-in but allocates its STOP order later.
        writer = subprocess.Popen(['docker','exec','-i',name,'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d',DB], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        writer.stdin.write(f"BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='{OWNER}'; SELECT pg_sleep(1.5) /*906-stop-after-grant*/;"+consent(2,'revoked')+"COMMIT;")
        writer.stdin.close()
        for _ in range(60):
            sleeping=must("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%906-stop-after-grant%' AND wait_event='PgSleep';", database='postgres')
            if sleeping=='1': break
            time.sleep(.05)
        else: raise RuntimeError('STOP race did not synchronize')
        must(consent(2,'granted'), role='authenticated', uid=OWNER)
        writer.wait(timeout=10)
        if writer.returncode: raise RuntimeError(writer.stderr.read())
        check('concurrent STOP inserted after opt-in wins despite earlier BEGIN', state(2), 'revoked')
        # Run the actual hardened suite, then mutate a temporary COPY, never sources.
        normal=docker('bash','-c','PGUSER=postgres PGHOST=/var/run/postgresql TEST_DB=crm906_full_test bash /repo/oralink/crm/tests/run-isolation-cases.sh')
        evidence['full_suite']={'exit':normal.returncode,'summaries':[x for x in normal.stdout.splitlines() if 'SUMMARY' in x]}
        results.append({'label':'full CRM903/904/906 suite and migration replays', 'ok':normal.returncode==0,'actual':normal.stdout[-2500:]+'\n'+normal.stderr[-1500:]})
        copy=docker('bash','-c','mkdir -p /tmp/negative/oralink/crm/tests; cp /repo/oralink/crm/tests/* /tmp/negative/oralink/crm/tests/; cp -r /repo/supabase /tmp/negative/supabase')
        if copy.returncode: raise RuntimeError(copy.stderr)
        # Python is available on the host, not necessarily inside the image.
        original=(ROOT/'oralink/crm/tests/ol14-residual.sql').read_text()
        altered=original.replace('DO $$ BEGIN','DO $$ BEGIN PERFORM 1/0;',1)
        if altered==original: raise RuntimeError('Mutation target missing')
        write_negative_sql(docker, altered)
        negative=docker('bash','-c','PGUSER=postgres PGHOST=/var/run/postgresql TEST_DB=crm906_negative_test bash /tmp/negative/oralink/crm/tests/run-isolation-cases.sh')
        results.append({'label':'real SQL division-by-zero makes runner red', 'ok':negative.returncode!=0 and ('division by zero' in negative.stderr or 'division by zero' in negative.stdout), 'actual':negative.returncode})
        evidence['negative_runner_exit']=negative.returncode
        # Even with error-stop switched off, omission/error must not look green.
        altered=masked_error_sql(altered)
        write_negative_sql(docker, altered)
        masked=docker('bash','-c','PGUSER=postgres PGHOST=/var/run/postgresql TEST_DB=crm906_masked_test bash /tmp/negative/oralink/crm/tests/run-isolation-cases.sh')
        results.append({'label':'masked psql error cannot produce green runner', 'ok':masked.returncode==2 and ('division by zero' in masked.stderr or 'division by zero' in masked.stdout), 'actual':masked.returncode})
        evidence['masked_runner_exit']=masked.returncode
        must('ALTER SEQUENCE public.contact_consents_decision_order_seq INCREMENT BY -1 MINVALUE -9223372036854775807;')
        drift=migration(906)
        results.append({'label':'decision sequence configuration drift fails closed', 'ok':drift.returncode!=0 and '55000' in drift.stderr, 'actual':drift.stderr.strip()})
        must('ALTER SEQUENCE public.contact_consents_decision_order_seq INCREMENT BY 1 MINVALUE 1;')
        apply(906)
        evidence['results']=results
        Path(args.output).write_text(json.dumps(evidence,indent=2)+'\n')
        bad=[r for r in results if not r['ok']]
        print(f'SUMMARY pass={len(results)-len(bad)} fail={len(bad)}')
        return int(bool(bad))
    finally:
        subprocess.run(['docker','rm','-f',name],capture_output=True)


if __name__=='__main__':
    raise SystemExit(main())

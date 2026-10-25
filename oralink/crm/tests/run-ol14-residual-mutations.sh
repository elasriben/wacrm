#!/usr/bin/env bash
# Tests de la migration 904 (correctifs résiduels OL-14) sur bases JETABLES.
#
#   PGUSER=postgres PGHOST=127.0.0.1 ./oralink/crm/tests/run-ol14-residual-mutations.sh
#
# 1. Rejoue toutes les migrations (supabase/tests/run.sh, KEEP_DB=1) dans une base modèle.
# 2. Référence : ol14-residual.sql doit passer sans aucun échec.
# 3. Course réelle à deux sessions : un STOP inséré APRÈS un opt-in concurrent, dans une transaction
#    commencée AVANT, doit rester l'état courant.
# 4. Chaque mutation retire UNE protection sur une copie de la base modèle : le test doit échouer
#    sur le contrôle attendu (ou s'arrêter en erreur).
# 5. Gardes de 904 : doublons de seq ou propriétaire sans contournement de la RLS -> refus ;
#    état conforme -> rejeu sans erreur.
# Mêmes garde-fous que run.sh (PGHOST local, bases en *_test). Codes : 0 OK · 1 échec · 2 environnement.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/../../.."
BASE=ol14_mutbase_test
MIG904="$ROOT/supabase/migrations/904_oralink_ol14_residual_hardening.sql"
RI="public.redeem_invitation(text)"
case "${PGHOST:-127.0.0.1}" in 127.0.0.1|localhost|::1|/*) ;; *) echo "REFUS : PGHOST non local." >&2; exit 2;; esac
export PGOPTIONS='-c client_min_messages=warning'

TEST_DB="$BASE" KEEP_DB=1 bash "$ROOT/supabase/tests/run.sh" >/dev/null 2>&1 || { echo "Rejeu des migrations ou suite d'isolation en échec (run.sh)"; exit 2; }
WORK="$(mktemp -d)"
cleanup() {
  for d in $(psql -d postgres -Atc "select datname from pg_database where datname like 'ol14_mut%_test'"); do psql -d postgres -qc "DROP DATABASE IF EXISTS \"$d\"" || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

clone() { psql -d postgres -qc "DROP DATABASE IF EXISTS \"$1\"" -c "CREATE DATABASE \"$1\" TEMPLATE \"$BASE\""; }
run_test() { local rc=0; psql -X -At -F ' | ' -d "$1" -f "$HERE/ol14-residual.sql" >"$WORK/out" 2>"$WORK/err" || rc=$?; return "$rc"; }

rc=0
echo "== Référence (904 appliquée, aucune mutation)"
clone ol14_mut_ref_test
if run_test ol14_mut_ref_test && grep -qE '^SUMMARY pass=[0-9]+ fail=0$' "$WORK/out"; then
  echo "  PASS | référence : $(grep '^SUMMARY' "$WORK/out")"
else
  echo "  FAIL | référence en échec"; grep -E '^FAIL|^SUMMARY' "$WORK/out" | sed 's/^/    /'; head -3 "$WORK/err" | sed 's/^/    /'; exit 2
fi

race() { # $1 base · affiche le statut courant après la course
  local db="$1" ct ac
  psql -X -q -d "$db" -c "INSERT INTO auth.users(id,email) VALUES ('9d000000-0000-0000-0000-000000000001','race@test.local')"
  ac="$(psql -X -At -d "$db" -c "SELECT account_id FROM public.profiles WHERE user_id='9d000000-0000-0000-0000-000000000001'")"
  ct="$(psql -X -At -d "$db" -c "INSERT INTO public.contacts(user_id,phone,account_id,name) VALUES ('9d000000-0000-0000-0000-000000000001','+15555550409','$ac','Race') RETURNING id" | head -1)"
  # T1 : transaction ouverte AVANT, STOP inséré APRÈS l'opt-in de T2
  psql -X -q -d "$db" -c "BEGIN" -c "SELECT pg_sleep(2)" \
    -c "INSERT INTO public.contact_consents(account_id,contact_id,purpose,status,source,evidence) VALUES ('$ac','$ct','marketing','revoked','inbound','race-STOP')" \
    -c "COMMIT" >/dev/null &
  sleep 1
  psql -X -q -d "$db" -c "INSERT INTO public.contact_consents(account_id,contact_id,purpose,status,source,evidence) VALUES ('$ac','$ct','marketing','granted','inbound','race-OPTIN')"
  wait
  psql -X -At -d "$db" -c "SELECT status FROM public.contact_consent_current WHERE contact_id='$ct' AND purpose='marketing'"
}
echo "== Course concurrente STOP / opt-in"
clone ol14_mut_race_test
st="$(race ol14_mut_race_test)"
if [ "$st" = revoked ]; then echo "  PASS | STOP inséré après un opt-in concurrent : état courant = revoked"; else echo "  FAIL | état courant = ${st:-vide} (attendu : revoked)"; rc=1; fi
psql -d postgres -qc "DROP DATABASE IF EXISTS ol14_mut_race_test"

# Définitions d'origine, extraites des migrations historiques (non modifiées).
VIEW900="$(sed -n '/^CREATE OR REPLACE VIEW public.contact_consent_current/,/;$/p' "$ROOT/supabase/migrations/900_oralink_contact_consents.sql")"
GUARD900="$(sed -n '/^CREATE OR REPLACE FUNCTION public.oralink_consent_guard()/,/^\$\$;/p' "$ROOT/supabase/migrations/900_oralink_contact_consents.sql")"
RI902="$(sed -n '/^CREATE OR REPLACE FUNCTION public.redeem_invitation(/,/^\$\$;/p' "$ROOT/supabase/migrations/902_oralink_redeem_invitation_tables.sql")"
for v in VIEW900 GUARD900 RI902; do [ -n "${!v}" ] || { echo "Définition $v introuvable"; exit 2; }; done

mutate() { # $1 nom · $2 contrôle attendu en FAIL (ou ERROR = arrêt du test) · $3 SQL de la mutation
  local db="ol14_mut_$(printf '%s' "$1" | tr -c 'a-z0-9' '_' | cut -c1-30)_test" trc=0
  clone "$db"
  psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "$3" >/dev/null
  run_test "$db" || trc=$?
  if [ "$trc" -ne 0 ]; then
    echo "  PASS | détectée : $1 (test arrêté en erreur, code $trc)"
  elif [ "$2" = ERROR ]; then
    echo "  FAIL | NON détectée : $1 (arrêt en erreur attendu)"; rc=1
  elif grep -qF "FAIL | $2" "$WORK/out"; then
    echo "  PASS | détectée : $1 -> $(grep '^SUMMARY' "$WORK/out")"
  else
    echo "  FAIL | NON détectée : $1 (attendu : FAIL « $2 »)"; grep -E '^SUMMARY' "$WORK/out" | sed 's/^/    /'; rc=1
  fi
  psql -d postgres -qc "DROP DATABASE IF EXISTS \"$db\""
}

echo "== Mutations (chacune retire une protection)"
mutate "TRUNCATE lead_scores rendu a authenticated"   "A: authenticated cannot TRUNCATE lead_scores"          "GRANT TRUNCATE ON public.lead_scores TO authenticated"
mutate "TRIGGER lead_scores rendu a authenticated"    "A: authenticated cannot CREATE TRIGGER on lead_scores" "GRANT TRIGGER ON public.lead_scores TO authenticated"
mutate "TRUNCATE consents rendu a service_role"       "A: no TRUNCATE on public.contact_consents for service_role" "GRANT TRUNCATE ON public.contact_consents TO service_role"
mutate "INSERT lead_scores rendu a anon"              "A: anon cannot INSERT lead_scores (privilege, not only RLS)" "GRANT INSERT ON public.lead_scores TO anon"
mutate "SELECT lead_scores retire a authenticated"    "A: legit privilege kept: authenticated SELECT on public.lead_scores" "REVOKE SELECT ON public.lead_scores FROM authenticated"
# Noms qualifiés : le search_path seul ne rouvre pas la faille, seul le contrôle de catalogue le voit.
mutate "redeem search_path remis a public"            "B: proconfig is exactly search_path=pg_catalog, pg_temp" "ALTER FUNCTION $RI SET search_path = public"
mutate "redeem corps 902 restaure"                    "B: forged pg_temp.account_invitations is ignored"      "$RI902"
mutate "redeem EXECUTE rendu a anon"                  "B: anon cannot call redeem_invitation (privilege, not only Unauthorized)" "GRANT EXECUTE ON FUNCTION $RI TO anon"
mutate "redeem controle expiration retire"            "B: expired invitation refused" \
  "$(sed -n '/^CREATE OR REPLACE FUNCTION public.redeem_invitation(/,/^\$\$;/p' "$MIG904" | sed 's/IF v_inv.expires_at <= NOW() THEN/IF false THEN/')"
mutate "vue 900 restauree (recorded_at, seq)"         "C: contact_consent_current orders by seq only"         "$VIEW900"
mutate "garde 900 restauree (now(), seq libre)"       "C: caller-supplied seq (OVERRIDING SYSTEM VALUE) is replaced" "$GUARD900"
mutate "index unique seq supprime"                    "C: unique index on contact_consents(seq)"              "DROP INDEX public.contact_consents_seq_key"

echo "== Course concurrente sur la garde 900 restaurée (doit perdre le STOP)"
clone ol14_mut_race900_test
psql -X -q -v ON_ERROR_STOP=1 -d ol14_mut_race900_test -c "$GUARD900" -c "$VIEW900" >/dev/null
st="$(race ol14_mut_race900_test)"
if [ "$st" = granted ]; then echo "  PASS | détectée : sans 904 l'opt-in concurrent supplante le STOP (état = granted)"; else echo "  FAIL | NON détectée : état = ${st:-vide} (attendu : granted sans 904)"; rc=1; fi
psql -d postgres -qc "DROP DATABASE IF EXISTS ol14_mut_race900_test"

echo "== Gardes et réexécutabilité de 904"
guard() { # $1 nom · $2 SQL préalable · $3 attendu : refuse|passe
  local db="ol14_mut_guard_test" out r
  clone "$db"
  [ -n "$2" ] && psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "$2" >/dev/null
  if out="$(psql -X -q -v ON_ERROR_STOP=1 -1 -d "$db" -f "$MIG904" 2>&1)"; then r=passe; else r=refuse; fi
  if [ "$r" = "$3" ]; then echo "  PASS | $1 : 904 $r"; else echo "  FAIL | $1 : 904 $r (attendu : $3)"; printf '%s\n' "$out" | head -3 | sed 's/^/    /'; rc=1; fi
  [ "$r" = refuse ] && printf '%s\n' "$out" | grep -m1 -oE '904: [^:]*' | sed 's/^/    message : /' || true
  psql -d postgres -qc "DROP DATABASE IF EXISTS \"$db\""
}
guard "rejeu sur etat conforme" "" passe
guard "doublon de seq present" \
  "INSERT INTO auth.users(id,email) VALUES ('9e000000-0000-0000-0000-000000000001','dup@test.local');
   DROP INDEX public.contact_consents_seq_key;
   ALTER TABLE public.contact_consents DISABLE TRIGGER oralink_consent_guard;
   WITH a AS (SELECT account_id FROM public.profiles WHERE user_id='9e000000-0000-0000-0000-000000000001'),
        c AS (INSERT INTO public.contacts(user_id,phone,account_id,name) SELECT '9e000000-0000-0000-0000-000000000001','+15555550408',account_id,'Dup' FROM a RETURNING id, account_id)
   INSERT INTO public.contact_consents(seq,account_id,contact_id,purpose,status,source) OVERRIDING SYSTEM VALUE
     SELECT 77, account_id, id, p, 'granted', 'manual' FROM c, unnest(ARRAY['service','marketing']) p;
   ALTER TABLE public.contact_consents ENABLE TRIGGER oralink_consent_guard" refuse
guard "proprietaire de redeem sans BYPASSRLS" "ALTER FUNCTION $RI OWNER TO authenticated" refuse

[ "$rc" -eq 0 ] && echo "== OL14 : référence verte, course gagnée par le STOP, mutations détectées, gardes conformes" || echo "== OL14 : au moins un échec"
exit "$rc"

#!/usr/bin/env bash
# Tests négatifs de la migration 903 (is_account_member) sur bases JETABLES.
#
#   PGUSER=postgres PGHOST=127.0.0.1 ./oralink/crm/tests/run-is-account-member-mutations.sh
#
# 1. Rejoue toutes les migrations (supabase/tests/run.sh, KEEP_DB=1) dans une base modèle.
# 2. Référence : is-account-member.sql doit passer sans aucun échec.
# 3. Chaque mutation retire UNE protection sur une copie de la base modèle : le test doit échouer
#    sur le contrôle attendu (ou s'arrêter en erreur quand l'accès légitime est cassé).
# 4. Garde de 903 : rejouée sur un propriétaire incompatible ou avec FORCE RLS, elle doit refuser ;
#    rejouée sur un état conforme, elle doit passer (réexécutabilité).
# Mêmes garde-fous que run.sh (PGHOST local, bases en *_test). Codes : 0 OK · 1 mutation non détectée · 2 environnement.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/../../.."
BASE=iam_mutbase_test
MIG903="$ROOT/supabase/migrations/903_oralink_harden_is_account_member.sql"
FN="public.is_account_member(uuid, public.account_role_enum)"
case "${PGHOST:-127.0.0.1}" in 127.0.0.1|localhost|::1|/*) ;; *) echo "REFUS : PGHOST non local." >&2; exit 2;; esac
export PGOPTIONS='-c client_min_messages=warning'

TEST_DB="$BASE" KEEP_DB=1 bash "$ROOT/supabase/tests/run.sh" >/dev/null 2>&1 || { echo "Rejeu des migrations ou suite d'isolation en échec (run.sh)"; exit 2; }
WORK="$(mktemp -d)"
cleanup() {
  for d in $(psql -d postgres -Atc "select datname from pg_database where datname like 'iam_mut%_test'"); do psql -d postgres -qc "DROP DATABASE IF EXISTS \"$d\"" || true; done
  psql -d postgres -qc "DROP ROLE IF EXISTS oralink_iam_extra_test" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

clone() { psql -d postgres -qc "DROP DATABASE IF EXISTS \"$1\"" -c "CREATE DATABASE \"$1\" TEMPLATE \"$BASE\""; }
run_test() { # $1 = base ; écrit $WORK/out, renvoie le code de psql
  local rc=0; psql -X -At -F ' | ' -d "$1" -f "$HERE/is-account-member.sql" >"$WORK/out" 2>"$WORK/err" || rc=$?; return "$rc"
}

rc=0
echo "== Référence (903 appliquée, aucune mutation)"
clone iam_mut_ref_test
if run_test iam_mut_ref_test && grep -qE '^SUMMARY pass=[0-9]+ fail=0$' "$WORK/out"; then
  echo "  PASS | référence : $(grep '^SUMMARY' "$WORK/out")"
else
  echo "  FAIL | référence en échec"; grep -E '^FAIL|^SUMMARY' "$WORK/out" | sed 's/^/    /'; head -3 "$WORK/err" | sed 's/^/    /'; exit 2
fi

# Corps d'origine (017) : search_path=public et profiles non qualifié.
ORIG="$(awk '/^CREATE OR REPLACE FUNCTION is_account_member\(/{p=1} p{print} p&&/^\$\$;/{exit}' "$ROOT/supabase/migrations/017_account_sharing.sql")"
[ -n "$ORIG" ] || { echo "Corps 017 introuvable"; exit 2; }

mutate() { # $1 nom · $2 contrôle attendu en FAIL (ou ERROR = arrêt du test) · $3 SQL de la mutation
  local db="iam_mut_$(printf '%s' "$1" | tr -c 'a-z0-9' '_' | cut -c1-30)_test" trc=0
  clone "$db"
  psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "$3" >/dev/null
  run_test "$db" || trc=$?
  if [ "$trc" -ne 0 ]; then  # le test s'arrête en erreur avant SUMMARY : la mutation ne passe pas inaperçue
    echo "  PASS | détectée : $1 (test arrêté en erreur, code $trc : $(grep -m1 -oE 'ERROR: .{0,90}' "$WORK/err"))"
  elif [ "$2" = ERROR ]; then
    echo "  FAIL | NON détectée : $1 (arrêt en erreur attendu)"; grep -E '^SUMMARY' "$WORK/out" | sed 's/^/    /'; rc=1
  elif grep -qF "FAIL | $2" "$WORK/out"; then
    echo "  PASS | détectée : $1 -> $(grep '^SUMMARY' "$WORK/out")"
  else
    echo "  FAIL | NON détectée : $1 (attendu : FAIL « $2 », code $trc)"; grep -E '^SUMMARY' "$WORK/out" | sed 's/^/    /'; rc=1
  fi
  psql -d postgres -qc "DROP DATABASE IF EXISTS \"$db\""
}

echo "== Mutations (chacune retire une protection)"
mutate "search_path remis a public"           "is_account_member: proconfig is exactly"            "ALTER FUNCTION $FN SET search_path = public"
mutate "pg_temp place en premier"             "is_account_member: pg_temp is the LAST"             "ALTER FUNCTION $FN SET search_path = pg_temp, pg_catalog"
mutate "search_path retire"                   "is_account_member: proconfig is exactly"            "ALTER FUNCTION $FN RESET search_path"
mutate "corps 017 restaure (non qualifie)"    "name resolution: a session-local profiles object"   "$ORIG"
mutate "EXECUTE rendu a PUBLIC"               "is_account_member: no EXECUTE for PUBLIC"           "GRANT EXECUTE ON FUNCTION $FN TO PUBLIC"
mutate "EXECUTE donne a un role inattendu"    "is_account_member: no grantee other than"           "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='oralink_iam_extra_test') THEN CREATE ROLE oralink_iam_extra_test NOLOGIN; END IF; END \$\$; GRANT EXECUTE ON FUNCTION $FN TO oralink_iam_extra_test"
mutate "SECURITY INVOKER"                     "is_account_member: SECURITY DEFINER kept"           "ALTER FUNCTION $FN SECURITY INVOKER"
mutate "proprietaire different de profiles"   "is_account_member: owner also owns public.profiles" "ALTER FUNCTION $FN OWNER TO service_role"
mutate "hierarchie des roles cassee (> au lieu de >=)" "is_account_member: role hierarchy" \
  "$(sed -n '/^CREATE OR REPLACE FUNCTION public.is_account_member(/,/^\$\$;/p' "$MIG903" | sed 's/^        >=$/        >/')"
mutate "EXECUTE retire a authenticated (acces legitime casse)" ERROR "REVOKE EXECUTE ON FUNCTION $FN FROM authenticated"

echo "== Garde et réexécutabilité de 903"
guard() { # $1 nom · $2 SQL préalable · $3 attendu : refuse|passe
  local db="iam_mut_guard_test" out
  clone "$db"
  [ -n "$2" ] && psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "$2" >/dev/null
  if out="$(psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG903" 2>&1)"; then r=passe; else r=refuse; fi
  if [ "$r" = "$3" ]; then echo "  PASS | $1 : 903 $r"; else echo "  FAIL | $1 : 903 $r (attendu : $3)"; printf '%s\n' "$out" | head -3 | sed 's/^/    /'; rc=1; fi
  [ "$r" = refuse ] && printf '%s\n' "$out" | grep -m1 -oE '903: [^,]*' | sed 's/^/    message : /' || true
  psql -d postgres -qc "DROP DATABASE IF EXISTS \"$db\""
}
guard "rejeu sur etat conforme"                    ""                                                       passe
guard "proprietaire de la fonction != profiles"    "ALTER FUNCTION $FN OWNER TO service_role"               refuse
guard "FORCE ROW LEVEL SECURITY sur profiles"      "ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY"   refuse

[ "$rc" -eq 0 ] && echo "== MUTATIONS : toutes détectées, garde conforme" || echo "== MUTATIONS : au moins un échec"
exit "$rc"

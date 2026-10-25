#!/usr/bin/env bash
# Rejoue toutes les migrations + la suite d'isolation existante (supabase/tests/run.sh),
# puis les cas OraLink CRM (isolation-cases.sql) sur la même base JETABLE, puis la supprime.
#
#   PGUSER=postgres PGHOST=/var/run/postgresql ./oralink/crm/tests/run-isolation-cases.sh
#
# Mêmes garde-fous que run.sh (PGHOST local, TEST_DB en *_test). Codes : 0 OK · 1 échec · 2 environnement.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/../../.."
export TEST_DB="${TEST_DB:-wacrm_isolation_test}"
case "${PGHOST:-127.0.0.1}" in 127.0.0.1|localhost|::1|/*) ;; *) echo "REFUS : PGHOST non local." >&2; exit 2;; esac
[[ "$TEST_DB" =~ ^[a-z0-9_]+_test$ ]] || { echo "REFUS : TEST_DB doit se terminer par _test." >&2; exit 2; }

WORK="$(mktemp -d)"
cleanup() {
  local status=$?
  rm -rf "$WORK"
  if ! psql -X -d postgres -qc "DROP DATABASE IF EXISTS \"$TEST_DB\""; then
    echo "Échec du nettoyage de la base jetable $TEST_DB." >&2
    [ "$status" -ne 0 ] || status=2
  fi
  exit "$status"
}
trap cleanup EXIT

rc=0
KEEP_DB=1 bash "$ROOT/supabase/tests/run.sh" || rc=$?
[ "$rc" -eq 2 ] && exit 2

# Each migration must remain replayable; a SQL error always makes this run red.
echo "== Idempotence des migrations 9NN_oralink_*"
for f in "$ROOT"/supabase/migrations/9[0-9][0-9]_oralink_*.sql; do
  if PGOPTIONS='-c client_min_messages=warning' psql -X -q -v ON_ERROR_STOP=1 -d "$TEST_DB" -f "$f" >"$WORK/idempotence.out" 2>"$WORK/idempotence.err"; then
    echo "  PASS | rejeu sans erreur : $(basename "$f")"
  else
    echo "  FAIL | rejeu en erreur : $(basename "$f")"
    head -3 "$WORK/idempotence.err" | sed 's/^/    /'
    rc=1
  fi
done

# The expected assertion count is intentional. Removing a statement/block must
# not turn an incomplete suite into success. Update the count with new tests.
run_suite() {
  local script="$1" expected="$2" label="$3" sql_rc=0 summary passes failures actual_pass actual_fail duplicates
  local out="$WORK/$label.out" err="$WORK/$label.err"
  echo "== $label ($script)"
  PGOPTIONS='-c client_min_messages=warning' psql -X -At -F ' | ' -v ON_ERROR_STOP=1 -d "$TEST_DB" -f "$HERE/$script" >"$out" 2>"$err" || sql_rc=$?
  { grep -E '^(PASS|FAIL) \|' "$out" || true; } | sort | sed 's/^/  /'
  if [ "$sql_rc" -ne 0 ] || grep -Eq '(ERROR|FATAL|PANIC):' "$err"; then
    echo "$script : erreur SQL (code $sql_rc), résultats invalides." >&2
    head -20 "$err" >&2
    return 2
  fi
  summary="$(grep -E '^SUMMARY pass=[0-9]+ fail=[0-9]+$' "$out" || true)"
  if [ -z "$summary" ] || [ "$(printf '%s\n' "$summary" | wc -l)" -ne 1 ] || [ "$(grep -c '^SUMMARY' "$out" || true)" -ne 1 ]; then
    echo "$script : résumé unique valide absent." >&2
    return 2
  fi
  passes="${summary#SUMMARY pass=}"; passes="${passes%% *}"
  failures="${summary##* fail=}"
  actual_pass="$(grep -c '^PASS |' "$out" || true)"
  actual_fail="$(grep -c '^FAIL |' "$out" || true)"
  duplicates="$( { grep -E '^(PASS|FAIL) \|' "$out" || true; } | cut -d '|' -f2 | sort | uniq -d)"
  if [ "$actual_pass" -ne "$passes" ] || [ "$actual_fail" -ne "$failures" ] || [ $((passes + failures)) -ne "$expected" ] || [ -n "$duplicates" ]; then
    echo "$script : contrôles incomplets ou incohérents (attendus=$expected ; résumé=$passes/$failures ; lignes=$actual_pass/$actual_fail)." >&2
    return 2
  fi
  echo "== $label $summary"
  [ "$failures" -eq 0 ] || return 1
}

for spec in 'isolation-cases.sql 49 ORALINK' 'is-account-member.sql 36 IS_ACCOUNT_MEMBER' 'ol14-residual.sql 88 OL14_RESIDUAL'; do
  read -r script expected label <<<"$spec"
  suite_rc=0
  run_suite "$script" "$expected" "$label" || suite_rc=$?
  [ "$suite_rc" -ne 2 ] || exit 2
  [ "$suite_rc" -eq 0 ] || rc=1
done
exit "$rc"

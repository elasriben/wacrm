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

rc=0
KEEP_DB=1 bash "$ROOT/supabase/tests/run.sh" || rc=$?
[ "$rc" -eq 2 ] && exit 2

# Idempotence : chaque migration OraLink doit pouvoir être rejouée sur une base où elle est déjà appliquée.
echo "== Idempotence des migrations 9NN_oralink_*"
IDEM_ERR="$(mktemp)"
for f in "$ROOT"/supabase/migrations/9[0-9][0-9]_oralink_*.sql; do
  if PGOPTIONS='-c client_min_messages=warning' psql -X -q -v ON_ERROR_STOP=1 -d "$TEST_DB" -f "$f" >/dev/null 2>"$IDEM_ERR"; then
    echo "  PASS | rejeu sans erreur : $(basename "$f")"
  else
    echo "  FAIL | rejeu en erreur : $(basename "$f")"; head -3 "$IDEM_ERR" | sed 's/^/    /'; rc=1
  fi
done
rm -f "$IDEM_ERR"

echo "== Cas OraLink CRM (isolation-cases.sql)"
OUT="$(mktemp)"
PGOPTIONS='-c client_min_messages=warning' psql -X -At -F ' | ' -d "$TEST_DB" -f "$HERE/isolation-cases.sql" >"$OUT" 2>"$OUT.err" || true
grep -E '^(PASS|FAIL) \|' "$OUT" | sort | sed 's/^/  /'
SUMMARY="$(grep -E '^SUMMARY' "$OUT" || true)"
psql -d postgres -qc "DROP DATABASE IF EXISTS \"$TEST_DB\"" || true
[ -z "$SUMMARY" ] && { echo "Aucun résumé :"; head -20 "$OUT.err"; exit 2; }
echo "== ORALINK $SUMMARY"
grep -q ' fail=0$' <<<"$SUMMARY" || rc=1
exit "$rc"

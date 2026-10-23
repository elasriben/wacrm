#!/usr/bin/env bash
# Rejoue toutes les migrations sur une base JETABLE puis exécute les tests d'isolation.
#
#   PGUSER=<superuser> PGHOST=127.0.0.1 PGPORT=5432 ./supabase/tests/run.sh
#   ./supabase/tests/run.sh --docker          # démarre un PostgreSQL jetable dans Docker
#
# Variables : PGHOST (défaut 127.0.0.1) PGPORT PGUSER PGPASSWORD · TEST_DB (défaut wacrm_isolation_test, doit finir par _test)
#             MIGRATIONS_DIR (défaut supabase/migrations) · KEEP_DB=1 pour conserver la base après le test.
# Code de sortie : 0 si tous les contrôles passent, 1 sinon, 2 en cas d'erreur d'environnement.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$HERE/../migrations}"
TEST_DB="${TEST_DB:-wacrm_isolation_test}"
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}" PGOPTIONS='-c client_min_messages=warning'

CONTAINER=""
cleanup() { [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ "${1:-}" = "--docker" ]; then
  command -v docker >/dev/null || { echo "docker introuvable" >&2; exit 2; }
  PGPASSWORD="$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"; export PGPASSWORD PGUSER=postgres PGHOST=127.0.0.1
  PGPORT="$(shuf -i 20000-40000 -n 1)"; export PGPORT
  CONTAINER="wacrm-isolation-$$"
  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD="$PGPASSWORD" -p "127.0.0.1:$PGPORT:5432" postgres:17 >/dev/null
  for _ in $(seq 1 40); do pg_isready -q -h 127.0.0.1 -p "$PGPORT" && break; sleep 1; done
fi

# --- garde-fous : on ne détruit jamais autre chose qu'une base de test locale ---
case "$PGHOST" in 127.0.0.1|localhost|::1|/*) ;; *) echo "REFUS : PGHOST=$PGHOST n'est pas local." >&2; exit 2;; esac
[[ "$TEST_DB" =~ ^[a-z0-9_]+_test$ ]] || { echo "REFUS : TEST_DB doit se terminer par _test." >&2; exit 2; }
command -v psql >/dev/null || { echo "psql introuvable" >&2; exit 2; }
[ -d "$MIGRATIONS_DIR" ] || { echo "Dossier de migrations introuvable : $MIGRATIONS_DIR" >&2; exit 2; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"; cleanup' EXIT
cp "$MIGRATIONS_DIR"/*.sql "$WORK"/

# pgvector absent (PostgreSQL ordinaire) : copie de test sans la base de connaissances IA (hors périmètre de l'isolation)
HAS_VECTOR="$(psql -d postgres -Atc "select count(*) from pg_available_extensions where name='vector'")"
if [ "$HAS_VECTOR" = "0" ]; then
  command -v perl >/dev/null || { echo "perl requis pour neutraliser pgvector" >&2; exit 2; }
  for f in "$WORK"/*.sql; do
    if grep -qE 'vector|<=>' "$f"; then
      perl -0pi -e 's/create extension if not exists vector[^;]*;//gi; s/CREATE INDEX[^;]*hnsw[^;]*;//gis; s/vector\(1536\)/text/g; s/::vector/::text/g; s/\w+\.embedding\s*<=>\s*\w+(::text)?/0.0::float8/g' "$f"
      echo "  (pgvector absent : $(basename "$f") neutralisé dans la copie de test)"
    fi
  done
fi

echo "== Base jetable : $TEST_DB sur $PGHOST:$PGPORT"
psql -d postgres -qc "DROP DATABASE IF EXISTS \"$TEST_DB\"" -c "CREATE DATABASE \"$TEST_DB\""
export PGDATABASE="$TEST_DB"
psql -q -v ON_ERROR_STOP=1 -f "$HERE/standalone-bootstrap.sql"
for f in "$WORK"/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -f "$f" >"$WORK/out.log" 2>&1 || { echo "ÉCHEC migration $(basename "$f")"; grep -iE 'error|detail' "$WORK/out.log" | head -5; exit 2; }
done
echo "== $(ls "$WORK"/*.sql | wc -l) migrations appliquées"
[ -f "$HERE/../ci/verify-schema.sql" ] && psql -q -v ON_ERROR_STOP=1 -f "$HERE/../ci/verify-schema.sql" && echo "== verify-schema.sql : OK"

echo "== Tests d'isolation"
# Chaque fichier produit ses lignes PASS/FAIL et sa propre ligne SUMMARY ; un fichier sans
# résumé (script cassé) est une erreur d'environnement, pas un succès silencieux.
TOTAL_PASS=0; TOTAL_FAIL=0
for T in isolation.sql rls-coverage.sql; do
  OUT="$WORK/result-$T.txt"
  psql -X -At -F ' | ' -f "$HERE/$T" >"$OUT" 2>"$WORK/err-$T.txt" || true
  grep -E '^(PASS|FAIL) \|' "$OUT" | sort | sed 's/^/  /'
  S="$(grep -E '^SUMMARY pass=[0-9]+ fail=[0-9]+$' "$OUT" || true)"
  [ -z "$S" ] && { echo "Aucun résumé pour $T : le script de test a échoué."; head -20 "$WORK/err-$T.txt"; exit 2; }
  echo "   ($T : ${S#SUMMARY })"
  P="${S#SUMMARY pass=}"; P="${P%% *}"; F="${S##* fail=}"
  TOTAL_PASS=$((TOTAL_PASS + P)); TOTAL_FAIL=$((TOTAL_FAIL + F))
done
SUMMARY="SUMMARY pass=$TOTAL_PASS fail=$TOTAL_FAIL"
echo "== $SUMMARY"
[ "${KEEP_DB:-0}" = "1" ] || psql -d postgres -qc "DROP DATABASE IF EXISTS \"$TEST_DB\"" || true
[ "$TOTAL_FAIL" -eq 0 ]

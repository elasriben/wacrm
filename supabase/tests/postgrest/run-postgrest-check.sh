#!/usr/bin/env bash
# OL-11 — vérifie sur un VRAI PostgREST jetable que la mise à jour des statuts de
# broadcast_recipients, faite avec la clé service_role (RLS contournée), n'atteint que le
# compte résolu quand elle est filtrée par `broadcasts!inner(account_id)` puis par id.
#
#   ./supabase/tests/postgrest/run-postgrest-check.sh
#
# Prérequis : docker, curl, openssl. Tout tourne dans deux conteneurs jetables (--rm) :
#   oralink-qa-pgrst-pg-<pid>   postgres:17 (migrations du dépôt via supabase/tests/run.sh)
#   oralink-qa-pgrst-api-<pid>  PostgREST, partage l'espace réseau du premier
# Aucune donnée ni aucun secret réels : mot de passe et secret JWT aléatoires (préfixe ci-dummy-),
# numéros +1555555010x (plage fictive), identifiants wamid.ci-dummy-*.
# Sortie : une ligne `CHECK <nom> OK|FAIL <détail>` par contrôle, puis `SUMMARY ok=<n> fail=<n>`.
# Code de sortie : 0 tout passe · 1 au moins un FAIL · 2 erreur d'environnement.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash (Windows) : ne pas réécrire les chemins passés à docker

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
REPO_MOUNT="$(cd "$ROOT" && (pwd -W 2>/dev/null || pwd))"

# Images épinglées par digest (surcharge possible pour tester une autre version).
PG_IMAGE="${PG_IMAGE:-postgres:17@sha256:a63c1ea3f6a3a5a1621f97d2aba3b30faecfab4224c1b0000cc85ced57bb1939}"
PGRST_IMAGE="${PGRST_IMAGE:-postgrest/postgrest:v12.2.12@sha256:5f4ce744539bbba786b4e24dbbd95bdb2a956dcf568c5374995a0ff4a68f5bd2}"
DB="wacrm_pgrst_test"

for t in docker curl openssl shuf; do command -v "$t" >/dev/null || { echo "$t introuvable" >&2; exit 2; }; done

rand() { openssl rand -hex "$1"; }
PG_PW="ci-dummy-pg-$(rand 8)"
AUTH_PW="ci-dummy-auth-$(rand 8)"
JWT_SECRET="ci-dummy-jwt-secret-$(rand 16)"
PORT="$(shuf -i 20000-40000 -n 1)"
PG_C="oralink-qa-pgrst-pg-$$"
API_C="oralink-qa-pgrst-api-$$"
BASE="http://127.0.0.1:$PORT"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$API_C" "$PG_C" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
die() { echo "ERREUR ENVIRONNEMENT : $*" >&2; exit 2; }

# ---------------------------------------------------------------- base + migrations
docker run -d --rm --name "$PG_C" --memory=1g -p "127.0.0.1:$PORT:3000" \
  -e POSTGRES_PASSWORD="$PG_PW" -v "$REPO_MOUNT:/repo:ro" "$PG_IMAGE" >/dev/null || die "démarrage postgres"
ready=0
for _ in $(seq 1 60); do
  docker exec "$PG_C" pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null && { ready=1; break; }
  sleep 1
done
[ "$ready" = 1 ] || die "postgres pas prêt"

# Réutilise le rejeu de run.sh (bootstrap Supabase minimal + toutes les migrations + isolation),
# en gardant la base. Un échec ici n'est pas un résultat OL-11 : code 2.
if ! docker exec -e PGHOST=127.0.0.1 -e PGUSER=postgres -e PGPASSWORD="$PG_PW" -e TEST_DB="$DB" -e KEEP_DB=1 \
     "$PG_C" bash /repo/supabase/tests/run.sh >"$WORK/run.log" 2>&1; then
  tail -20 "$WORK/run.log" >&2; die "supabase/tests/run.sh a échoué"
fi
echo "== $(grep -E '^== [0-9]+ migrations' "$WORK/run.log" | sed 's/^== //') ; $(grep -E '^== SUMMARY' "$WORK/run.log" | sed 's/^== //') (isolation)"

sql() { docker exec -i "$PG_C" psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d "$DB" "$@"; }

# Identifiants fixes (préfixes c0/d0 : distincts de ceux d'isolation.sql).
UA=c0000000-0000-0000-0000-000000000001; UB=d0000000-0000-0000-0000-000000000001
RA1=c1000000-0000-0000-0000-000000000001; RA2=c1000000-0000-0000-0000-000000000002; RA3=c1000000-0000-0000-0000-000000000003
RB1=d1000000-0000-0000-0000-000000000001; RB3=d1000000-0000-0000-0000-000000000003
WA1=wamid.ci-dummy-A-1; WA2=wamid.ci-dummy-A-2; WB1=wamid.ci-dummy-B-1; WSHARED=wamid.ci-dummy-shared

sql >/dev/null <<SQL || die "seed"
ALTER ROLE authenticator PASSWORD '$AUTH_PW';
INSERT INTO auth.users(id,email) VALUES ('$UA','ol11-a@test.local'),('$UB','ol11-b@test.local');
DO \$\$ DECLARE a uuid; b uuid; ca uuid; cb uuid; ba uuid; bb uuid;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id='$UA';
  SELECT account_id INTO b FROM public.profiles WHERE user_id='$UB';
  INSERT INTO contacts(user_id,phone,account_id,name) VALUES ('$UA','+15555550100',a,'OL11 A') RETURNING id INTO ca;
  INSERT INTO contacts(user_id,phone,account_id,name) VALUES ('$UB','+15555550101',b,'OL11 B') RETURNING id INTO cb;
  INSERT INTO broadcasts(user_id,name,template_name,account_id,status) VALUES ('$UA','ol11-A','tpl',a,'sent') RETURNING id INTO ba;
  INSERT INTO broadcasts(user_id,name,template_name,account_id,status) VALUES ('$UB','ol11-B','tpl',b,'sent') RETURNING id INTO bb;
  INSERT INTO broadcast_recipients(id,broadcast_id,contact_id,status,whatsapp_message_id) VALUES
    ('$RA1',ba,ca,'sent','$WA1'), ('$RA2',ba,ca,'sent','$WA2'), ('$RB1',bb,cb,'sent','$WB1');
END \$\$;
SQL
ACC_A="$(sql -c "SELECT account_id FROM public.profiles WHERE user_id='$UA'")"
ACC_B="$(sql -c "SELECT account_id FROM public.profiles WHERE user_id='$UB'")"
if [ -z "$ACC_A" ] || [ -z "$ACC_B" ] || [ "$ACC_A" = "$ACC_B" ]; then die "comptes A/B introuvables"; fi

# ---------------------------------------------------------------- PostgREST + jeton service_role
docker run -d --rm --name "$API_C" --memory=256m --network "container:$PG_C" \
  -e PGRST_DB_URI="postgres://authenticator:$AUTH_PW@127.0.0.1:5432/$DB" \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -e PGRST_SERVER_PORT=3000 "$PGRST_IMAGE" >/dev/null || die "démarrage PostgREST"
ready=0
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/" || true)" = 200 ] && { ready=1; break; }
  sleep 1
done
[ "$ready" = 1 ] || { docker logs "$API_C" 2>&1 | tail -10 >&2; die "PostgREST pas prêt"; }

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
JWT_H="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)"
JWT_P="$(printf '%s' '{"role":"service_role"}' | b64url)"
JWT_S="$(printf '%s' "$JWT_H.$JWT_P" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)"
TOKEN="$JWT_H.$JWT_P.$JWT_S"

# http METHOD PATH [JSON] -> corps dans $WORK/body, code HTTP dans $CODE
# (corps via stdout plutôt que `curl -o` : un curl Windows natif ne comprend pas les chemins /tmp)
http() {
  local args=(-s -w '\n%{http_code}' -X "$1" -H "Authorization: Bearer $TOKEN"
              -H 'Prefer: return=representation' -H 'Content-Type: application/json')
  [ $# -ge 3 ] && args+=(--data "$3")
  local out
  out="$(curl "${args[@]}" "$BASE$2")" || out=$'\n000'
  CODE="${out##*$'\n'}"
  printf '%s' "${out%$'\n'*}" >"$WORK/body"
}
rows() { { grep -o '"id":"[0-9a-f-]*"' "$WORK/body" || true; } | sed 's/"id":"//; s/"$//' | sort | tr '\n' ' ' | sed 's/ $//'; }
status_of() { sql -c "SELECT status FROM broadcast_recipients WHERE id='$1'"; }

OK=0; FAIL=0
check() { # check <nom> <condition 0/1> <détail>
  if [ "$2" = 1 ]; then echo "CHECK $1 OK $3"; OK=$((OK + 1)); else echo "CHECK $1 FAIL $3"; FAIL=$((FAIL + 1)); fi
}
is() { [ "$1" = "$2" ] && echo 1 || echo 0; }

PRED='status=in.(pending,sent)'   # allowedPredecessors('delivered')
SEL="select=id,broadcasts!inner(account_id)"
PATCH_BODY='{"status":"delivered","delivered_at":"2026-01-01T00:00:00Z"}'

# --- témoin : la clé service_role contourne la RLS (sans filtre, A et B sont visibles)
http GET "/broadcast_recipients?select=id&id=in.($RA1,$RB1)"
check service_role_bypasses_rls "$(is "$CODE $(rows)" "200 $RA1 $RB1")" "http=$CODE rows=[$(rows)]"

# --- 1. lecture filtrée par compte
http GET "/broadcast_recipients?$SEL&whatsapp_message_id=eq.$WB1&broadcasts.account_id=eq.$ACC_A&$PRED"
check read_A_filter_hides_B_wamid "$(is "$CODE $(rows)" "200 ")" "http=$CODE rows=[$(rows)]"
http GET "/broadcast_recipients?$SEL&whatsapp_message_id=eq.$WA1&broadcasts.account_id=eq.$ACC_A&$PRED"
check read_A_filter_finds_A_row "$(is "$CODE $(rows)" "200 $RA1")" "http=$CODE rows=[$(rows)]"
http GET "/broadcast_recipients?$SEL&whatsapp_message_id=eq.$WA1&broadcasts.account_id=eq.$ACC_B&$PRED"
check read_B_filter_hides_A_wamid "$(is "$CODE $(rows)" "200 ")" "http=$CODE rows=[$(rows)]"
# témoin négatif du `!inner` : sans lui, le filtre sur l'embarqué ne filtre PAS la ligne parente
# (la ligne de B revient, avec broadcasts=null). Le correctif doit garder `!inner`.
http GET "/broadcast_recipients?select=id,broadcasts(account_id)&whatsapp_message_id=eq.$WB1&broadcasts.account_id=eq.$ACC_A&$PRED"
check negative_control_without_inner_returns_B "$(is "$CODE $(rows)" "200 $RB1")" "http=$CODE rows=[$(rows)]"

# --- 2. PATCH par id + prédécesseurs : seules les lignes lues (compte A) changent
http GET "/broadcast_recipients?$SEL&whatsapp_message_id=eq.$WA1&broadcasts.account_id=eq.$ACC_A&$PRED"
IDS="$(rows | tr ' ' ',')"
http PATCH "/broadcast_recipients?id=in.($IDS)&$PRED" "$PATCH_BODY"
check patch_by_ids_updates_A "$(is "$CODE $(rows) $(status_of "$RA1")" "200 $RA1 delivered")" "http=$CODE rows=[$(rows)] A1=$(status_of "$RA1")"
check patch_by_ids_leaves_B "$(is "$(status_of "$RB1")" sent)" "B1=$(status_of "$RB1")"

# --- 3. concurrence : le statut change entre la lecture et le PATCH -> rien n'est écrit
http GET "/broadcast_recipients?$SEL&whatsapp_message_id=eq.$WA2&broadcasts.account_id=eq.$ACC_A&$PRED"
IDS="$(rows | tr ' ' ',')"
sql -c "UPDATE broadcast_recipients SET status='read' WHERE id='$RA2'" >/dev/null
http PATCH "/broadcast_recipients?id=in.($IDS)&$PRED" "$PATCH_BODY"
check patch_race_status_changed_noop "$(is "$IDS $CODE $(rows) $(status_of "$RA2")" "$RA2 200  read")" "ids=[$IDS] http=$CODE rows=[$(rows)] A2=$(status_of "$RA2")"

# --- 4. unicité réelle : le même wamid ne peut pas exister dans A et dans B
dup="$(sql -c "INSERT INTO broadcast_recipients(broadcast_id,contact_id,status,whatsapp_message_id)
               SELECT broadcast_id,contact_id,'sent','$WB1' FROM broadcast_recipients WHERE id='$RA1'" 2>&1 || true)"
check schema_wamid_unique_across_accounts "$(grep -q 'idx_broadcast_recipients_wamid' <<<"$dup" && echo 1 || echo 0)" "$(head -1 <<<"$dup" | cut -c1-90)"

# --- 5. témoin négatif : la requête actuelle (sans filtre de compte) modifie la ligne de B
http PATCH "/broadcast_recipients?whatsapp_message_id=eq.$WB1&$PRED" "$PATCH_BODY"
check negative_control_unfiltered_patch_hits_B "$(is "$CODE $(rows) $(status_of "$RB1")" "200 $RB1 delivered")" "http=$CODE rows=[$(rows)] B1=$(status_of "$RB1")"

# --- 6. schéma HYPOTHÉTIQUE sans l'index unique : même wamid dans A et B
# (protège le correctif si l'index disparaît un jour ; base jetable uniquement)
sql >/dev/null <<SQL || die "schéma hypothétique"
DROP INDEX idx_broadcast_recipients_wamid;
INSERT INTO broadcast_recipients(id,broadcast_id,contact_id,status,whatsapp_message_id)
  SELECT '$RA3',broadcast_id,contact_id,'sent','$WSHARED' FROM broadcast_recipients WHERE id='$RA1';
INSERT INTO broadcast_recipients(id,broadcast_id,contact_id,status,whatsapp_message_id)
  SELECT '$RB3',broadcast_id,contact_id,'sent','$WSHARED' FROM broadcast_recipients WHERE id='$RB1';
SQL
http GET "/broadcast_recipients?$SEL&whatsapp_message_id=eq.$WSHARED&broadcasts.account_id=eq.$ACC_A&$PRED"
check shared_wamid_read_A_only "$(is "$CODE $(rows)" "200 $RA3")" "http=$CODE rows=[$(rows)]"
IDS="$(rows | tr ' ' ',')"
http PATCH "/broadcast_recipients?id=in.($IDS)&$PRED" "$PATCH_BODY"
check shared_wamid_patch_A_only "$(is "$CODE $(rows) $(status_of "$RA3") $(status_of "$RB3")" "200 $RA3 delivered sent")" "http=$CODE rows=[$(rows)] A3=$(status_of "$RA3") B3=$(status_of "$RB3")"
sql -c "UPDATE broadcast_recipients SET status='sent' WHERE id='$RA3'" >/dev/null
http PATCH "/broadcast_recipients?whatsapp_message_id=eq.$WSHARED&$PRED" "$PATCH_BODY"
check shared_wamid_negative_control_hits_both "$(is "$CODE $(rows)" "200 $(printf '%s\n' "$RA3" "$RB3" | sort | tr '\n' ' ' | sed 's/ $//')")" "http=$CODE rows=[$(rows)]"

echo "SUMMARY ok=$OK fail=$FAIL"
[ "$FAIL" -eq 0 ]

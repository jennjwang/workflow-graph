#!/usr/bin/env bash
# Smoke-test the task-bank API endpoints end to end. Boots the server on an ephemeral port
# against the DATABASE_URL you pass, exercises both endpoints, and asserts the results.
#
# SAFETY: the endpoints WRITE rows. Point DATABASE_URL at a THROWAWAY Neon branch, never prod.
#   (e.g.  npx neonctl branches create --name api-test  → use its connection string)
#
# Usage:
#   DATABASE_URL='postgresql://…neon.tech/neondb?sslmode=require' ./test_api.sh
set -uo pipefail

: "${DATABASE_URL:?set DATABASE_URL to a TEST branch connection string}"
PORT="${PORT:-3019}"
OCC="${TASK_BANK_OCC:-15-1252}"
BASE="http://localhost:${PORT}"
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

echo "Booting server on :${PORT} (occupation ${OCC})…"
PORT="$PORT" DATABASE_URL="$DATABASE_URL" TASK_BANK_OCC="$OCC" \
  node --env-file=.env server.js > /tmp/test_api_server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s "$BASE/" >/dev/null 2>&1 && break; sleep 0.5; done
grep -q '\[taskBank\] enabled' /tmp/test_api_server.log \
  && ok "server booted, taskBank enabled" || { no "taskBank did not enable (see /tmp/test_api_server.log)"; cat /tmp/test_api_server.log; exit 1; }

echo "1) POST /api/generate-tasks-stream"
PROFILE='{"jobTitle":"Backend engineer","typicalWeek":"build REST APIs, fix incidents, code review","responsibilities":"design and maintain backend services and APIs","aiUsage":"use AI assistants daily","priorTasks":[],"interviewTasks":[]}'
curl -sN -X POST "$BASE/api/generate-tasks-stream" -H 'Content-Type: application/json' -d "$PROFILE" --max-time 60 > /tmp/test_api_stream.out
N_TASK=$(grep -c 'event: task' /tmp/test_api_stream.out)
N_ID=$(grep -c '"id"' /tmp/test_api_stream.out)
grep -q '"source":"bank"' /tmp/test_api_stream.out && ok "served from BANK (not LLM generation)" || no "done event missing source:bank"
[ "$N_TASK" -gt 0 ] && ok "$N_TASK tasks streamed" || no "no tasks streamed"
[ "$N_TASK" = "$N_ID" ] && ok "every task carries a bank id" || no "id missing on some tasks ($N_ID/$N_TASK)"
TID=$(grep -o '"id":"[^"]*"' /tmp/test_api_stream.out | head -1 | cut -d'"' -f4)

echo "2) POST /api/task-response (confirm / deny / bad input)"
P="apitest_$$"
R1=$(curl -s -X POST "$BASE/api/task-response" -H 'Content-Type: application/json' -d "{\"participant\":\"$P\",\"task\":\"$TID\",\"response\":\"confirm\",\"aiExposure\":\"low\"}")
echo "$R1" | grep -q '"ok":true' && ok "confirm recorded ($TID)" || no "confirm failed: $R1"
R2=$(curl -s -X POST "$BASE/api/task-response" -H 'Content-Type: application/json' -d "{\"participant\":\"${P}b\",\"task\":\"$TID\",\"response\":\"deny\"}")
echo "$R2" | grep -q '"ok":true' && ok "deny recorded" || no "deny failed: $R2"
R3=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/task-response" -H 'Content-Type: application/json' -d "{\"participant\":\"x\",\"task\":\"$TID\",\"response\":\"maybe\"}")
[ "$R3" = "400" ] && ok "bad response value rejected (400)" || no "expected 400 for bad input, got $R3"

echo
echo "RESULT: $PASS passed, $FAIL failed"
echo "(verify rows landed:  SELECT * FROM responses WHERE participant LIKE 'apitest_%';)"
[ "$FAIL" = 0 ]

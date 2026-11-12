#!/usr/bin/env bash
# Runs the migrations + SQL safety tests against a throwaway PostgreSQL.
# With real PostGIS available (e.g. docker compose `db`), set USE_POSTGIS=1.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../migrations"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)}"
WORK="$(mktemp -d)"
AS=()
if [[ $EUID -eq 0 ]]; then id postgres >/dev/null 2>&1 || useradd -r postgres; chown postgres "$WORK"; chmod 755 "$WORK"; AS=(runuser -u postgres --); fi
trap '"${AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" stop -m fast >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
"${AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p 54329 -k $WORK -c listen_addresses=''" -l "$WORK/log" start >/dev/null
PSQL=(psql -h "$WORK" -p 54329 -U postgres -v ON_ERROR_STOP=1 -q -X)
"${PSQL[@]}" -c "CREATE DATABASE trades_test" postgres
DB=(-d trades_test)
for f in "$MIG"/*.sql; do
  if [[ "${USE_POSTGIS:-0}" == "1" ]]; then
    "${PSQL[@]}" "${DB[@]}" -f "$f"
  else
    # Strip the postgis extension + geography typmods so the stub domain applies.
    sed -e 's/CREATE EXTENSION IF NOT EXISTS postgis;/\\i '"${HERE//\//\\/}"'\/postgis_stub.sql/' \
        -e 's/GEOGRAPHY(POINT,4326)/geography/g; s/GEOGRAPHY(POLYGON,4326)/geography/g' \
        -e 's/USING GIST/USING btree/g' "$f" > "$WORK/$(basename "$f")"
    "${PSQL[@]}" "${DB[@]}" -f "$WORK/$(basename "$f")"
  fi
  echo "applied $(basename "$f")"
done
"${PSQL[@]}" "${DB[@]}" -f "$HERE/safety_tests.sql"

# ── Concurrency: two workers race to claim the same due payout (SKIP LOCKED) ──
Q=(psql -h "$WORK" -p 54329 -U postgres -d trades_test -X -qAt)
( "${Q[@]}" -c "BEGIN; SELECT 'A:' || count(*) FROM claim_due_payouts(10); SELECT pg_sleep(3); COMMIT;" > "$WORK/a.out" ) &
sleep 1
START=$(date +%s%N)
B=$("${Q[@]}" -c "SELECT 'B:' || count(*) FROM claim_due_payouts(10);")
ELAPSED_MS=$(( ($(date +%s%N) - START) / 1000000 ))
wait
A=$(grep '^A:' "$WORK/a.out")
if [[ "$A" == "A:1" && "$B" == "B:0" && $ELAPSED_MS -lt 1500 ]]; then
  echo "NOTICE:  PASS  concurrent workers: A claimed 1, B claimed 0 without blocking (${ELAPSED_MS}ms)"
else
  echo "FAIL concurrency: $A $B ${ELAPSED_MS}ms"; exit 1
fi
FINAL=$("${Q[@]}" -c "SELECT status FROM payout_records")
[[ "$FINAL" == "processing" ]] && echo "NOTICE:  PASS  payout row is 'processing' exactly once after the race" || { echo "FAIL final status $FINAL"; exit 1; }
echo "ALL SQL SAFETY TESTS PASSED"

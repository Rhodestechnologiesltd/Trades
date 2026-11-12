#!/usr/bin/env bash
# usage: db.sh start|stop  — throwaway PG16 on 127.0.0.1:54330 with migrations applied (PostGIS stub)
set -euo pipefail
# Prefer the docker-compose PostGIS for full fidelity: `docker compose up db` then point E2E_DATABASE_URL at it.
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin | tail -1)}; W=${E2E_PG_DIR:-/tmp/trades-e2e-pg}; HERE="$(cd "$(dirname "$0")" && pwd)"; MIG=$HERE/../../migrations; STUB=$HERE/../sql/postgis_stub.sql
AS=(); if [[ $EUID -eq 0 ]]; then AS=(runuser -u postgres --); fi
if [[ "$1" == "stop" ]]; then ${AS[@]} $PGBIN/pg_ctl -D $W/data stop -m fast -w >/dev/null 2>&1 || true; P=$(pgrep -f "$W/data" || true); [[ -n "$P" ]] && kill $P && sleep 2; rm -rf $W; exit 0; fi
rm -rf $W; mkdir -p $W; [[ $EUID -eq 0 ]] && chown postgres $W
${AS[@]} $PGBIN/initdb -D $W/data -U postgres -A trust >/dev/null
${AS[@]} $PGBIN/pg_ctl -D $W/data -o "-p 54330 -k $W -c listen_addresses=127.0.0.1" -l $W/log start >/dev/null
sleep 1
psql -h 127.0.0.1 -p 54330 -U postgres -qX -c "CREATE DATABASE trades_e2e" postgres
for f in $MIG/*.sql; do
  sed -e "s#CREATE EXTENSION IF NOT EXISTS postgis;#\\\\i $STUB#" -e 's/GEOGRAPHY(POINT,4326)/geography/g; s/GEOGRAPHY(POLYGON,4326)/geography/g; s/USING GIST/USING btree/g' "$f" > $W/$(basename $f)
  psql -h 127.0.0.1 -p 54330 -U postgres -d trades_e2e -qX -v ON_ERROR_STOP=1 -f $W/$(basename $f) >/dev/null
done
echo "db ready"

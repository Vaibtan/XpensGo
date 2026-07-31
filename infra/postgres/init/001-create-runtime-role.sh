#!/bin/sh
set -eu

: "${XPENSEGO_RUNTIME_PASSWORD:?XPENSEGO_RUNTIME_PASSWORD must be set}"

psql \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=runtime_password="$XPENSEGO_RUNTIME_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE xpensego_runtime LOGIN PASSWORD %L',
  :'runtime_password'
)
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = 'xpensego_runtime'
) \gexec
SQL

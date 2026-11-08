#!/bin/sh
# Builds the database URLs from the private PostgreSQL service, applies migrations, starts the API.
set -e
: "${DB_HOST:?DB_HOST missing}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-doc_receptionist}"
export MIGRATION_DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
export DATABASE_URL="postgres://dr_api:${DR_API_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
export API_DB_LOGIN=dr_api
# The private database can take a moment to accept connections after a restart.
for i in 1 2 3 4 5 6 7 8 9 10; do node node_modules/@dr/db/dist/cli-migrate.js && break; echo "migrate: retrying in 5s"; sleep 5; done
export WEB_DIST=/app/web
export RECORDINGS_DIR="${RECORDINGS_DIR:-/data/recordings}"
exec node dist/server.js

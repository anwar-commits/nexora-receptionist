#!/bin/sh
# First start only: the login the API uses. Migrations make it a member of app_api (row-level security applies).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "CREATE ROLE dr_api LOGIN PASSWORD '${DR_API_PASSWORD}'"

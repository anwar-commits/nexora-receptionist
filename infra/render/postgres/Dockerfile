# Private PostgreSQL 16 + pgvector for render.yaml. Data lives on a Render disk.
FROM pgvector/pgvector:pg16
COPY 10-api-login.sh /docker-entrypoint-initdb.d/10-api-login.sh

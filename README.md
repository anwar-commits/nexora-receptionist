# DOC-RECEPTIONIST AI

Multi-tenant healthcare SaaS for Indian clinics, built around a 24/7 AI voice receptionist.
Design, architecture and database plans live in the project docs (Phase 1 and Phase 2); this repository is the code.

**Status: Phase 4 complete** — clinic setup: doctors and weekly hours, leave, services and fees, clinic settings, holidays, and a six-step setup wizard. See [docs/phase-4.md](docs/phase-4.md).

Phase 3 delivered sign-in (password, SMS code, authenticator app), clinics, branches, departments, staff and roles, with tenant isolation enforced by PostgreSQL row-level security ([docs/phase-3.md](docs/phase-3.md)).

## Layout

```
apps/
  api/        Express 5 + TypeScript API (modular monolith)
  web/        React 19 + Vite + Tailwind staff web app
packages/
  db/         SQL migrations (source of truth), migration runner, Sequelize models, tenant context
  contracts/  Zod request schemas and shared types (API, web, later mobile)
infra/docker/ local Postgres init
docs/         phase notes and decision log
```

Coming in later phases: `apps/worker` (BullMQ), `apps/mobile` (Expo), `packages/voice`, `packages/ai`.

## Run it locally

Needs Node 22+, pnpm 10, Docker.

```bash
pnpm install
cp .env.example .env            # then fill JWT_SECRET, DATA_ENCRYPTION_KEY, HASH_PEPPER:
                                #   openssl rand -base64 32   (once for each)
docker compose up -d            # Postgres 16 + pgvector, Redis
pnpm --filter @dr/db build
MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/doc_receptionist API_DB_LOGIN=dr_api pnpm db:migrate
pnpm db:seed:dev                # demo owner (with TOTP secret printed) + receptionist
pnpm --filter @dr/api dev       # http://localhost:4000
pnpm --filter @dr/web dev       # http://localhost:5173
```

The seed prints the owner's email, password and authenticator secret. The receptionist signs in with an SMS code; in development (`SMS_PROVIDER=console`) the code is printed in the API log. The API refuses to start in production until a real SMS provider exists (Phase 13).

## Tests

```bash
pnpm --filter @dr/contracts build && pnpm --filter @dr/db build
TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm --filter @dr/api test
```

Each run creates a throwaway database, applies every migration, and connects as a restricted login so row-level security is exercised for real. 23 tests cover sign-in, lockout, SMS codes, MFA, session rotation, role permissions, cross-clinic isolation at the API and at the database, and the audit log.

## How tenancy works (short version)

- Every clinic table has `organization_id`. The API runs each request in a transaction that sets `app.org_id`; PostgreSQL policies hide and refuse every other clinic's rows.
- The API login is a member of `app_api` and is never superuser or `BYPASSRLS` (the migration runner checks this).
- Clinic routes need `X-Org-Id`; the API checks an active membership there, loads the role's `resource:action` grants and their scope (`org`, `branch`, `own`, `assigned`), and blocks MFA-required roles until the session passed MFA.
- Audit log, consents and data-access logs are insert-only for the API.

More in [docs/decisions.md](docs/decisions.md).

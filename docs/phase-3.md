# Phase 3 — Authentication, multi-tenancy and RBAC

**Done when:** RLS test suite passes; a user can sign in and switch clinics. ✅ Both met (7 Nov 2026).

## Delivered

- [x] Monorepo (pnpm + Turborepo), Docker Compose for Postgres 16 + pgvector and Redis
- [x] Migrations 0001–0003: full Phase 2 schema (78 tables), DB roles and grants, 25 permissions, 7 built-in roles
- [x] Migration runner that refuses an API login with superuser or BYPASSRLS
- [x] Sequelize models for identity and tenancy; `withContext()` sets tenant context per transaction
- [x] Sign-up, password sign-in with lockout, SMS one-time code sign-in, TOTP enrolment and verification
- [x] Rotating refresh tokens, sign-out, `GET /v1/me` with clinic list
- [x] `X-Org-Id` clinic selection, membership check, permission grants with scopes, MFA enforcement per role
- [x] Clinics: create (creator becomes owner, first branch created), view, edit
- [x] Branches (branch-scoped for branch managers and receptionists), departments, roles list
- [x] Staff: invite by email or mobile, activate on first sign-in, change role/branches, suspend; owner safeguards
- [x] Audit log for every change, insert-only for the API
- [x] Web: sign-in (password / SMS), authenticator setup with QR, verification, sign-up, create clinic, clinic switcher, role-aware home
- [x] Dev seed through the real API
- [x] 23 integration tests against real PostgreSQL; CI workflow

## Endpoints

| Method | Path | Permission |
| --- | --- | --- |
| POST | /v1/auth/register, /login, /otp, /otp/verify, /mfa/verify, /mfa/enroll/start, /mfa/enroll/confirm, /refresh | public (rate-limited) |
| POST | /v1/auth/logout | signed in |
| GET | /v1/me | signed in |
| POST | /v1/organizations | signed in |
| GET / PATCH | /v1/organizations/current | org:read / org:update |
| GET / POST / PATCH | /v1/branches, /v1/branches/:id | branch:read / branch:manage |
| GET / POST | /v1/departments | org:read / department:manage |
| GET | /v1/roles | role:read |
| GET / POST / PATCH | /v1/members, /v1/members/:id | member:read / member:manage |
| GET | /v1/audit | audit:read |

## Verified by hand (headless Chrome, 7 Nov)

Owner signs in with password + authenticator code → sees clinic, branches, team, permissions → creates a second clinic → switches between clinics. Receptionist signs in with an SMS code → sees only their branch and their 13 permissions.

Two bugs found this way and fixed, each with a test: an owner of two clinics saw the other clinic's memberships in the team list (and the last-owner check counted them); the clinic picker did not re-render on a first sign-in.

## Not in this phase (by plan)

Onboarding steps 2–6 and settings screens (Phase 4), invitation messages (Phase 7), real SMS provider (Phase 13), backup codes, refresh-token reuse detection and httpOnly cookie for web (Phase 15), mobile app (Phases 11–12).

# Technical decision log

Newest first. Phase 1 and 2 decisions are in the Phase 2 architecture doc; these are the ones made while building.

| Date | Decision | Why | Revisit |
| --- | --- | --- | --- |
| 2026-11-07 | New repo, separate from `nexgen-receptionist` | Owner decision. NexGen keeps running untouched and becomes tenant #1 later | Migration of NexGen data in Phase 8–9 |
| 2026-11-07 | Sequelize for models and queries; migrations as plain SQL files run by our own runner | Owner chose Sequelize (per brief). RLS policies, exclusion constraints and grants are clearer and safer in SQL than in an ORM DSL | — |
| 2026-11-07 | Sequelize with CLS (`cls-hooked`): queries inside `withContext()` join its transaction automatically | A forgotten `{ transaction }` would run without tenant context; with CLS it cannot | If Sequelize v7 drops CLS, switch to explicit transactions + lint rule |
| 2026-11-07 | `app.user_id` context plus `member_self_read` and `role_of_own_membership` policies | The clinic switcher must list a user's memberships across clinics before a clinic is chosen. **Consequence:** membership queries in a clinic must also filter by `organization_id` (a test covers this) | — |
| 2026-11-07 | RLS policies read `NULLIF(current_setting('app.org_id', true), '')::uuid` | After a transaction ends the setting is `''`, and `''::uuid` would error; empty now means "no clinic", which matches no rows | — |
| 2026-11-07 | Invitations activate when the invited person signs in | Proves they control the phone/email; no separate acceptance link needed yet | Invitation messages (SMS/WhatsApp) in Phase 7 |
| 2026-11-07 | MFA (TOTP) required for owner, branch manager, doctor, AI operations and platform admins; enforced per request at clinic selection | Those roles can see patient data or change the AI; enforcing at `requireOrg` also covers someone who becomes an owner mid-session | Backup codes in Phase 15 |
| 2026-11-07 | Access token 15 min (JWT, HS256) + rotating refresh token (30 days, only its SHA-256 stored) | Short exposure window; a stolen refresh token stops working after the next legitimate refresh | Reuse detection (token families) in Phase 15 |
| 2026-11-07 | Web keeps the refresh token in `localStorage` for now | Simple and works with the bearer API; XSS exposure is the trade-off | Move to an httpOnly, SameSite=strict cookie with CSRF protection in Phase 15 |
| 2026-11-07 | Account lock: 5 wrong passwords → 15 minutes; SMS codes: 5 per number per 15 min, 5 attempts per code, 5-minute expiry | Slows guessing without locking people out of SMS sign-in | Tune with real traffic |
| 2026-11-07 | API refuses to start in production with the console/memory SMS provider | Prevents shipping a build that prints one-time codes to logs | Phase 13 adds a DLT-registered SMS provider |
| 2026-11-07 | Organizations table has no RLS (it has no `organization_id`); API only reads it for clinics the user belongs to | It is the tenant root and holds no patient data | — |

-- Migration 0002: database roles, grants and the extra read policies identity needs.

-- app_api: the role every API and worker login belongs to. Never superuser, never BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_api') THEN
    CREATE ROLE app_api NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA app TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO app_api;

-- Ledgers keep history: the API may add rows and read them, never change or remove them.
REVOKE UPDATE, DELETE ON app.audit_logs, app.data_access_logs, app.consents, app.lead_events FROM app_api;

-- Built-in roles and the permission catalogue are platform data, changed only by migrations.
REVOKE INSERT, UPDATE, DELETE ON app.permissions FROM app_api;

-- A signed-in user can list their own memberships in every clinic (for the clinic switcher)
-- before choosing one. Writes stay limited to the current clinic by tenant_isolation.
CREATE POLICY member_self_read ON app.memberships
  FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- ...and the role attached to each of those memberships.
CREATE POLICY role_of_own_membership ON app.roles
  FOR SELECT
  USING (id IN (
    SELECT m.role_id FROM app.memberships m
    WHERE m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  ));

-- Login throttling needs a failed-attempt counter on users.
ALTER TABLE app.users
  ADD COLUMN failed_login_count int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz;

-- Sessions: which clinic was last used, and whether the session finished MFA.
ALTER TABLE app.sessions
  ADD COLUMN last_organization_id uuid REFERENCES app.organizations(id),
  ADD COLUMN mfa_verified_at timestamptz;

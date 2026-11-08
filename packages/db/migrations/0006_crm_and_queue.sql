-- Migration 0006: CRM (leads, scoring, tasks, consents) and queue tokens.

-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------
INSERT INTO app.permissions (key, description) VALUES
  ('lead:read', 'View the patient pipeline');

INSERT INTO app.role_permissions (role_id, permission_key, scope, limit_value) VALUES
  ('00000000-0000-4000-8000-000000000001', 'lead:read', 'org', NULL),
  ('00000000-0000-4000-8000-000000000002', 'lead:read', 'branch', NULL),
  ('00000000-0000-4000-8000-000000000004', 'lead:read', 'branch', NULL),
  ('00000000-0000-4000-8000-000000000005', 'lead:read', 'assigned', NULL);

-- ---------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------
ALTER TABLE app.leads
  ADD COLUMN phone_e164_enc bytea,                       -- staff need to call the lead back
  ADD COLUMN branch_id uuid REFERENCES app.branches(id),  -- NULL = clinic-wide (e.g. ads)
  ADD COLUMN wants_visit_by date,
  ADD COLUMN created_by uuid REFERENCES app.users(id),
  ADD CONSTRAINT lead_owner_consistent CHECK ((owner_kind = 'user') = (owner_user_id IS NOT NULL)),
  ADD CONSTRAINT lost_needs_reason CHECK (stage <> 'lost' OR lost_reason IS NOT NULL),
  ADD CONSTRAINT lead_has_identity CHECK (display_name IS NOT NULL OR phone_hash IS NOT NULL);
CREATE INDEX ON app.leads (organization_id, patient_id);

ALTER TABLE app.lead_events
  ADD COLUMN note text CHECK (note IS NULL OR length(note) <= 2000);

-- ---------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------
ALTER TABLE app.tasks
  ADD COLUMN created_by_user uuid REFERENCES app.users(id),
  ADD COLUMN completed_by uuid REFERENCES app.users(id),
  ADD COLUMN notes text,
  ADD CONSTRAINT task_assignee_ref CHECK (assignee_kind = 'ai_agent' OR assignee_ref IS NOT NULL),
  ADD CONSTRAINT task_related_kind CHECK (related_type IS NULL OR related_type IN ('lead','patient','appointment','call'));
CREATE INDEX ON app.tasks (organization_id, assignee_kind, assignee_ref, status);
CREATE INDEX ON app.tasks (related_type, related_id);

-- ---------------------------------------------------------------------
-- Consents: who recorded it is required for staff entries
-- ---------------------------------------------------------------------
ALTER TABLE app.consents
  ADD CONSTRAINT staff_consent_has_recorder CHECK (captured_via NOT IN ('in_clinic','web') OR recorded_by_user IS NOT NULL);

-- ---------------------------------------------------------------------
-- Queue tokens
-- ---------------------------------------------------------------------
ALTER TABLE app.queue_tokens
  ADD COLUMN called_at timestamptz,
  ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX queue_one_token_per_appointment ON app.queue_tokens (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX ON app.queue_tokens (branch_id, service_date, doctor_id, position);

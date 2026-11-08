-- Migration 0004: clinic setup (Phase 4) — doctors, hours, services and fees, settings, onboarding.

-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------
INSERT INTO app.permissions (key, description) VALUES
  ('doctor:manage', 'Add, edit and remove doctors and the services they offer'),
  ('schedule:manage', 'Edit doctor weekly hours and leave'),
  ('service:manage', 'Edit services and fees');

INSERT INTO app.role_permissions (role_id, permission_key, scope, limit_value) VALUES
  ('00000000-0000-4000-8000-000000000001', 'doctor:manage', 'org', NULL),
  ('00000000-0000-4000-8000-000000000001', 'schedule:manage', 'org', NULL),
  ('00000000-0000-4000-8000-000000000001', 'service:manage', 'org', NULL),
  -- branch managers edit hours and leave for the sessions at their branches
  ('00000000-0000-4000-8000-000000000002', 'schedule:manage', 'branch', NULL),
  -- doctors edit their own hours and leave
  ('00000000-0000-4000-8000-000000000003', 'schedule:manage', 'own', NULL);

-- ---------------------------------------------------------------------
-- Settings and onboarding
-- ---------------------------------------------------------------------
ALTER TABLE app.organization_settings
  ADD COLUMN free_cancellation_hours int NOT NULL DEFAULT 4 CHECK (free_cancellation_hours BETWEEN 0 AND 168),
  ADD COLUMN phone_setup_choice text CHECK (phone_setup_choice IN ('forward_existing','new_number','later')),
  ADD COLUMN onboarding_completed_at timestamptz,
  ADD COLUMN onboarding_completed_by uuid REFERENCES app.users(id),
  ADD CONSTRAINT outbound_window_valid CHECK (outbound_end_local > outbound_start_local),
  ADD CONSTRAINT pickup_seconds_valid CHECK (ai_pickup_after_seconds BETWEEN 5 AND 90);

-- ---------------------------------------------------------------------
-- Doctors, services, hours: sanity limits the API also checks
-- ---------------------------------------------------------------------
ALTER TABLE app.doctors
  ADD CONSTRAINT slot_minutes_valid CHECK (slot_minutes BETWEEN 5 AND 240),
  ADD CONSTRAINT buffer_minutes_valid CHECK (buffer_minutes BETWEEN 0 AND 120),
  ADD CONSTRAINT max_online_valid CHECK (max_online_per_day IS NULL OR max_online_per_day >= 0);
-- One doctor profile per staff account in a clinic.
CREATE UNIQUE INDEX doctors_one_profile_per_user ON app.doctors (organization_id, user_id)
  WHERE user_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE app.services
  ADD CONSTRAINT duration_valid CHECK (duration_minutes BETWEEN 5 AND 720),
  ADD CONSTRAINT fee_valid CHECK (fee_paise IS NULL OR fee_paise >= 0),
  ADD CONSTRAINT modes_not_empty CHECK (cardinality(modes) > 0);
CREATE UNIQUE INDEX services_unique_active_name ON app.services
  (organization_id, COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE is_active;

ALTER TABLE app.doctor_services
  ADD CONSTRAINT fee_override_valid CHECK (fee_override_paise IS NULL OR fee_override_paise >= 0);

-- Weekly hours: a doctor cannot be in two sessions at once on the same weekday.
CREATE TYPE app.timerange AS RANGE (subtype = time);
ALTER TABLE app.schedule_rules
  ADD CONSTRAINT clinic_mode_needs_branch CHECK ((mode = 'clinic') = (branch_id IS NOT NULL)),
  ADD CONSTRAINT schedule_rules_no_overlap EXCLUDE USING gist (
    doctor_id WITH =,
    weekday WITH =,
    app.timerange(start_local, end_local) WITH &&,
    daterange(valid_from, valid_to, '[]') WITH &&
  );

ALTER TABLE app.schedule_exceptions
  ADD CONSTRAINT during_bounded CHECK (NOT isempty(during) AND NOT lower_inf(during) AND NOT upper_inf(during));

-- Holidays are per date and branch (NULL branch = every branch).
CREATE UNIQUE INDEX holidays_unique_day ON app.holidays
  (organization_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), on_date);

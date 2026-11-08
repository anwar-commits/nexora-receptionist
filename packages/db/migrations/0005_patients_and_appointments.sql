-- Migration 0005: patients and appointments (Phase 5).

-- ---------------------------------------------------------------------
-- Patient privacy. app.patients has no organization_id (a person can later
-- link across clinics through the patient app, with their own OTP consent).
-- Until then a clinic sees only the person rows it created or has a profile for.
-- ---------------------------------------------------------------------
ALTER TABLE app.patients ADD COLUMN created_by_org uuid REFERENCES app.organizations(id);
ALTER TABLE app.patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.patients FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_visible_to_clinic ON app.patients
  USING (
    created_by_org = NULLIF(current_setting('app.org_id', true), '')::uuid
    OR EXISTS (SELECT 1 FROM app.patient_profiles pp
               WHERE pp.patient_id = patients.id
                 AND pp.organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  )
  WITH CHECK (created_by_org = NULLIF(current_setting('app.org_id', true), '')::uuid);
CREATE INDEX ON app.patients (created_by_org);

CREATE INDEX patient_profiles_name_search ON app.patient_profiles (organization_id, created_at DESC);
CREATE INDEX patients_name_lower ON app.patients (lower(full_name) text_pattern_ops);

-- Clinic patient IDs (MRN), e.g. LH-1001. One counter per clinic, taken under a row lock.
ALTER TABLE app.organization_settings
  ADD COLUMN mrn_prefix text CHECK (mrn_prefix ~ '^[A-Z0-9]{1,6}$'),
  ADD COLUMN next_mrn int NOT NULL DEFAULT 1001 CHECK (next_mrn > 0);

-- ---------------------------------------------------------------------
-- Appointments
-- ---------------------------------------------------------------------
ALTER TABLE app.appointments
  ADD CONSTRAINT slot_bounded CHECK (NOT isempty(slot) AND NOT lower_inf(slot) AND NOT upper_inf(slot)),
  ADD CONSTRAINT clinic_appt_needs_branch CHECK ((mode = 'clinic') = (branch_id IS NOT NULL)),
  ADD CONSTRAINT fee_valid CHECK (fee_paise IS NULL OR fee_paise >= 0),
  ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN status_changed_by uuid REFERENCES app.users(id);
CREATE INDEX appointments_doctor_slot ON app.appointments USING gist (doctor_id, slot);

ALTER TABLE app.slot_holds
  ADD COLUMN service_id uuid REFERENCES app.services(id),
  ADD COLUMN mode app.consult_mode,
  ADD COLUMN branch_id uuid REFERENCES app.branches(id),
  ADD COLUMN created_by uuid REFERENCES app.users(id),
  ADD CONSTRAINT hold_slot_bounded CHECK (NOT isempty(slot) AND NOT lower_inf(slot) AND NOT upper_inf(slot));

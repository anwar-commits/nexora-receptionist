-- =====================================================================
-- DOC-RECEPTIONIST AI · PostgreSQL 16 schema · Phase 2 (v0.1, 7 Nov 2026)
-- Migration 0001. Unset app.org_id reads as '' and matches no rows (fail closed).
-- Conventions
--   * UUID primary keys (gen_random_uuid), timestamptz everywhere, UTC.
--   * Every clinic-owned row carries organization_id; row-level security
--     (bottom of file) restricts rows to current_setting('app.org_id').
--   * Soft delete with deleted_at where records must stay recoverable.
--   * Sensitive free text and identifiers are stored encrypted by the app
--     (envelope encryption, AWS KMS) in *_enc bytea columns; searchable
--     lookups use keyed hashes in *_hash columns.
--   * Money in paise (bigint). Durations in seconds or minutes, named so.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- uuid equality inside GiST exclusion constraints

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------
CREATE TYPE app.org_status        AS ENUM ('trial','active','past_due','paused','closed');
CREATE TYPE app.member_status     AS ENUM ('invited','active','suspended','removed');
CREATE TYPE app.consult_mode      AS ENUM ('clinic','video','phone');
CREATE TYPE app.appt_status       AS ENUM ('held','booked','confirmed','checked_in','in_consultation','completed','cancelled','no_show','rescheduled');
CREATE TYPE app.booked_by_kind    AS ENUM ('ai_agent','staff','patient_app','partner','import');
CREATE TYPE app.lead_stage        AS ENUM ('enquiry','qualified','booked','consulted','treatment_plan','follow_up','retained','lost');
CREATE TYPE app.channel_kind      AS ENUM ('phone','whatsapp','sms','email','web_chat','app_push','internal');
CREATE TYPE app.direction         AS ENUM ('inbound','outbound');
CREATE TYPE app.telephony_vendor  AS ENUM ('exotel','plivo');
CREATE TYPE app.call_status       AS ENUM ('ringing','in_progress','on_hold','transferred','completed','missed','failed','abandoned');
CREATE TYPE app.call_outcome      AS ENUM ('booked','rescheduled','cancelled','info_only','follow_up','handed_off','emergency_redirect','dropped','spam','other');
CREATE TYPE app.speaker           AS ENUM ('ai','caller','staff','system');
CREATE TYPE app.consent_purpose   AS ENUM ('care_data_processing','whatsapp_updates','ai_followup_calls','marketing','call_recording_notice','data_share','referral_contact');
CREATE TYPE app.consent_state     AS ENUM ('given','withdrawn','expired','notified');
CREATE TYPE app.approval_state    AS ENUM ('draft','in_review','approved','rejected','expired');
CREATE TYPE app.payment_status    AS ENUM ('created','link_sent','authorized','captured','failed','refunded','partially_refunded');
CREATE TYPE app.referral_status   AS ENUM ('awaiting_consent','consented','contacted','booked','attended','declined','expired');
CREATE TYPE app.task_status       AS ENUM ('open','in_progress','done','cancelled');
CREATE TYPE app.priority          AS ENUM ('low','normal','high','urgent');

-- ---------------------------------------------------------------------
-- 1. Platform, tenancy, billing
-- ---------------------------------------------------------------------
CREATE TABLE app.subscription_plans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE,              -- starter, growth, network
  name               text NOT NULL,
  monthly_price_paise bigint,                           -- NULL until owner sets price
  included_voice_minutes int NOT NULL,
  overage_paise_per_minute bigint,
  max_branches       int,
  max_doctors        int,
  features           jsonb NOT NULL DEFAULT '{}',
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  slug               citext NOT NULL UNIQUE,
  legal_name         text,
  gstin              text,
  status             app.org_status NOT NULL DEFAULT 'trial',
  specialities       text[] NOT NULL DEFAULT '{}',
  languages          text[] NOT NULL DEFAULT '{en,hi}',  -- BCP-47 codes
  timezone           text NOT NULL DEFAULT 'Asia/Kolkata',
  data_region        text NOT NULL DEFAULT 'ap-south-1',
  logo_url           text,
  trial_ends_at      timestamptz,
  is_network_member  boolean NOT NULL DEFAULT false,     -- visible in doctor network directory
  verified_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE TABLE app.organization_settings (
  organization_id    uuid PRIMARY KEY REFERENCES app.organizations(id) ON DELETE CASCADE,
  recording_enabled  boolean NOT NULL DEFAULT true,
  transcript_enabled boolean NOT NULL DEFAULT true,
  recording_retention_days int NOT NULL DEFAULT 90 CHECK (recording_retention_days BETWEEN 0 AND 3650),
  transcript_retention_days int NOT NULL DEFAULT 2555,   -- ~7 years, aligned to medical records
  ai_pickup_mode     text NOT NULL DEFAULT 'after_ring' CHECK (ai_pickup_mode IN ('always','after_ring','after_hours')),
  ai_pickup_after_seconds int NOT NULL DEFAULT 20,
  outbound_start_local time NOT NULL DEFAULT '09:00',
  outbound_end_local time NOT NULL DEFAULT '20:00',
  refund_limit_receptionist_paise bigint NOT NULL DEFAULT 500000,
  prepay_policy      text NOT NULL DEFAULT 'video_only' CHECK (prepay_policy IN ('always','video_only','never')),
  cancellation_policy_text text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  plan_id            uuid NOT NULL REFERENCES app.subscription_plans(id),
  status             text NOT NULL CHECK (status IN ('trialing','active','past_due','cancelled')),
  current_period_start date NOT NULL,
  current_period_end date NOT NULL,
  extra_voice_minutes int NOT NULL DEFAULT 0,
  gateway_subscription_id text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.subscriptions (organization_id, status);

CREATE TABLE app.usage_records (                      -- metered cost and usage, one row per billable event
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  occurred_at        timestamptz NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('voice_minutes','telephony_minutes','llm_input_tokens','llm_output_tokens','sms','whatsapp','embedding_tokens','storage_gb_day')),
  vendor             text NOT NULL,                    -- elevenlabs, exotel, plivo, anthropic, ...
  quantity           numeric(14,4) NOT NULL,
  cost_paise         bigint NOT NULL DEFAULT 0,
  source_type        text,                              -- call, message, agent_run
  source_id          uuid
);
CREATE INDEX ON app.usage_records (organization_id, occurred_at);
CREATE INDEX ON app.usage_records (source_type, source_id);

CREATE TABLE app.invoices (                           -- platform invoices to clinics
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  subscription_id    uuid REFERENCES app.subscriptions(id),
  number             text NOT NULL UNIQUE,
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  amount_paise       bigint NOT NULL,
  tax_paise          bigint NOT NULL DEFAULT 0,
  status             text NOT NULL CHECK (status IN ('draft','open','paid','failed','void')),
  attempts           int NOT NULL DEFAULT 0,
  issued_at          timestamptz,
  paid_at            timestamptz
);

CREATE TABLE app.feature_flags (
  key                text PRIMARY KEY,
  description        text,
  default_enabled    boolean NOT NULL DEFAULT false,
  overrides          jsonb NOT NULL DEFAULT '{}',      -- {"<org_id>": true}
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.branches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  name               text NOT NULL,
  address_line       text NOT NULL,
  city               text NOT NULL,
  state              text NOT NULL,
  pincode            text,
  geo                point,
  phone              text,
  opening_hours      jsonb NOT NULL DEFAULT '{}',       -- {"mon":[["10:00","20:00"]],...}
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX ON app.branches (organization_id);

CREATE TABLE app.departments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  name               text NOT NULL,
  code               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE app.holidays (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  branch_id          uuid REFERENCES app.branches(id),  -- NULL = all branches
  on_date            date NOT NULL,
  name               text NOT NULL
);
CREATE INDEX ON app.holidays (organization_id, on_date);

-- ---------------------------------------------------------------------
-- 2. Identity and access
-- ---------------------------------------------------------------------
CREATE TABLE app.users (                              -- staff, doctors, partners, platform admins (not patients)
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name          text NOT NULL,
  email              citext UNIQUE,
  phone_e164         text UNIQUE,
  password_hash      text,                              -- argon2id
  is_platform_admin  boolean NOT NULL DEFAULT false,
  preferred_language text NOT NULL DEFAULT 'en',
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL)
);

CREATE TABLE app.roles (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid REFERENCES app.organizations(id), -- NULL = built-in role
  key                text NOT NULL,                     -- owner, branch_manager, doctor, receptionist, counsellor, ai_ops, staff, partner, external_doctor
  name               text NOT NULL,
  is_builtin         boolean NOT NULL DEFAULT false,
  requires_mfa       boolean NOT NULL DEFAULT false,
  UNIQUE (organization_id, key)
);

CREATE TABLE app.permissions (
  key                text PRIMARY KEY,                  -- resource:action  e.g. appointment:update
  description        text NOT NULL
);

CREATE TABLE app.role_permissions (
  role_id            uuid NOT NULL REFERENCES app.roles(id) ON DELETE CASCADE,
  permission_key     text NOT NULL REFERENCES app.permissions(key),
  scope              text NOT NULL CHECK (scope IN ('org','branch','own','assigned','none')),
  limit_value        bigint,                            -- e.g. refund limit in paise
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE app.memberships (                        -- a user's place in an organization
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  user_id            uuid NOT NULL REFERENCES app.users(id),
  role_id            uuid NOT NULL REFERENCES app.roles(id),
  branch_ids         uuid[] NOT NULL DEFAULT '{}',      -- empty = all branches
  status             app.member_status NOT NULL DEFAULT 'invited',
  invited_by         uuid REFERENCES app.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE app.sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid REFERENCES app.users(id),
  patient_id         uuid,                              -- FK added after patients table
  refresh_token_hash text NOT NULL UNIQUE,
  device_label       text,
  ip_hash            text,
  trusted_until      timestamptz,
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NOT NULL) <> (patient_id IS NOT NULL))
);

CREATE TABLE app.otp_challenges (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164         text NOT NULL,
  purpose            text NOT NULL CHECK (purpose IN ('login','verify_phone','consent','referral_consent','data_share')),
  code_hash          text NOT NULL,
  attempts           int NOT NULL DEFAULT 0,
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  context            jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.otp_challenges (phone_e164, created_at DESC);

CREATE TABLE app.mfa_factors (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('totp','backup_codes')),
  secret_enc         bytea NOT NULL,
  verified_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 3. Clinical directory and schedules
-- ---------------------------------------------------------------------
CREATE TABLE app.doctors (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  user_id            uuid REFERENCES app.users(id),
  department_id      uuid REFERENCES app.departments(id),
  display_name       text NOT NULL,
  qualifications     text,
  registration_number text,
  registration_council text,
  registration_verified_at timestamptz,
  years_experience   int,
  languages          text[] NOT NULL DEFAULT '{en,hi}',
  bio_approved       text,                              -- approved public profile text
  photo_url          text,
  slot_minutes       int NOT NULL DEFAULT 20,
  buffer_minutes     int NOT NULL DEFAULT 5,
  max_online_per_day int,
  bookable_by_ai     boolean NOT NULL DEFAULT true,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX ON app.doctors (organization_id) WHERE deleted_at IS NULL;

CREATE TABLE app.services (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  department_id      uuid REFERENCES app.departments(id),
  name               text NOT NULL,
  duration_minutes   int NOT NULL,
  fee_paise          bigint,                            -- NULL = "after assessment"
  ai_may_quote_fee   boolean NOT NULL DEFAULT false,
  modes              app.consult_mode[] NOT NULL DEFAULT '{clinic}',
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT ai_may_quote_fee OR fee_paise IS NOT NULL)
);

CREATE TABLE app.doctor_services (
  doctor_id          uuid NOT NULL REFERENCES app.doctors(id) ON DELETE CASCADE,
  service_id         uuid NOT NULL REFERENCES app.services(id) ON DELETE CASCADE,
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  fee_override_paise bigint,
  PRIMARY KEY (doctor_id, service_id)
);

CREATE TABLE app.schedule_rules (                     -- weekly availability
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  doctor_id          uuid NOT NULL REFERENCES app.doctors(id) ON DELETE CASCADE,
  branch_id          uuid REFERENCES app.branches(id),  -- NULL for video-only blocks
  weekday            smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = Monday
  start_local        time NOT NULL,
  end_local          time NOT NULL,
  mode               app.consult_mode NOT NULL,
  valid_from         date NOT NULL DEFAULT current_date,
  valid_to           date,
  CHECK (end_local > start_local)
);
CREATE INDEX ON app.schedule_rules (doctor_id, weekday);

CREATE TABLE app.schedule_exceptions (                -- leave, blocks, extra sessions
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  doctor_id          uuid NOT NULL REFERENCES app.doctors(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('leave','block','extra')),
  during             tstzrange NOT NULL,
  reason             text,
  created_by         uuid REFERENCES app.users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.schedule_exceptions USING gist (doctor_id, during);

-- ---------------------------------------------------------------------
-- 4. Patients, consent, records
-- ---------------------------------------------------------------------
CREATE TABLE app.patients (                           -- a person; global across clinics
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164_enc     bytea NOT NULL,
  phone_hash         text NOT NULL,                     -- HMAC for lookup
  full_name          text NOT NULL,
  date_of_birth      date,
  sex                text CHECK (sex IN ('female','male','other','unknown')),
  preferred_language text NOT NULL DEFAULT 'hi',
  abha_number_enc    bytea,                             -- ABDM health ID, optional
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX ON app.patients (phone_hash);
ALTER TABLE app.sessions ADD CONSTRAINT sessions_patient_fk FOREIGN KEY (patient_id) REFERENCES app.patients(id);

CREATE TABLE app.patient_profiles (                   -- the patient as seen by one organization
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  patient_id         uuid NOT NULL REFERENCES app.patients(id),
  mrn                text NOT NULL,                     -- clinic patient ID, e.g. LH-21907
  home_branch_id     uuid REFERENCES app.branches(id),
  city               text,
  acquisition_source text,
  referral_id        uuid,                              -- FK added after referrals
  allergies_enc      bytea,
  tags               text[] NOT NULL DEFAULT '{}',
  ai_summary         text,                              -- AI-written, non-clinical "about this patient"
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  UNIQUE (organization_id, patient_id),
  UNIQUE (organization_id, mrn)
);

CREATE TABLE app.family_links (                       -- who may act for whom in the patient app
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_patient_id  uuid NOT NULL REFERENCES app.patients(id),
  member_patient_id  uuid NOT NULL REFERENCES app.patients(id),
  relation           text NOT NULL,
  can_book           boolean NOT NULL DEFAULT true,
  can_view_records   boolean NOT NULL DEFAULT false,
  authorized_via     text NOT NULL CHECK (authorized_via IN ('otp','guardian_of_minor','in_clinic')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  CHECK (holder_patient_id <> member_patient_id)
);

CREATE TABLE app.consents (                           -- append-only consent ledger
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid REFERENCES app.organizations(id),
  patient_id         uuid NOT NULL REFERENCES app.patients(id),
  purpose            app.consent_purpose NOT NULL,
  state              app.consent_state NOT NULL,
  captured_via       text NOT NULL CHECK (captured_via IN ('voice_call','app','sms_otp','in_clinic','web','partner_otp')),
  evidence_ref       text,                              -- call id + timestamp, OTP id, signed form
  notice_version     text NOT NULL,
  scope              jsonb NOT NULL DEFAULT '{}',       -- for data_share: recipient, items
  recorded_by_user   uuid REFERENCES app.users(id),
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz
);
CREATE INDEX ON app.consents (patient_id, purpose, recorded_at DESC);

CREATE TABLE app.consultations (                      -- one clinical encounter
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  patient_profile_id uuid NOT NULL REFERENCES app.patient_profiles(id),
  doctor_id          uuid NOT NULL REFERENCES app.doctors(id),
  appointment_id     uuid,                              -- FK added after appointments
  mode               app.consult_mode NOT NULL,
  started_at         timestamptz,
  ended_at           timestamptz,
  signed_at          timestamptz,
  signed_by          uuid REFERENCES app.users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.consultations (patient_profile_id, started_at DESC);

CREATE TABLE app.clinical_notes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  consultation_id    uuid NOT NULL REFERENCES app.consultations(id),
  kind               text NOT NULL CHECK (kind IN ('pre_visit_summary','examination','assessment','plan','instructions','referral_letter')),
  body_enc           bytea NOT NULL,
  authored_by        text NOT NULL CHECK (authored_by IN ('doctor','ai_draft')),
  approved_by        uuid REFERENCES app.users(id),     -- required before ai_draft is part of the record
  approved_at        timestamptz,
  version            int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.prescriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  consultation_id    uuid NOT NULL REFERENCES app.consultations(id),
  doctor_id          uuid NOT NULL REFERENCES app.doctors(id),
  signed_at          timestamptz,
  pdf_object_key     text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.prescription_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  prescription_id    uuid NOT NULL REFERENCES app.prescriptions(id) ON DELETE CASCADE,
  medicine           text NOT NULL,
  dose               text,
  frequency          text,
  duration           text,
  instructions       text,
  position           int NOT NULL
);

CREATE TABLE app.medical_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  patient_profile_id uuid NOT NULL REFERENCES app.patient_profiles(id),
  consultation_id    uuid REFERENCES app.consultations(id),
  kind               text NOT NULL CHECK (kind IN ('lab_report','imaging','photo','referral_letter','prescription','consent_form','other')),
  title              text NOT NULL,
  object_key         text NOT NULL,                     -- S3, SSE-KMS; served by signed URL only
  mime_type          text NOT NULL,
  size_bytes         bigint NOT NULL,
  uploaded_by_kind   text NOT NULL CHECK (uploaded_by_kind IN ('patient','staff','doctor','external_doctor')),
  uploaded_by_id     uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

-- ---------------------------------------------------------------------
-- 5. Scheduling
-- ---------------------------------------------------------------------
CREATE TABLE app.appointments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  branch_id          uuid REFERENCES app.branches(id),
  doctor_id          uuid NOT NULL REFERENCES app.doctors(id),
  service_id         uuid NOT NULL REFERENCES app.services(id),
  patient_profile_id uuid NOT NULL REFERENCES app.patient_profiles(id),
  booked_for_patient_id uuid REFERENCES app.patients(id), -- family booking
  mode               app.consult_mode NOT NULL,
  slot               tstzrange NOT NULL,
  status             app.appt_status NOT NULL DEFAULT 'booked',
  booked_by_kind     app.booked_by_kind NOT NULL,
  booked_by_id       uuid,                              -- user, agent version or partner id
  source_call_id     uuid,                              -- FK added after calls
  fee_paise          bigint,
  video_room_url     text,
  reason_text        text,
  idempotency_key    text,
  cancelled_reason   text,
  rescheduled_from   uuid REFERENCES app.appointments(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  -- no double booking for a doctor among live appointments
  EXCLUDE USING gist (doctor_id WITH =, slot WITH &&) WHERE (status IN ('held','booked','confirmed','checked_in','in_consultation'))
);
CREATE INDEX ON app.appointments (organization_id, lower(slot));
CREATE INDEX ON app.appointments (patient_profile_id);
ALTER TABLE app.consultations ADD CONSTRAINT consultations_appt_fk FOREIGN KEY (appointment_id) REFERENCES app.appointments(id);

CREATE TABLE app.slot_holds (                         -- short holds while a caller decides
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  doctor_id          uuid NOT NULL REFERENCES app.doctors(id),
  slot               tstzrange NOT NULL,
  held_by_kind       text NOT NULL CHECK (held_by_kind IN ('call','staff','app')),
  held_by_ref        uuid,
  expires_at         timestamptz NOT NULL,
  EXCLUDE USING gist (doctor_id WITH =, slot WITH &&)
);

CREATE TABLE app.queue_tokens (                       -- check-in and waiting room
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  branch_id          uuid NOT NULL REFERENCES app.branches(id),
  appointment_id     uuid REFERENCES app.appointments(id),
  patient_profile_id uuid NOT NULL REFERENCES app.patient_profiles(id),
  doctor_id          uuid REFERENCES app.doctors(id),
  token              text NOT NULL,                     -- D-14
  service_date       date NOT NULL,
  is_walk_in         boolean NOT NULL DEFAULT false,
  status             text NOT NULL CHECK (status IN ('waiting','called','in_room','done','left')),
  position           int NOT NULL,
  checked_in_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, service_date, token)
);

CREATE TABLE app.waitlist_entries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  patient_profile_id uuid NOT NULL REFERENCES app.patient_profiles(id),
  doctor_id          uuid REFERENCES app.doctors(id),
  service_id         uuid REFERENCES app.services(id),
  wanted             tstzrange NOT NULL,
  status             text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','offered','booked','expired')),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 6. CRM
-- ---------------------------------------------------------------------
CREATE TABLE app.leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  patient_id         uuid REFERENCES app.patients(id),  -- set once identified
  display_name       text,
  phone_hash         text,
  stage              app.lead_stage NOT NULL DEFAULT 'enquiry',
  interest           text,
  source             text NOT NULL,                     -- google_ads, instagram, website, referral_partner, walk_in, ...
  source_detail      jsonb NOT NULL DEFAULT '{}',       -- utm, campaign, keyword, partner code
  score              int NOT NULL DEFAULT 0,
  score_breakdown    jsonb NOT NULL DEFAULT '[]',       -- [{"rule":"named_service","points":20}]
  owner_kind         text NOT NULL DEFAULT 'ai' CHECK (owner_kind IN ('ai','user','unassigned')),
  owner_user_id      uuid REFERENCES app.users(id),
  next_action_at     timestamptz,
  lost_reason        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.leads (organization_id, stage, next_action_at);
CREATE INDEX ON app.leads (organization_id, phone_hash);

CREATE TABLE app.lead_events (                        -- stage changes and touches, append-only
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  lead_id            uuid NOT NULL REFERENCES app.leads(id) ON DELETE CASCADE,
  kind               text NOT NULL,                     -- stage_changed, call, message, note, score_changed
  from_stage         app.lead_stage,
  to_stage           app.lead_stage,
  ref_type           text,
  ref_id             uuid,
  actor_kind         text NOT NULL CHECK (actor_kind IN ('ai','user','system','patient')),
  actor_id           uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.lead_events (lead_id, created_at);

CREATE TABLE app.lead_scoring_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  key                text NOT NULL,
  label              text NOT NULL,
  points             int NOT NULL,
  condition          jsonb NOT NULL,                    -- declarative, evaluated in code
  is_active          boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, key)
);

CREATE TABLE app.tasks (                              -- follow-ups, callbacks, safety check-ins
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  kind               text NOT NULL CHECK (kind IN ('callback','follow_up','safety_check_in','knowledge_gap','approve_ai_draft','reschedule','other')),
  title              text NOT NULL,
  priority           app.priority NOT NULL DEFAULT 'normal',
  status             app.task_status NOT NULL DEFAULT 'open',
  assignee_kind      text NOT NULL CHECK (assignee_kind IN ('ai_agent','user','role')),
  assignee_ref       text,
  due_at             timestamptz,
  related_type       text,
  related_id         uuid,
  created_by_kind    text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
CREATE INDEX ON app.tasks (organization_id, status, due_at);

-- ---------------------------------------------------------------------
-- 7. Communications
-- ---------------------------------------------------------------------
CREATE TABLE app.channel_accounts (                   -- phone numbers, WhatsApp numbers, sender IDs
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  branch_id          uuid REFERENCES app.branches(id),
  kind               app.channel_kind NOT NULL,
  address            text NOT NULL,                     -- E.164 number, WABA id, email
  telephony_vendor   app.telephony_vendor,              -- for kind = phone
  fallback_vendor    app.telephony_vendor,              -- outbound failover
  vendor_ref         text,
  purpose            text NOT NULL DEFAULT 'main' CHECK (purpose IN ('main','ai_line','campaign','branch')),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, address)
);

CREATE TABLE app.conversations (                      -- unified inbox thread, one per patient/lead + channel
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  channel            app.channel_kind NOT NULL,
  channel_account_id uuid REFERENCES app.channel_accounts(id),
  patient_id         uuid REFERENCES app.patients(id),
  lead_id            uuid REFERENCES app.leads(id),
  external_party     text,                              -- hashed number or visitor id when unknown
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','closed')),
  handled_by         text NOT NULL DEFAULT 'ai' CHECK (handled_by IN ('ai','user')),
  assignee_user_id   uuid REFERENCES app.users(id),
  last_message_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.conversations (organization_id, status, last_message_at DESC);

CREATE TABLE app.messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  conversation_id    uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  direction          app.direction NOT NULL,
  author_kind        text NOT NULL CHECK (author_kind IN ('patient','ai','user','system')),
  author_id          uuid,
  body               text,
  media              jsonb NOT NULL DEFAULT '[]',
  template_id        uuid,
  ai_draft_state     text CHECK (ai_draft_state IN ('draft','approved','sent','discarded')),
  vendor_message_id  text,
  delivery_status    text CHECK (delivery_status IN ('queued','sent','delivered','read','failed')),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.messages (conversation_id, created_at);

CREATE TABLE app.message_templates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid REFERENCES app.organizations(id), -- NULL = platform default
  channel            app.channel_kind NOT NULL,
  key                text NOT NULL,                     -- appointment_confirmation, reminder_24h, ...
  language           text NOT NULL,
  body               text NOT NULL,
  vendor_template_name text,                            -- approved WhatsApp/DLT template id
  category           text CHECK (category IN ('utility','marketing','authentication')),
  approval           app.approval_state NOT NULL DEFAULT 'draft',
  UNIQUE (organization_id, channel, key, language)
);
ALTER TABLE app.messages ADD CONSTRAINT messages_template_fk FOREIGN KEY (template_id) REFERENCES app.message_templates(id);

CREATE TABLE app.notifications (                      -- in-app and push for staff and patients
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid REFERENCES app.organizations(id),
  recipient_kind     text NOT NULL CHECK (recipient_kind IN ('user','patient')),
  recipient_id       uuid NOT NULL,
  kind               text NOT NULL,
  title              text NOT NULL,
  body               text,
  link               text,
  read_at            timestamptz,
  push_status        text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.notifications (recipient_kind, recipient_id, created_at DESC);

CREATE TABLE app.device_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind         text NOT NULL CHECK (owner_kind IN ('user','patient')),
  owner_id           uuid NOT NULL,
  platform           text NOT NULL CHECK (platform IN ('ios','android','web')),
  token              text NOT NULL UNIQUE,
  last_seen_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 8. Voice and calls
-- ---------------------------------------------------------------------
CREATE TABLE app.calls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  branch_id          uuid REFERENCES app.branches(id),
  channel_account_id uuid REFERENCES app.channel_accounts(id),
  direction          app.direction NOT NULL,
  telephony_vendor   app.telephony_vendor,
  vendor_call_id     text,
  voice_vendor       text NOT NULL DEFAULT 'elevenlabs',
  voice_conversation_id text,
  agent_version_id   uuid,                              -- FK added after agents
  caller_phone_hash  text,
  caller_phone_enc   bytea,
  patient_id         uuid REFERENCES app.patients(id),
  lead_id            uuid REFERENCES app.leads(id),
  conversation_id    uuid REFERENCES app.conversations(id),
  language_detected  text,
  status             app.call_status NOT NULL DEFAULT 'ringing',
  outcome            app.call_outcome,
  intent             text,
  sentiment          text,
  handled_by         text NOT NULL DEFAULT 'ai' CHECK (handled_by IN ('ai','user','ai_then_user')),
  started_at         timestamptz NOT NULL,
  answered_at        timestamptz,
  ended_at           timestamptz,
  duration_seconds   int,
  recording_notice_at timestamptz,                      -- when the AI/recording notice was spoken
  cost_paise         bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (telephony_vendor, vendor_call_id)
);
CREATE INDEX ON app.calls (organization_id, started_at DESC);
CREATE INDEX ON app.calls (organization_id, outcome);
ALTER TABLE app.appointments ADD CONSTRAINT appointments_call_fk FOREIGN KEY (source_call_id) REFERENCES app.calls(id);

CREATE TABLE app.call_recordings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  call_id            uuid NOT NULL REFERENCES app.calls(id) ON DELETE CASCADE,
  object_key         text NOT NULL,
  duration_seconds   int NOT NULL,
  delete_after       timestamptz NOT NULL,
  deleted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.call_recordings (delete_after) WHERE deleted_at IS NULL;

CREATE TABLE app.call_transcript_segments (
  id                 bigserial PRIMARY KEY,
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  call_id            uuid NOT NULL REFERENCES app.calls(id) ON DELETE CASCADE,
  seq                int NOT NULL,
  speaker            app.speaker NOT NULL,
  started_ms         int NOT NULL,
  ended_ms           int NOT NULL,
  language           text,
  text_original      text NOT NULL,
  text_english       text,
  source_refs        jsonb NOT NULL DEFAULT '[]',       -- knowledge chunk ids cited by the AI turn
  UNIQUE (call_id, seq)
);

CREATE TABLE app.call_summaries (
  call_id            uuid PRIMARY KEY REFERENCES app.calls(id) ON DELETE CASCADE,
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  summary            text NOT NULL,
  intake             jsonb NOT NULL DEFAULT '{}',       -- reason, duration, prior treatment, preference
  next_action        text,
  model              text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.safety_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  call_id            uuid REFERENCES app.calls(id),
  conversation_id    uuid REFERENCES app.conversations(id),
  kind               text NOT NULL CHECK (kind IN ('emergency_redirect','self_harm_risk','abuse','guardrail_block')),
  trigger_text       text,
  red_flag_key       text,
  detected_at        timestamptz NOT NULL,
  script_version     text,
  transferred_to     text,
  reviewed_by        uuid REFERENCES app.users(id),
  reviewed_at        timestamptz,
  check_in_task_id   uuid REFERENCES app.tasks(id)
);

CREATE TABLE app.handoffs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  call_id            uuid REFERENCES app.calls(id),
  conversation_id    uuid REFERENCES app.conversations(id),
  reason             text NOT NULL CHECK (reason IN ('asked_for_person','complaint','billing','ai_unsure','clinical_question','emergency','vip')),
  note_for_staff     text,
  requested_at       timestamptz NOT NULL,
  accepted_by        uuid REFERENCES app.users(id),
  accepted_at        timestamptz,
  fallback_task_id   uuid REFERENCES app.tasks(id)
);

-- ---------------------------------------------------------------------
-- 9. AI agents and knowledge
-- ---------------------------------------------------------------------
CREATE TABLE app.ai_agents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  kind               text NOT NULL CHECK (kind IN ('voice_receptionist','booking','education','follow_up','lead_conversion','missed_call_recovery','patient_support','referral_coordination','doctor_assistant','ops_assistant','analytics','multilingual_outreach')),
  name               text NOT NULL,
  live_version_id    uuid,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','paused')),
  daily_limits       jsonb NOT NULL DEFAULT '{}',       -- {"outbound_calls":60}
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, kind, name)
);

CREATE TABLE app.ai_agent_versions (                  -- immutable once published
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  agent_id           uuid NOT NULL REFERENCES app.ai_agents(id) ON DELETE CASCADE,
  version            int NOT NULL,
  persona            jsonb NOT NULL,                    -- name, tone, greeting per language
  voice              jsonb NOT NULL,                    -- vendor voice id, speed, turn timeout
  languages          text[] NOT NULL,
  intake_questions   jsonb NOT NULL DEFAULT '[]',
  guardrails         jsonb NOT NULL,                    -- clinic toggles; platform locks enforced in code
  handoff_rules      jsonb NOT NULL,
  emergency_protocol jsonb NOT NULL,                    -- red flags, script, approved_by, approved_at
  allowed_tools      text[] NOT NULL,
  llm_model          text NOT NULL,
  vendor_agent_id    text,                              -- ElevenLabs agent id this version is synced to
  published_by       uuid REFERENCES app.users(id),
  published_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);
ALTER TABLE app.ai_agents ADD CONSTRAINT ai_agents_live_fk FOREIGN KEY (live_version_id) REFERENCES app.ai_agent_versions(id);
ALTER TABLE app.calls ADD CONSTRAINT calls_agent_version_fk FOREIGN KEY (agent_version_id) REFERENCES app.ai_agent_versions(id);

CREATE TABLE app.agent_runs (                         -- one execution: a call, a chat turn batch, a job
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  agent_version_id   uuid NOT NULL REFERENCES app.ai_agent_versions(id),
  trigger            text NOT NULL,                     -- inbound_call, missed_call, schedule, message, test
  is_test            boolean NOT NULL DEFAULT false,
  call_id            uuid REFERENCES app.calls(id),
  conversation_id    uuid REFERENCES app.conversations(id),
  status             text NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')),
  error              text,
  input_tokens       int NOT NULL DEFAULT 0,
  output_tokens      int NOT NULL DEFAULT 0,
  started_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz
);
CREATE INDEX ON app.agent_runs (organization_id, started_at DESC);

CREATE TABLE app.tool_invocations (                   -- every tool the AI called, with result
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  agent_run_id       uuid NOT NULL REFERENCES app.agent_runs(id) ON DELETE CASCADE,
  tool               text NOT NULL,
  arguments          jsonb NOT NULL,
  result             jsonb,
  status             text NOT NULL CHECK (status IN ('ok','rejected','error')),
  rejection_reason   text,                              -- validation or policy failure
  latency_ms         int,
  idempotency_key    text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.tool_invocations (agent_run_id);

CREATE TABLE app.agent_test_cases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid REFERENCES app.organizations(id), -- NULL = platform safety suite
  agent_kind         text NOT NULL,
  name               text NOT NULL,
  script             jsonb NOT NULL,                    -- caller turns
  expectations       jsonb NOT NULL,                    -- must_call, must_not_say, must_transfer...
  is_safety_critical boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.agent_test_results (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  agent_version_id   uuid NOT NULL REFERENCES app.ai_agent_versions(id),
  test_case_id       uuid NOT NULL REFERENCES app.agent_test_cases(id),
  passed             boolean NOT NULL,
  details            jsonb NOT NULL DEFAULT '{}',
  agent_run_id       uuid REFERENCES app.agent_runs(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.knowledge_sources (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  title              text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('document','faq','web_page','price_list','policy','offer','settings_sync')),
  category           text NOT NULL CHECK (category IN ('medical_education','prices','policy','logistics','offer')),
  object_key         text,
  url                text,
  current_version    int NOT NULL DEFAULT 1,
  valid_until        date,
  created_by         uuid REFERENCES app.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE TABLE app.knowledge_documents (                -- one language version of a source, with approval
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  source_id          uuid NOT NULL REFERENCES app.knowledge_sources(id) ON DELETE CASCADE,
  version            int NOT NULL,
  language           text NOT NULL,
  body               text NOT NULL,
  approval           app.approval_state NOT NULL DEFAULT 'draft',
  approved_by        uuid REFERENCES app.users(id),     -- doctor for medical_education, admin otherwise
  approved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, version, language)
);

CREATE TABLE app.knowledge_chunks (                   -- only approved documents are chunked
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  document_id        uuid NOT NULL REFERENCES app.knowledge_documents(id) ON DELETE CASCADE,
  seq                int NOT NULL,
  language           text NOT NULL,
  content            text NOT NULL,
  embedding          vector(1024) NOT NULL,
  token_count        int NOT NULL,
  UNIQUE (document_id, seq)
);
CREATE INDEX ON app.knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON app.knowledge_chunks (organization_id, language);

CREATE TABLE app.knowledge_gaps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  topic              text NOT NULL,
  example_questions  text[] NOT NULL,
  occurrences        int NOT NULL DEFAULT 1,
  draft_source_id    uuid REFERENCES app.knowledge_sources(id),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','drafted','resolved','dismissed')),
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 10. Referrals and doctor network
-- ---------------------------------------------------------------------
CREATE TABLE app.referral_partners (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id), -- the clinic they refer to
  user_id            uuid REFERENCES app.users(id),
  kind               text NOT NULL CHECK (kind IN ('pharmacy','individual','gym_salon','corporate','ngo','other')),
  name               text NOT NULL,
  code               citext NOT NULL UNIQUE,             -- RAJMED-24
  verification       app.approval_state NOT NULL DEFAULT 'in_review',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.partner_agreements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  partner_id         uuid NOT NULL REFERENCES app.referral_partners(id),
  agreement_type     text NOT NULL CHECK (agreement_type IN ('information_only','fixed_fee_service','other_lawful')),
  per_patient_payment boolean NOT NULL DEFAULT false CHECK (per_patient_payment = false), -- prohibited by design
  terms_object_key   text,
  legal_reviewed_by  text,
  signed_at          timestamptz,
  ends_at            date
);

CREATE TABLE app.external_doctors (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL UNIQUE REFERENCES app.users(id),
  display_name       text NOT NULL,
  speciality         text,
  practice_name      text,
  city               text,
  registration_number text,
  registration_council text,
  verified_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.network_connections (                -- partnership between two organizations, or org and external doctor
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  peer_organization_id uuid REFERENCES app.organizations(id),
  peer_external_doctor_id uuid REFERENCES app.external_doctors(id),
  status             text NOT NULL CHECK (status IN ('requested','active','declined','ended')),
  requested_by       uuid REFERENCES app.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((peer_organization_id IS NOT NULL) <> (peer_external_doctor_id IS NOT NULL))
);

CREATE TABLE app.referrals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id), -- receiving clinic
  referrer_kind      text NOT NULL CHECK (referrer_kind IN ('partner','external_doctor','organization')),
  partner_id         uuid REFERENCES app.referral_partners(id),
  external_doctor_id uuid REFERENCES app.external_doctors(id),
  from_organization_id uuid REFERENCES app.organizations(id),
  patient_id         uuid REFERENCES app.patients(id),  -- set only after consent
  patient_name_pending text,                            -- held until consent, then cleared
  patient_phone_enc  bytea,
  interest           text,
  to_department_id   uuid REFERENCES app.departments(id),
  to_doctor_id       uuid REFERENCES app.doctors(id),
  urgency            text NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine','within_week')),
  status             app.referral_status NOT NULL DEFAULT 'awaiting_consent',
  consent_id         uuid REFERENCES app.consents(id),
  appointment_id     uuid REFERENCES app.appointments(id),
  outcome_shared_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.referrals (organization_id, status);
ALTER TABLE app.patient_profiles ADD CONSTRAINT patient_profiles_referral_fk FOREIGN KEY (referral_id) REFERENCES app.referrals(id);

CREATE TABLE app.data_shares (                        -- what crossed an organization boundary, under which consent
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id), -- sender
  patient_id         uuid NOT NULL REFERENCES app.patients(id),
  recipient_kind     text NOT NULL CHECK (recipient_kind IN ('organization','external_doctor')),
  recipient_id       uuid NOT NULL,
  referral_id        uuid REFERENCES app.referrals(id),
  consent_id         uuid NOT NULL REFERENCES app.consents(id),
  items              jsonb NOT NULL,                    -- [{"type":"document","id":...},{"type":"demographics"}]
  shared_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz
);

CREATE TABLE app.doctor_messages (                    -- doctor-to-doctor, tied to a referral
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id        uuid NOT NULL REFERENCES app.referrals(id) ON DELETE CASCADE,
  author_user_id     uuid NOT NULL REFERENCES app.users(id),
  body_enc           bytea NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 11. Payments
-- ---------------------------------------------------------------------
CREATE TABLE app.payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  branch_id          uuid REFERENCES app.branches(id),
  patient_profile_id uuid NOT NULL REFERENCES app.patient_profiles(id),
  appointment_id     uuid REFERENCES app.appointments(id),
  purpose            text NOT NULL,
  amount_paise       bigint NOT NULL CHECK (amount_paise >= 0),
  method             text CHECK (method IN ('upi','card','netbanking','cash','payment_link','package')),
  status             app.payment_status NOT NULL DEFAULT 'created',
  gateway            text,                              -- razorpay
  gateway_order_id   text,
  gateway_payment_id text UNIQUE,
  receipt_number     text,
  collected_by       uuid REFERENCES app.users(id),
  idempotency_key    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  captured_at        timestamptz,
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX ON app.payments (organization_id, created_at DESC);

CREATE TABLE app.refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  payment_id         uuid NOT NULL REFERENCES app.payments(id),
  amount_paise       bigint NOT NULL CHECK (amount_paise > 0),
  reason             text NOT NULL,
  approved_by        uuid NOT NULL REFERENCES app.users(id),
  gateway_refund_id  text,
  status             text NOT NULL CHECK (status IN ('pending','processed','failed')),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 12. Platform operations
-- ---------------------------------------------------------------------
CREATE TABLE app.audit_logs (                         -- append-only; UPDATE/DELETE revoked from app role
  id                 bigserial PRIMARY KEY,
  organization_id    uuid,
  actor_kind         text NOT NULL CHECK (actor_kind IN ('user','patient','ai_agent','system','platform_admin','partner','external_doctor')),
  actor_id           uuid,
  action             text NOT NULL,                     -- appointment.cancel, agent.publish, refund.create
  target_type        text,
  target_id          uuid,
  details            jsonb NOT NULL DEFAULT '{}',
  ip_hash            text,
  occurred_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.audit_logs (organization_id, occurred_at DESC);

CREATE TABLE app.data_access_logs (                   -- every read of a clinical record
  id                 bigserial PRIMARY KEY,
  organization_id    uuid NOT NULL,
  actor_kind         text NOT NULL,
  actor_id           uuid,
  patient_id         uuid NOT NULL,
  resource_type      text NOT NULL,
  resource_id        uuid,
  purpose            text NOT NULL,                     -- care, break_glass, support, export
  break_glass_reason text,
  occurred_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app.data_access_logs (patient_id, occurred_at DESC);

CREATE TABLE app.integration_credentials (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid REFERENCES app.organizations(id), -- NULL = platform-level
  provider           text NOT NULL,                     -- exotel, plivo, whatsapp_cloud, razorpay, google_calendar
  secret_ref         text NOT NULL,                     -- AWS Secrets Manager ARN; never the secret
  config             jsonb NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','error','revoked')),
  last_checked_at    timestamptz,
  UNIQUE (organization_id, provider)
);

CREATE TABLE app.webhook_events (                     -- inbound webhooks, dedupe + replay
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           text NOT NULL,
  event_id           text NOT NULL,
  organization_id    uuid,
  signature_valid    boolean NOT NULL,
  payload            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed','ignored')),
  attempts           int NOT NULL DEFAULT 0,
  error              text,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  UNIQUE (provider, event_id)
);

CREATE TABLE app.outbox_events (                     -- written in the same transaction as the change; published by a worker
  id                 bigserial PRIMARY KEY,
  organization_id    uuid,
  event_type         text NOT NULL,                     -- appointment.booked, call.completed, consent.withdrawn
  aggregate_type     text NOT NULL,
  aggregate_id       uuid NOT NULL,
  payload            jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  published_at       timestamptz
);
CREATE INDEX ON app.outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE app.job_runs (                           -- durable record of important BullMQ jobs
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid,
  queue              text NOT NULL,
  name               text NOT NULL,
  bull_job_id        text,
  status             text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','dead')),
  attempts           int NOT NULL DEFAULT 0,
  last_error         text,
  scheduled_for      timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.support_tickets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES app.organizations(id),
  opened_by          uuid REFERENCES app.users(id),
  subject            text NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','resolved')),
  priority           app.priority NOT NULL DEFAULT 'normal',
  support_access_granted_until timestamptz,             -- owner-approved support access window
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- Row-level security: every table with organization_id
-- The API sets, per request/transaction:
--   SET LOCAL app.org_id = '<uuid>';  SET LOCAL app.is_platform = 'false';
-- Platform jobs that must cross tenants use a separate DB role with BYPASSRLS.
-- =====================================================================
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'app' AND c.column_name = 'organization_id'
      AND c.table_name NOT IN ('organization_settings','audit_logs','data_access_logs','webhook_events','job_runs','outbox_events','message_templates','agent_test_cases','notifications','roles')
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON app.%I
                    USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
                    WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)$p$, t.table_name);
  END LOOP;
END $$;

-- Tables where NULL organization_id means a platform default row (readable by all tenants).
-- integration_credentials is NOT here: platform-level credentials are read only by app_platform.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_templates','agent_test_cases','roles','notifications']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_or_platform ON app.%I
                    USING (organization_id IS NULL OR organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
                    WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

ALTER TABLE app.organization_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.organization_settings
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Grants and the application role are in migration 0002.

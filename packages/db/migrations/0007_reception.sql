-- Migration 0007: reception console — inbox, desk payments, walk-ins (Phase 7).

-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------
INSERT INTO app.permissions (key, description) VALUES
  ('inbox:read', 'Read WhatsApp and SMS conversations'),
  ('inbox:reply', 'Reply to WhatsApp and SMS conversations'),
  ('channel:manage', 'Connect WhatsApp and SMS numbers');

INSERT INTO app.role_permissions (role_id, permission_key, scope, limit_value) VALUES
  ('00000000-0000-4000-8000-000000000001', 'inbox:read', 'org', NULL),
  ('00000000-0000-4000-8000-000000000001', 'inbox:reply', 'org', NULL),
  ('00000000-0000-4000-8000-000000000001', 'channel:manage', 'org', NULL),
  ('00000000-0000-4000-8000-000000000002', 'inbox:read', 'org', NULL),
  ('00000000-0000-4000-8000-000000000002', 'inbox:reply', 'org', NULL),
  ('00000000-0000-4000-8000-000000000004', 'inbox:read', 'org', NULL),
  ('00000000-0000-4000-8000-000000000004', 'inbox:reply', 'org', NULL),
  ('00000000-0000-4000-8000-000000000005', 'inbox:read', 'assigned', NULL),
  ('00000000-0000-4000-8000-000000000005', 'inbox:reply', 'assigned', NULL);

-- ---------------------------------------------------------------------
-- Channel credentials. In production secrets live in a secrets manager
-- (secret_ref); self-hosted and staging keep them encrypted here (secret_enc).
-- ---------------------------------------------------------------------
ALTER TABLE app.integration_credentials
  ALTER COLUMN secret_ref DROP NOT NULL,
  ADD COLUMN channel_account_id uuid REFERENCES app.channel_accounts(id),
  ADD COLUMN secret_enc bytea,
  ADD CONSTRAINT secret_somewhere CHECK (secret_ref IS NOT NULL OR secret_enc IS NOT NULL);
ALTER TABLE app.integration_credentials DROP CONSTRAINT integration_credentials_organization_id_provider_key;
CREATE UNIQUE INDEX integration_credentials_per_account ON app.integration_credentials (organization_id, provider, COALESCE(channel_account_id, '00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE app.channel_accounts
  ADD COLUMN provider text NOT NULL DEFAULT 'sandbox' CHECK (provider IN ('sandbox','whatsapp_cloud','exotel','plivo')),
  ADD COLUMN display_name text,
  ADD COLUMN verify_token_hash text;

-- Webhooks arrive without a signed-in clinic. This returns only what is needed to
-- verify and route one webhook for one channel account, nothing else.
CREATE FUNCTION app.webhook_channel_account(p_id uuid)
RETURNS TABLE (organization_id uuid, kind app.channel_kind, provider text, vendor_ref text, verify_token_hash text, is_active boolean, secret_enc bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT ca.organization_id, ca.kind, ca.provider, ca.vendor_ref, ca.verify_token_hash, ca.is_active, ic.secret_enc
    FROM app.channel_accounts ca
    LEFT JOIN app.integration_credentials ic ON ic.channel_account_id = ca.id AND ic.status = 'active'
   WHERE ca.id = p_id
$$;
REVOKE ALL ON FUNCTION app.webhook_channel_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.webhook_channel_account(uuid) TO app_api;

-- ---------------------------------------------------------------------
-- Conversations and messages
-- ---------------------------------------------------------------------
ALTER TABLE app.conversations
  ADD COLUMN party_phone_enc bytea,                      -- to reply; external_party holds the keyed hash
  ADD COLUMN last_inbound_at timestamptz,                -- WhatsApp: free-form replies only within 24 h of this
  ADD COLUMN unread_count int NOT NULL DEFAULT 0 CHECK (unread_count >= 0);
CREATE UNIQUE INDEX conversations_one_open_per_party ON app.conversations (organization_id, channel_account_id, external_party) WHERE status <> 'closed';
CREATE UNIQUE INDEX messages_vendor_id ON app.messages (organization_id, vendor_message_id) WHERE vendor_message_id IS NOT NULL;
ALTER TABLE app.messages
  ADD COLUMN error text,
  ADD CONSTRAINT message_has_content CHECK (body IS NOT NULL OR jsonb_array_length(media) > 0 OR template_id IS NOT NULL);

-- ---------------------------------------------------------------------
-- Desk payments, receipts, refunds
-- ---------------------------------------------------------------------
ALTER TABLE app.organization_settings
  ADD COLUMN next_receipt int NOT NULL DEFAULT 1 CHECK (next_receipt > 0);
ALTER TABLE app.payments
  ADD COLUMN refunded_paise bigint NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),
  ADD COLUMN reference text,                              -- UPI ref / card slip number
  ADD COLUMN queue_token_id uuid REFERENCES app.queue_tokens(id),
  ADD CONSTRAINT refund_not_more_than_paid CHECK (refunded_paise <= amount_paise),
  ADD CONSTRAINT captured_has_receipt CHECK (status NOT IN ('captured','refunded','partially_refunded') OR receipt_number IS NOT NULL);
CREATE UNIQUE INDEX payments_receipt_number ON app.payments (organization_id, receipt_number) WHERE receipt_number IS NOT NULL;
CREATE INDEX ON app.payments (appointment_id);
REVOKE DELETE ON app.payments, app.refunds FROM app_api;

-- ---------------------------------------------------------------------
-- Walk-ins: a token without an appointment, for a service
-- ---------------------------------------------------------------------
ALTER TABLE app.queue_tokens
  ADD COLUMN service_id uuid REFERENCES app.services(id),
  ADD COLUMN created_by uuid REFERENCES app.users(id);

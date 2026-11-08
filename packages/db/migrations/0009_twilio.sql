-- Migration 0009: Twilio as a phone provider for the AI receptionist (connected natively in ElevenLabs).
ALTER TYPE app.telephony_vendor ADD VALUE IF NOT EXISTS 'twilio';
ALTER TABLE app.channel_accounts DROP CONSTRAINT channel_accounts_provider_check;
ALTER TABLE app.channel_accounts ADD CONSTRAINT channel_accounts_provider_check CHECK (provider IN ('sandbox','whatsapp_cloud','exotel','plivo','twilio'));

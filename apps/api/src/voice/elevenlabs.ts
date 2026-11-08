import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AgentConfig } from './prompt.js';

/**
 * ElevenLabs does speech only: it listens, turns speech into text, sends the text to OUR
 * OpenAI-compatible endpoint (the "custom LLM"), and speaks what we answer. The clinic's
 * prompt, tools and safety rules never leave our server.
 *
 * Indian numbers must run on ElevenLabs' India deployment (api.in.residency.elevenlabs.io),
 * so that is the default base URL.
 */

export interface AgentSyncInput {
  clinicName: string;
  agentId: string; // ours
  config: AgentConfig;
  firstMessage: string;
  publicApiUrl: string; // e.g. https://api.example.in
  llmSecretId: string; // ElevenLabs workspace secret holding our per-agent key
  initiationSecret: string | null;
}

const LANG_CODE: Record<string, string> = { en: 'en', hi: 'hi', 'hi-Latn': 'hi', bn: 'bn', ur: 'ur' };

/** Pure: the agent definition we send to ElevenLabs. Unit-tested. */
export function agentPayload(i: AgentSyncInput) {
  const transfers = [
    ...(i.config.emergency.transferNumber ? [{ phone_number: i.config.emergency.transferNumber, condition: 'Medical emergency the caller reported' }] : []),
    ...(i.config.handoff.transferNumber ? [{ phone_number: i.config.handoff.transferNumber, condition: 'Caller should speak to clinic staff' }] : []),
  ];
  return {
    name: `${i.clinicName} — AI receptionist`.slice(0, 100),
    tags: ['doc-receptionist', `agent:${i.agentId}`],
    conversation_config: {
      agent: {
        first_message: i.firstMessage,
        language: LANG_CODE[i.config.languages[0] ?? 'hi'] ?? 'hi',
        prompt: {
          // Our endpoint builds the real prompt per turn; this text is only a label in their dashboard.
          prompt: 'Replies come from the Doc Receptionist server (custom LLM). Do not edit here.',
          llm: 'custom-llm',
          custom_llm: { url: `${i.publicApiUrl.replace(/\/$/, '')}/v1/voice/llm/${i.agentId}`, model_id: i.config.llmModel, api_key: { secret_id: i.llmSecretId } },
          built_in_tools: {
            end_call: { name: 'end_call', description: 'End the call', params: { system_tool_type: 'end_call' } },
            ...(transfers.length ? { transfer_to_number: { name: 'transfer_to_number', description: 'Transfer to clinic staff', params: { system_tool_type: 'transfer_to_number', transfers } } } : {}),
          },
        },
      },
      ...(i.config.voice.voiceId ? { tts: { voice_id: i.config.voice.voiceId } } : {}),
    },
    platform_settings: {
      overrides: { conversation_config_override: { agent: { first_message: true, language: true } }, custom_llm_extra_body: true },
      workspace_overrides: {
        conversation_initiation_client_data_webhook: {
          url: `${i.publicApiUrl.replace(/\/$/, '')}/v1/voice/elevenlabs/initiation`,
          request_headers: i.initiationSecret ? { 'X-DR-Secret': i.initiationSecret } : {},
        },
      },
    },
  };
}

export type PhoneImport =
  | { provider: 'exotel'; phoneNumber: string; label: string; accountSid: string; apiKey: string; apiToken: string; subdomain: string; appId: string }
  | { provider: 'plivo'; phoneNumber: string; label: string; sipAddress: string; username: string; password: string };

/** Pure: the phone-number import body. Exotel is native in ElevenLabs; Plivo connects as a SIP trunk. */
export function phonePayload(p: PhoneImport) {
  if (p.provider === 'exotel') {
    return { provider: 'exotel', phone_number: p.phoneNumber, label: p.label, account_sid: p.accountSid, api_key: p.apiKey, api_token: p.apiToken, api_subdomain: p.subdomain, app_id: p.appId };
  }
  return {
    provider: 'sip_trunk', phone_number: p.phoneNumber, label: p.label,
    inbound_trunk_config: { media_encryption: 'allowed' },
    outbound_trunk_config: { address: p.sipAddress, transport: 'tcp', media_encryption: 'allowed', credentials: { username: p.username, password: p.password } },
  };
}

export class VendorError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export interface VoiceVendor {
  createSecret(name: string, value: string): Promise<string>;
  upsertAgent(vendorAgentId: string | null, payload: unknown): Promise<string>;
  importPhone(body: unknown): Promise<string>;
  assignPhone(vendorPhoneId: string, vendorAgentId: string): Promise<void>;
}

export class ElevenLabsClient implements VoiceVendor {
  constructor(private readonly apiKey: string, private readonly baseUrl: string) {}
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method, headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new VendorError(`ElevenLabs ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }
  async createSecret(name: string, value: string) {
    return (await this.call<{ secret_id: string }>('POST', '/v1/convai/secrets', { type: 'new', name, value })).secret_id;
  }
  async upsertAgent(vendorAgentId: string | null, payload: unknown) {
    if (vendorAgentId) { await this.call('PATCH', `/v1/convai/agents/${encodeURIComponent(vendorAgentId)}`, payload); return vendorAgentId; }
    return (await this.call<{ agent_id: string }>('POST', '/v1/convai/agents/create', payload)).agent_id;
  }
  async importPhone(body: unknown) {
    return (await this.call<{ phone_number_id: string }>('POST', '/v1/convai/phone-numbers', body)).phone_number_id;
  }
  async assignPhone(vendorPhoneId: string, vendorAgentId: string) {
    await this.call('PATCH', `/v1/convai/phone-numbers/${encodeURIComponent(vendorPhoneId)}`, { agent_id: vendorAgentId });
  }
}

/** Records what would have been sent. Used in tests. */
export class RecordingVendor implements VoiceVendor {
  readonly sent: { op: string; body: unknown }[] = [];
  private n = 0;
  /** Test double only: keeps the secret value so tests can call our endpoint as the vendor would. */
  readonly secrets = new Map<string, string>();
  async createSecret(name: string, value: string) { this.sent.push({ op: 'secret', body: { name } }); const id = `sec_${++this.n}`; this.secrets.set(id, value); return id; }
  async upsertAgent(id: string | null, payload: unknown) { this.sent.push({ op: id ? 'update_agent' : 'create_agent', body: payload }); return id ?? `agent_${++this.n}`; }
  async importPhone(body: unknown) { this.sent.push({ op: 'import_phone', body }); return `phone_${++this.n}`; }
  async assignPhone(id: string, agent: string) { this.sent.push({ op: 'assign_phone', body: { id, agent } }); }
}

/**
 * Post-call webhook signature: header "t=<unix>,v0=<hex hmac_sha256(secret, `${t}.${rawBody}`)>".
 * Rejects stale timestamps (default 30 minutes) to stop replays.
 */
export function verifyElevenLabsSignature(secret: string, header: string | undefined, rawBody: Buffer, now = Date.now(), toleranceSec = 1800): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const t = Number(parts.t);
  const v0 = parts.v0;
  if (!Number.isFinite(t) || !v0) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(v0);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signElevenLabs(secret: string, rawBody: Buffer | string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v0=${createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex')}`;
}

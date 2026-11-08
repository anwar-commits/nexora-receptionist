import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Outbound messaging behind one interface. Providers:
 *  - sandbox: a test channel for development and staging. Nothing leaves the server;
 *    refused in production.
 *  - whatsapp_cloud: Meta WhatsApp Business Cloud API.
 * SMS (DLT-registered sender) arrives with integrations (Phase 13).
 */

export interface SendResult { status: 'sent' | 'failed'; vendorMessageId: string | null; error?: string }
export interface MessagingProvider { send(toE164: string, body: string): Promise<SendResult> }

/** Messages "sent" through the sandbox, for tests and the staging test channel. */
export const sandboxOutbox: { to: string; body: string; id: string }[] = [];

export function sandboxProvider(nodeEnv: string): MessagingProvider {
  return {
    async send(to, body) {
      if (nodeEnv === 'production') return { status: 'failed', vendorMessageId: null, error: 'The test channel cannot send in production' };
      const id = `sbx_${randomBytes(9).toString('base64url')}`;
      sandboxOutbox.push({ to, body, id });
      return { status: 'sent', vendorMessageId: id };
    },
  };
}

export const GRAPH_API = 'https://graph.facebook.com/v21.0';

export function whatsappCloudProvider(opts: { phoneNumberId: string; accessToken: string; fetchImpl?: typeof fetch }): MessagingProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async send(to, body) {
      try {
        const res = await doFetch(`${GRAPH_API}/${opts.phoneNumberId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, ''), type: 'text', text: { preview_url: false, body } }),
          signal: AbortSignal.timeout(10_000),
        });
        const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
        if (!res.ok || !json.messages?.[0]?.id) {
          return { status: 'failed', vendorMessageId: null, error: json.error?.message ? `WhatsApp: ${json.error.message}` : `WhatsApp returned ${res.status}` };
        }
        return { status: 'sent', vendorMessageId: json.messages[0].id };
      } catch (e) {
        return { status: 'failed', vendorMessageId: null, error: `Could not reach WhatsApp (${(e as Error).name})` };
      }
    },
  };
}

/** Meta signs each webhook body with the app secret: X-Hub-Signature-256: sha256=<hex>. */
export function validMetaSignature(appSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`);
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export interface InboundMessage { vendorMessageId: string; fromE164: string; profileName: string | null; text: string | null; type: string; at: Date }
export interface StatusUpdate { vendorMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; error: string | null }

/** Pulls messages and delivery updates out of a WhatsApp Cloud API webhook payload. Unknown shapes are ignored. */
export function parseWhatsAppWebhook(payload: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  const p = payload as { object?: string; entry?: { changes?: { field?: string; value?: Record<string, unknown> }[] }[] };
  if (p?.object !== 'whatsapp_business_account') return { messages, statuses };
  for (const entry of p.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages' || !change.value) continue;
      const v = change.value as {
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } } }[];
        statuses?: { id?: string; status?: string; errors?: { title?: string; message?: string }[] }[];
      };
      for (const m of v.messages ?? []) {
        if (!m.id || !m.from || !/^\d{8,15}$/.test(m.from)) continue;
        const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
        messages.push({ vendorMessageId: m.id, fromE164: `+${m.from}`, profileName: name, text, type: m.type ?? 'unknown', at: new Date(Number(m.timestamp ?? 0) * 1000 || Date.now()) });
      }
      for (const s of v.statuses ?? []) {
        if (!s.id || !['sent', 'delivered', 'read', 'failed'].includes(s.status ?? '')) continue;
        statuses.push({ vendorMessageId: s.id, status: s.status as StatusUpdate['status'], error: s.errors?.[0]?.message ?? s.errors?.[0]?.title ?? null });
      }
    }
  }
  return { messages, statuses };
}

/** WhatsApp lets a business send free-form text only within 24 hours of the customer's last message. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const windowOpen = (lastInboundAt: Date | null, now = new Date()) => !!lastInboundAt && now.getTime() - lastInboundAt.getTime() < WHATSAPP_WINDOW_MS;

import { channelAccountBody, conversationUpdateBody, replyBody, simulateInboundBody } from '@dr/contracts';
import { QueryTypes } from '@dr/db';
import { Router, type Request } from 'express';
import type { Deps } from '../context.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { auditFromReq } from '../lib/audit.js';
import { decrypt, encrypt, hmac, randomToken, safeEqual } from '../lib/crypto.js';
import {
  parseWhatsAppWebhook, sandboxProvider, validMetaSignature, whatsappCloudProvider, windowOpen, type InboundMessage, type MessagingProvider,
} from '../lib/messaging.js';
import { patientPhoneHash } from '../lib/patients.js';
import { grant, parse, requireOrg, requirePermission, requireUser } from '../middleware.js';

/**
 * Phase 7 inbox: one thread per person and channel number. Inbound WhatsApp arrives by signed webhook;
 * unknown numbers become leads; replies obey WhatsApp's 24-hour rule.
 */

type Repl = Record<string, unknown>;
const badRequest = (message: string) => new HttpError(400, 'validation_failed', message);
const mask = (e164: string) => { const d = e164.replace(/^\+91/, ''); return d.length === 10 ? `${d.slice(0, 2)}•• ••• ${d.slice(7)}` : `${e164.slice(0, 4)}•••${e164.slice(-3)}`; };

export function inboxRouter(deps: Deps): Router {
  const { db, config } = deps;
  const r = Router();
  const user = requireUser(deps);
  const org = requireOrg(deps);
  const inOrg = <T>(req: Request, fn: () => Promise<T>) => db.withContext({ orgId: req.ctx!.org!.id, userId: req.ctx!.userId }, fn);
  const q = <T extends object>(sql: string, replacements: Repl = {}) => db.sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });
  const exec = (sql: string, replacements: Repl = {}) => db.sequelize.query(sql, { replacements });
  const partyHash = (phone: string) => patientPhoneHash(deps, phone); // same key as patients and leads, so threads link to them

  async function providerFor(accountId: string): Promise<MessagingProvider> {
    const [a] = await q<{ provider: string; vendor_ref: string | null; secret_enc: Buffer | null }>(
      `SELECT ca.provider, ca.vendor_ref, ic.secret_enc FROM app.channel_accounts ca
         LEFT JOIN app.integration_credentials ic ON ic.channel_account_id = ca.id AND ic.status = 'active' WHERE ca.id = :id AND ca.is_active`, { id: accountId });
    if (!a) throw conflict('This number is disconnected');
    if (a.provider === 'sandbox') return sandboxProvider(config.NODE_ENV);
    if (a.provider === 'whatsapp_cloud' && a.secret_enc && a.vendor_ref) {
      const secret = JSON.parse(decrypt(config.dataKey, a.secret_enc)) as { accessToken: string };
      return whatsappCloudProvider({ phoneNumberId: a.vendor_ref, accessToken: secret.accessToken });
    }
    throw conflict('This number has no working connection');
  }

  // ---------- scope ----------
  function convScope(req: Request, perm: string) {
    const g = grant(req, perm);
    if (g.scope === 'org' || g.scope === 'branch') return { sql: 'TRUE', repl: {} as Repl };
    if (g.scope === 'assigned') {
      return { sql: `(c.assignee_user_id = :me OR EXISTS (SELECT 1 FROM app.leads l WHERE l.id = c.lead_id AND l.owner_user_id = :me))`, repl: { me: req.ctx!.userId } as Repl };
    }
    return { sql: 'FALSE', repl: {} as Repl };
  }

  const CONV_SELECT = `
    SELECT c.id, c.channel, c.channel_account_id, ca.display_name AS account_name, ca.address AS account_address, ca.provider, c.status, c.handled_by,
           c.assignee_user_id, au.full_name AS assignee_name, c.last_message_at, c.last_inbound_at, c.unread_count, c.party_phone_enc,
           c.lead_id, l.display_name AS lead_name, l.stage AS lead_stage, pp.id AS patient_profile_id, pp.mrn, p.full_name AS patient_name,
           (SELECT m.body FROM app.messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
           (SELECT m.direction FROM app.messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_direction
      FROM app.conversations c
      LEFT JOIN app.channel_accounts ca ON ca.id = c.channel_account_id
      LEFT JOIN app.users au ON au.id = c.assignee_user_id
      LEFT JOIN app.leads l ON l.id = c.lead_id
      LEFT JOIN app.patient_profiles pp ON pp.patient_id = c.patient_id AND pp.organization_id = c.organization_id
      LEFT JOIN app.patients p ON p.id = c.patient_id`;
  const convJson = (c: Record<string, unknown>, opts: { full?: boolean } = {}) => {
    const phone = c.party_phone_enc ? decrypt(config.dataKey, c.party_phone_enc as Buffer) : null;
    return {
      id: c.id, channel: c.channel, account: { id: c.channel_account_id, name: c.account_name, address: c.account_address, isTest: c.provider === 'sandbox' },
      status: c.status, assignee: c.assignee_user_id ? { id: c.assignee_user_id, name: c.assignee_name } : null,
      party: {
        name: (c.patient_name ?? c.lead_name ?? null) as string | null, phone: phone ? (opts.full ? phone : mask(phone)) : null,
        patient: c.patient_profile_id ? { profileId: c.patient_profile_id, mrn: c.mrn } : null, lead: c.lead_id ? { id: c.lead_id, stage: c.lead_stage } : null,
      },
      lastMessageAt: c.last_message_at ? new Date(c.last_message_at as string).toISOString() : null,
      lastInboundAt: c.last_inbound_at ? new Date(c.last_inbound_at as string).toISOString() : null,
      lastMessage: c.last_body ? { body: c.last_body, direction: c.last_direction } : null,
      unread: c.unread_count, replyWindowOpen: c.channel !== 'whatsapp' || windowOpen(c.last_inbound_at ? new Date(c.last_inbound_at as string) : null),
    };
  };

  async function loadConv(req: Request, id: string, perm: string) {
    const s = convScope(req, perm);
    const [c] = await q<Record<string, unknown>>(`${CONV_SELECT} WHERE c.id = :id AND ${s.sql}`, { id, ...s.repl });
    if (!c) throw notFound('Conversation not found');
    return c;
  }

  // =====================================================================
  // Ingest (webhooks and the test channel share this)
  // =====================================================================
  async function ingest(orgId: string, accountId: string, kind: 'whatsapp' | 'sms', m: InboundMessage) {
    return db.withContext({ orgId }, async () => {
      if (m.vendorMessageId) {
        const [seen] = await q<{ id: string }>(`SELECT id FROM app.messages WHERE vendor_message_id = :v`, { v: m.vendorMessageId });
        if (seen) return { conversationId: null, duplicate: true };
      }
      const hash = partyHash(m.fromE164);
      let [conv] = await q<{ id: string; patient_id: string | null; lead_id: string | null }>(
        `SELECT id, patient_id, lead_id FROM app.conversations WHERE channel_account_id = :a AND external_party = :h AND status <> 'closed' FOR UPDATE`, { a: accountId, h: hash });
      if (!conv) {
        // Link to the person if this number belongs to exactly one registered patient, and to their open lead.
        const patients = await q<{ id: string }>(`SELECT p.id FROM app.patients p JOIN app.patient_profiles pp ON pp.patient_id = p.id WHERE p.phone_hash = :h AND pp.deleted_at IS NULL`, { h: hash });
        const [lead] = await q<{ id: string }>(`SELECT id FROM app.leads WHERE phone_hash = :h AND stage NOT IN ('retained','lost') ORDER BY created_at DESC LIMIT 1`, { h: hash });
        let leadId = lead?.id ?? null;
        if (!leadId && patients.length === 0) {
          // A new number writing in is an enquiry: it goes on the pipeline.
          const [created] = await q<{ id: string }>(
            `INSERT INTO app.leads (organization_id, display_name, phone_hash, phone_e164_enc, source, source_detail, owner_kind)
             VALUES (:org, :name, :h, :enc, :source, CAST(:detail AS jsonb), 'unassigned') RETURNING id`,
            { org: orgId, name: m.profileName, h: hash, enc: encrypt(config.dataKey, m.fromE164), source: kind === 'whatsapp' ? 'whatsapp' : 'other', detail: JSON.stringify({ channel: kind }) });
          leadId = created!.id;
          await exec(`INSERT INTO app.lead_events (organization_id, lead_id, kind, to_stage, actor_kind, note) VALUES (:org, :id, 'created', 'enquiry', 'patient', :note)`,
            { org: orgId, id: leadId, note: m.text ? m.text.slice(0, 500) : null });
        }
        [conv] = await q<{ id: string; patient_id: string | null; lead_id: string | null }>(
          `INSERT INTO app.conversations (organization_id, channel, channel_account_id, patient_id, lead_id, external_party, party_phone_enc, status, handled_by)
           VALUES (:org, CAST(:kind AS app.channel_kind), :a, :p, :l, :h, :enc, 'open', 'user') RETURNING id, patient_id, lead_id`,
          { org: orgId, kind, a: accountId, p: patients.length === 1 ? patients[0]!.id : null, l: leadId, h: hash, enc: encrypt(config.dataKey, m.fromE164) });
      } else if (conv.lead_id) {
        await exec(`INSERT INTO app.lead_events (organization_id, lead_id, kind, actor_kind, note) VALUES (:org, :id, 'message', 'patient', :note)`,
          { org: orgId, id: conv.lead_id, note: m.text ? m.text.slice(0, 500) : null });
      }
      await exec(
        `INSERT INTO app.messages (organization_id, conversation_id, direction, author_kind, body, media, vendor_message_id, delivery_status, created_at)
         VALUES (:org, :c, 'inbound', 'patient', :body, CAST(:media AS jsonb), :v, 'delivered', :at)`,
        { org: orgId, c: conv!.id, body: m.text ?? `[${m.type} message]`, media: JSON.stringify(m.text ? [] : [{ type: m.type }]), v: m.vendorMessageId || null, at: m.at.toISOString() });
      await exec(`UPDATE app.conversations SET last_message_at = GREATEST(COALESCE(last_message_at, :at), :at), last_inbound_at = GREATEST(COALESCE(last_inbound_at, :at), :at),
                    unread_count = unread_count + 1, status = 'open' WHERE id = :c`, { c: conv!.id, at: m.at.toISOString() });
      return { conversationId: conv!.id, duplicate: false };
    });
  }

  // =====================================================================
  // Webhooks (no sign-in; verified by Meta's signature)
  // =====================================================================
  async function webhookAccount(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [a] = await q<{ organization_id: string; kind: 'whatsapp' | 'sms'; provider: string; vendor_ref: string | null; verify_token_hash: string | null; is_active: boolean; secret_enc: Buffer | null }>(
      `SELECT * FROM app.webhook_channel_account(:id)`, { id });
    return a && a.is_active ? a : null;
  }

  r.get('/webhooks/whatsapp/:accountId', async (req, res) => {
    const a = await webhookAccount(String(req.params.accountId));
    const token = String(req.query['hub.verify_token'] ?? '');
    if (!a || req.query['hub.mode'] !== 'subscribe' || !a.verify_token_hash || !safeEqual(hmac(config.pepper, 'wa-verify', token), a.verify_token_hash)) {
      res.status(403).end();
      return;
    }
    res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  });

  r.post('/webhooks/whatsapp/:accountId', async (req, res) => {
    const a = await webhookAccount(String(req.params.accountId));
    if (!a || a.provider !== 'whatsapp_cloud' || !a.secret_enc) { res.status(404).end(); return; }
    const secret = JSON.parse(decrypt(config.dataKey, a.secret_enc)) as { appSecret: string };
    const valid = validMetaSignature(secret.appSecret, req.rawBody ?? Buffer.alloc(0), req.header('x-hub-signature-256'));
    const parsed = parseWhatsAppWebhook(req.body);
    const bodyKey = hmac(config.pepper, (req.rawBody ?? Buffer.alloc(0)).toString('base64'));
    // Rejected deliveries are logged under their own id, so a forged copy can never block the real one.
    const eventId = !valid ? `rejected:${bodyKey}:${Date.now()}:${randomToken(4)}`
      : parsed.messages[0]?.vendorMessageId ?? parsed.statuses.map((s) => `${s.vendorMessageId}:${s.status}`)[0] ?? bodyKey;
    // Record every delivery attempt (for replay and audit); duplicates are ignored.
    const [ev] = await q<{ id: string }>(
      `INSERT INTO app.webhook_events (provider, event_id, organization_id, signature_valid, payload, status)
       VALUES ('whatsapp_cloud', :e, :org, :valid, CAST(:payload AS jsonb), :status) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
      { e: eventId, org: a.organization_id, valid, payload: JSON.stringify(req.body ?? {}), status: valid ? 'received' : 'ignored' });
    if (!valid) { res.status(401).end(); return; }
    if (!ev) { res.status(200).json({ ok: true, duplicate: true }); return; }
    try {
      for (const m of parsed.messages) await ingest(a.organization_id, String(req.params.accountId), 'whatsapp', m);
      for (const s of parsed.statuses) {
        await db.withContext({ orgId: a.organization_id }, () => exec(
          `UPDATE app.messages SET delivery_status = :s, error = COALESCE(:err, error) WHERE vendor_message_id = :v
             AND (delivery_status IS NULL OR array_position(ARRAY['queued','sent','delivered','read'], delivery_status) < array_position(ARRAY['queued','sent','delivered','read'], :s) OR :s = 'failed')`,
          { s: s.status, err: s.error, v: s.vendorMessageId }));
      }
      await exec(`UPDATE app.webhook_events SET status = 'processed', processed_at = now(), attempts = attempts + 1 WHERE id = :id`, { id: ev.id });
    } catch (e) {
      await exec(`UPDATE app.webhook_events SET status = 'failed', attempts = attempts + 1, error = :err WHERE id = :id`, { id: ev.id, err: (e as Error).message.slice(0, 500) });
      throw e;
    }
    res.status(200).json({ ok: true });
  });

  // =====================================================================
  // Channel accounts (Settings › Channels)
  // =====================================================================
  r.get('/channel-accounts', user, org, requirePermission('inbox:read'), async (req, res) => {
    const rows = await inOrg(req, () => q<Record<string, unknown>>(
      `SELECT id, kind, provider, address, display_name, vendor_ref, is_active, created_at FROM app.channel_accounts WHERE kind IN ('whatsapp','sms') ORDER BY created_at`));
    res.json({
      items: rows.map((a) => ({
        id: a.id, kind: a.kind, provider: a.provider, address: a.address, displayName: a.display_name, phoneNumberId: a.vendor_ref, isActive: a.is_active,
        isTest: a.provider === 'sandbox', webhookPath: a.provider === 'whatsapp_cloud' ? `/v1/webhooks/whatsapp/${a.id}` : null,
      })),
    });
  });

  r.post('/channel-accounts', user, org, requirePermission('channel:manage'), async (req, res) => {
    const body = parse(channelAccountBody, req.body);
    if (body.provider === 'sandbox' && config.NODE_ENV === 'production') throw badRequest('Test channels are not available in production');
    const verifyToken = body.provider === 'whatsapp_cloud' ? randomToken(18) : null;
    const out = await inOrg(req, async () => {
      let account: { id: string } | undefined;
      try {
        [account] = await q<{ id: string }>(
          `INSERT INTO app.channel_accounts (organization_id, branch_id, kind, address, vendor_ref, purpose, provider, display_name, verify_token_hash)
           VALUES (:org, :branch, CAST(:kind AS app.channel_kind), :address, :ref, 'main', :provider, :name, :vth) RETURNING id`,
          { org: req.ctx!.org!.id, branch: body.branchId ?? null, kind: body.kind, address: body.address, ref: body.provider === 'whatsapp_cloud' ? body.phoneNumberId : null,
            provider: body.provider, name: body.displayName, vth: verifyToken ? hmac(config.pepper, 'wa-verify', verifyToken) : null });
      } catch (e) {
        if ((e as { original?: { code?: string } }).original?.code === '23505') throw conflict('This number is already connected');
        throw e;
      }
      if (body.provider === 'whatsapp_cloud') {
        await exec(`INSERT INTO app.integration_credentials (organization_id, provider, channel_account_id, secret_enc, config, status)
                    VALUES (:org, 'whatsapp_cloud', :a, :enc, CAST(:cfg AS jsonb), 'active')`,
          { org: req.ctx!.org!.id, a: account!.id, enc: encrypt(config.dataKey, JSON.stringify({ accessToken: body.accessToken, appSecret: body.appSecret })), cfg: JSON.stringify({ phoneNumberId: body.phoneNumberId }) });
      }
      await auditFromReq(req, { action: 'channel.connect', targetType: 'channel_account', targetId: account!.id, details: { provider: body.provider, kind: body.kind } });
      return { id: account!.id };
    });
    // The verify token is shown once, to paste into Meta's webhook settings.
    res.status(201).json({ ...out, verifyToken, webhookPath: body.provider === 'whatsapp_cloud' ? `/v1/webhooks/whatsapp/${out.id}` : null });
  });

  r.delete('/channel-accounts/:id', user, org, requirePermission('channel:manage'), async (req, res) => {
    await inOrg(req, async () => {
      const [a] = await q<{ id: string }>(`UPDATE app.channel_accounts SET is_active = false WHERE id = :id RETURNING id`, { id: String(req.params.id) });
      if (!a) throw notFound();
      await exec(`UPDATE app.integration_credentials SET status = 'revoked' WHERE channel_account_id = :id`, { id: a.id });
      await auditFromReq(req, { action: 'channel.disconnect', targetType: 'channel_account', targetId: a.id });
    });
    res.status(204).end();
  });

  /** Staging only: pretend a patient wrote to a test channel. */
  r.post('/channel-accounts/:id/simulate-inbound', user, org, requirePermission('inbox:reply'), async (req, res) => {
    if (config.NODE_ENV === 'production') throw forbidden('Not available in production');
    const body = parse(simulateInboundBody, req.body);
    const [a] = await inOrg(req, () => q<{ id: string; kind: 'whatsapp' | 'sms'; provider: string }>(`SELECT id, kind, provider FROM app.channel_accounts WHERE id = :id AND is_active`, { id: String(req.params.id) }));
    if (!a) throw notFound();
    if (a.provider !== 'sandbox') throw badRequest('Only test channels can receive simulated messages');
    const out = await ingest(req.ctx!.org!.id, a.id, a.kind, { vendorMessageId: `sbx_in_${randomToken(9)}`, fromE164: body.from, profileName: body.name ?? null, text: body.body, type: 'text', at: new Date() });
    res.status(201).json(out);
  });

  // =====================================================================
  // Conversations
  // =====================================================================
  r.get('/conversations', user, org, requirePermission('inbox:read'), async (req, res) => {
    const items = await inOrg(req, async () => {
      const s = convScope(req, 'inbox:read');
      const conds = [s.sql];
      const repl: Repl = { ...s.repl };
      const status = String(req.query.status ?? 'open');
      if (status !== 'all') { conds.push('c.status = :status'); repl.status = status; }
      if (req.query.mine === '1') { conds.push('c.assignee_user_id = :me2'); repl.me2 = req.ctx!.userId; }
      if (req.query.unassigned === '1') conds.push('c.assignee_user_id IS NULL');
      if (req.query.patientProfileId) { conds.push('pp.id = :pid'); repl.pid = String(req.query.patientProfileId); }
      const rows = await q<Record<string, unknown>>(`${CONV_SELECT} WHERE ${conds.join(' AND ')} ORDER BY c.last_message_at DESC NULLS LAST LIMIT 200`, repl);
      return rows.map((c) => convJson(c));
    });
    res.json({ items });
  });

  r.get('/conversations/:id', user, org, requirePermission('inbox:read'), async (req, res) => {
    const out = await inOrg(req, async () => {
      const c = await loadConv(req, String(req.params.id), 'inbox:read');
      const msgs = await q<Record<string, unknown>>(
        `SELECT m.id, m.direction, m.author_kind, u.full_name AS author_name, m.body, m.media, m.delivery_status, m.error, m.created_at
           FROM app.messages m LEFT JOIN app.users u ON u.id = m.author_id WHERE m.conversation_id = :id ORDER BY m.created_at, m.id`, { id: c.id });
      if (Number(c.unread_count) > 0) await exec(`UPDATE app.conversations SET unread_count = 0 WHERE id = :id`, { id: c.id });
      return {
        ...convJson({ ...c, unread_count: 0 }, { full: true }),
        messages: msgs.map((m) => ({ id: m.id, direction: m.direction, author: m.author_kind === 'user' ? m.author_name : m.author_kind, body: m.body, media: m.media, status: m.delivery_status, error: m.error, at: new Date(m.created_at as string).toISOString() })),
      };
    });
    res.json(out);
  });

  r.post('/conversations/:id/messages', user, org, requirePermission('inbox:reply'), async (req, res) => {
    const body = parse(replyBody, req.body);
    const out = await inOrg(req, async () => {
      const c = await loadConv(req, String(req.params.id), 'inbox:reply');
      if (c.status === 'closed') throw conflict('Reopen the conversation to reply');
      if (c.channel === 'whatsapp' && !windowOpen(c.last_inbound_at ? new Date(c.last_inbound_at as string) : null)) {
        throw conflict('More than 24 hours since the patient last wrote. WhatsApp allows only an approved template now; templates arrive with integrations. Call the patient instead.');
      }
      if (!c.party_phone_enc) throw conflict('No number to reply to');
      const to = decrypt(config.dataKey, c.party_phone_enc as Buffer);
      const provider = await providerFor(c.channel_account_id as string);
      const sent = await provider.send(to, body.body);
      const [m] = await q<{ id: string }>(
        `INSERT INTO app.messages (organization_id, conversation_id, direction, author_kind, author_id, body, vendor_message_id, delivery_status, error)
         VALUES (:org, :c, 'outbound', 'user', :me, :body, :v, :status, :err) RETURNING id`,
        { org: req.ctx!.org!.id, c: c.id, me: req.ctx!.userId, body: body.body, v: sent.vendorMessageId, status: sent.status, err: sent.error ?? null });
      await exec(`UPDATE app.conversations SET last_message_at = now(), assignee_user_id = COALESCE(assignee_user_id, :me), handled_by = 'user' WHERE id = :id`, { id: c.id, me: req.ctx!.userId });
      if (c.lead_id) await exec(`INSERT INTO app.lead_events (organization_id, lead_id, kind, actor_kind, actor_id, note) VALUES (:org, :l, 'message', 'user', :me, :note)`,
        { org: req.ctx!.org!.id, l: c.lead_id, me: req.ctx!.userId, note: `Replied: ${body.body.slice(0, 300)}` });
      await auditFromReq(req, { action: 'message.send', targetType: 'conversation', targetId: c.id as string, details: { status: sent.status } });
      return { id: m!.id, status: sent.status, error: sent.error ?? null };
    });
    res.status(out.status === 'failed' ? 502 : 201).json(out);
  });

  r.patch('/conversations/:id', user, org, requirePermission('inbox:reply'), async (req, res) => {
    const body = parse(conversationUpdateBody, req.body);
    const out = await inOrg(req, async () => {
      const c = await loadConv(req, String(req.params.id), 'inbox:reply');
      if (body.assigneeUserId) {
        const [m] = await q<{ id: string }>(`SELECT id FROM app.memberships WHERE organization_id = :org AND user_id = :u AND status = 'active'`, { org: req.ctx!.org!.id, u: body.assigneeUserId });
        if (!m) throw badRequest('That person is not active staff in this clinic');
        if (grant(req, 'inbox:reply').scope === 'assigned' && body.assigneeUserId !== req.ctx!.userId) throw forbidden('You can only take conversations yourself');
      }
      let patientId: string | null | undefined;
      if (body.patientProfileId !== undefined) {
        if (body.patientProfileId === null) patientId = null;
        else {
          const [p] = await q<{ patient_id: string }>(`SELECT patient_id FROM app.patient_profiles WHERE id = :id AND deleted_at IS NULL`, { id: body.patientProfileId });
          if (!p) throw badRequest('Unknown patient');
          patientId = p.patient_id;
        }
      }
      if (body.status === 'open' && c.status === 'closed') {
        const [other] = await q<{ id: string }>(`SELECT id FROM app.conversations WHERE channel_account_id = (SELECT channel_account_id FROM app.conversations WHERE id = :id)
            AND external_party = (SELECT external_party FROM app.conversations WHERE id = :id) AND status <> 'closed' AND id <> :id`, { id: c.id });
        if (other) throw conflict('A newer conversation with this person is already open');
      }
      await exec(`UPDATE app.conversations SET status = COALESCE(:status, status),
                    assignee_user_id = CASE WHEN :aSet THEN CAST(:a AS uuid) ELSE assignee_user_id END,
                    patient_id = CASE WHEN :pSet THEN CAST(:p AS uuid) ELSE patient_id END WHERE id = :id`,
        { id: c.id, status: body.status ?? null, aSet: body.assigneeUserId !== undefined, a: body.assigneeUserId ?? null, pSet: patientId !== undefined, p: patientId ?? null });
      await auditFromReq(req, { action: 'conversation.update', targetType: 'conversation', targetId: c.id as string, details: body });
      return convJson(await loadConv(req, c.id as string, 'inbox:read'));
    });
    res.json(out);
  });

  return r;
}

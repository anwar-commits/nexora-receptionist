import { agentDraftBody, callListQuery, handoffCloseBody, phoneNumberBody, testConsoleBody } from '@dr/contracts';
import { QueryTypes } from '@dr/db';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Deps } from '../context.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { audit, auditFromReq } from '../lib/audit.js';
import { decrypt, encrypt, hmac, randomToken, safeEqual } from '../lib/crypto.js';
import { patientPhoneHash } from '../lib/patients.js';
import { grant, parse, requireOrg, requirePermission, requireUser } from '../middleware.js';
import { runTurn, type TurnOutput } from '../voice/brain.js';
import { agentPayload, phonePayload, verifyElevenLabsSignature, type PhoneImport } from '../voice/elevenlabs.js';
import { DEFAULT_CONFIG, firstMessage, type AgentConfig } from '../voice/prompt.js';
import { SAFETY_SCRIPTS, type Lang } from '../voice/safety.js';
import { inRollback, runSuite, suiteFixture } from '../voice/suite.js';
import { allowedTools, type CallCtx, type SystemAction } from '../voice/tools.js';

/**
 * Phase 8: the AI voice receptionist.
 *  - Vendor-facing: our OpenAI-compatible "custom LLM" endpoint that ElevenLabs calls every turn,
 *    the call-start webhook, and the signed post-call webhook (transcript, audio).
 *  - Clinic-facing: settings, test console, the 40-case safety suite, publish, phone numbers,
 *    calls, hand-offs and safety reviews.
 */

type Repl = Record<string, unknown>;
const badRequest = (message: string) => new HttpError(400, 'validation_failed', message);
const KEY_PURPOSE = 'voice-llm-key';
const mask = (e164: string) => { const d = e164.replace(/^\+91/, ''); return d.length === 10 ? `${d.slice(0, 2)}•• ••• ${d.slice(7)}` : `${e164.slice(0, 4)}•••${e164.slice(-3)}`; };
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

interface VersionRow { id: string; version: number; persona: AgentConfig['persona']; voice: AgentConfig['voice']; languages: Lang[]; intake_questions: string[]; guardrails: AgentConfig['guardrails']; handoff_rules: AgentConfig['handoff']; emergency_protocol: AgentConfig['emergency']; llm_model: string }
export const configFromVersion = (v: VersionRow): AgentConfig => ({
  persona: v.persona, voice: v.voice, languages: v.languages, intakeQuestions: v.intake_questions, guardrails: v.guardrails,
  handoff: v.handoff_rules, emergency: v.emergency_protocol, llmModel: v.llm_model,
});

/** Accepts what phone networks send (+91…, 91…, 0…, 10 digits) and returns E.164, or null. */
export function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const d = raw.replace(/[^\d+]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(d)) return d;
  if (/^91\d{10}$/.test(d)) return `+${d}`;
  if (/^0\d{10}$/.test(d)) return `+91${d.slice(1)}`;
  if (/^[6-9]\d{9}$/.test(d)) return `+91${d}`;
  return null;
}

export function voiceRouter(deps: Deps): Router {
  const { db, config } = deps;
  const r = Router();
  const user = requireUser(deps);
  const org = requireOrg(deps);
  const inOrg = <T>(req: Request, fn: () => Promise<T>) => db.withContext({ orgId: req.ctx!.org!.id, userId: req.ctx!.userId }, fn);
  const q = <T extends object>(sql: string, replacements: Repl = {}) => db.sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });
  const exec = (sql: string, replacements: Repl = {}) => db.sequelize.query(sql, { replacements });
  const orgId = (req: Request) => req.ctx!.org!.id;

  // =====================================================================
  // Vendor-facing: custom LLM endpoint (ElevenLabs → us, every turn)
  // =====================================================================
  r.post('/voice/llm/:agentId/chat/completions', async (req, res) => {
    const agentId = String(req.params.agentId);
    if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw notFound();
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const [a] = await q<{ organization_id: string; tool_key_hash: string | null; live_version_id: string | null; status: string }>(`SELECT * FROM app.voice_agent(:id)`, { id: agentId });
    if (!a || !a.tool_key_hash || !token || !safeEqual(hmac(config.pepper, KEY_PURPOSE, token), a.tool_key_hash)) throw new HttpError(401, 'unauthenticated', 'Invalid key');
    const body = (req.body ?? {}) as { messages?: { role: string; content: unknown }[]; stream?: boolean; model?: string; tools?: { type?: string; function?: { name: string; parameters?: { properties?: Record<string, unknown> } } }[]; elevenlabs_extra_body?: Record<string, unknown> };
    const orgIdV = a.organization_id;

    if (a.status !== 'live' || !a.live_version_id) {
      return replyOpenAi(res, body, 'Sorry, the clinic\'s assistant is not available right now. Please call again during clinic hours.', [], []);
    }
    const extra = body.elevenlabs_extra_body ?? {};
    const ctx = await db.withContext({ orgId: orgIdV }, () => callContext(orgIdV, agentId, a.live_version_id!, typeof extra.dr_call_id === 'string' ? extra.dr_call_id : null, typeof extra.conversation_id === 'string' ? extra.conversation_id : null));
    const msgs = (body.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role as 'user' | 'assistant', text: textOf(m.content) }));
    const last = msgs.at(-1);
    const callerText = last?.role === 'user' ? last.text : '';
    const history = last?.role === 'user' ? msgs.slice(0, -1) : msgs;
    const out = await runTurn(deps, deps.llm, ctx, (fn) => db.withContext({ orgId: orgIdV }, fn), { history, callerText });
    return replyOpenAi(res, body, out.text, out.actions, body.tools ?? []);
  });

  /** Finds (or, if the call-start webhook did not run, creates) the call and its agent run. */
  async function callContext(org: string, agentId: string, versionId: string, callId: string | null, conversationId: string | null): Promise<CallCtx> {
    let [call] = callId && /^[0-9a-f-]{36}$/i.test(callId)
      ? await q<{ id: string; agent_version_id: string | null; caller_phone_enc: Buffer | null }>(`SELECT id, agent_version_id, caller_phone_enc FROM app.calls WHERE id = :id AND agent_id = :a`, { id: callId, a: agentId })
      : [];
    if (!call && conversationId) [call] = await q<{ id: string; agent_version_id: string | null; caller_phone_enc: Buffer | null }>(`SELECT id, agent_version_id, caller_phone_enc FROM app.calls WHERE voice_vendor = 'elevenlabs' AND voice_conversation_id = :c`, { c: conversationId });
    if (!call) {
      [call] = await q<{ id: string; agent_version_id: string | null; caller_phone_enc: Buffer | null }>(`INSERT INTO app.calls (organization_id, direction, voice_vendor, voice_conversation_id, agent_id, agent_version_id, status, started_at, answered_at)
        VALUES (:org, 'inbound', 'elevenlabs', :conv, :a, :v, 'in_progress', now(), now()) RETURNING id, agent_version_id, caller_phone_enc`, { org, conv: conversationId, a: agentId, v: versionId });
    }
    const vId = call!.agent_version_id ?? versionId;
    const [v] = await q<VersionRow>(`SELECT * FROM app.ai_agent_versions WHERE id = :id`, { id: vId });
    let [run] = await q<{ id: string }>(`SELECT id FROM app.agent_runs WHERE call_id = :c ORDER BY started_at LIMIT 1`, { c: call!.id });
    if (!run) [run] = await q<{ id: string }>(`INSERT INTO app.agent_runs (organization_id, agent_version_id, trigger, call_id, status) VALUES (:org, :v, 'inbound_call', :c, 'running') RETURNING id`, { org, v: vId, c: call!.id });
    const [o] = await q<{ timezone: string }>(`SELECT timezone FROM app.organizations WHERE id = :id`, { id: org });
    return {
      orgId: org, callId: call!.id, agentId, versionId: vId, runId: run!.id, config: configFromVersion(v!), timeZone: o?.timezone ?? 'Asia/Kolkata',
      callerPhone: call!.caller_phone_enc ? decrypt(config.dataKey, call!.caller_phone_enc) : null,
    };
  }

  // =====================================================================
  // Vendor-facing: call-start webhook (ElevenLabs → us when a call connects)
  // =====================================================================
  r.post('/voice/elevenlabs/initiation', async (req, res) => {
    const secret = config.ELEVENLABS_INIT_SECRET;
    const given = String(req.headers['x-dr-secret'] ?? '');
    if (!secret || !given || !safeEqual(given, secret)) throw new HttpError(401, 'unauthenticated', 'Invalid secret');
    const b = (req.body ?? {}) as { caller_id?: string; agent_id?: string; called_number?: string; call_sid?: string; conversation_id?: string };
    const [a] = await q<{ id: string; organization_id: string; live_version_id: string | null; status: string }>(`SELECT * FROM app.voice_agent_by_vendor(:v)`, { v: String(b.agent_id ?? '') });
    if (!a) throw notFound('Unknown agent');
    const caller = normalisePhone(b.caller_id);
    const called = normalisePhone(b.called_number);
    const out = await db.withContext({ orgId: a.organization_id }, async () => {
      const [o] = await q<{ name: string }>(`SELECT name FROM app.organizations WHERE id = :id`, { id: a.organization_id });
      const [ca] = called ? await q<{ id: string; branch_id: string | null; telephony_vendor: string | null }>(`SELECT id, branch_id, telephony_vendor FROM app.channel_accounts WHERE kind = 'phone' AND address = :n AND is_active`, { n: called }) : [];
      let [call] = b.conversation_id ? await q<{ id: string }>(`SELECT id FROM app.calls WHERE voice_vendor = 'elevenlabs' AND voice_conversation_id = :c`, { c: b.conversation_id }) : [];
      if (!call) {
        [call] = await q<{ id: string }>(
          `INSERT INTO app.calls (organization_id, branch_id, channel_account_id, direction, telephony_vendor, vendor_call_id, voice_vendor, voice_conversation_id, agent_id, agent_version_id,
                                  caller_phone_hash, caller_phone_enc, called_number, status, started_at, answered_at, recording_notice_at)
           VALUES (:org, :branch, :ca, 'inbound', CAST(:tv AS app.telephony_vendor), :sid, 'elevenlabs', :conv, :a, :v, :h, :enc, :called, 'in_progress', now(), now(), now()) RETURNING id`,
          { org: a.organization_id, branch: ca?.branch_id ?? null, ca: ca?.id ?? null, tv: ca?.telephony_vendor ?? null, sid: b.call_sid ?? null, conv: b.conversation_id ?? null,
            a: a.id, v: a.live_version_id, h: caller ? patientPhoneHash(deps, caller) : null, enc: caller ? encrypt(config.dataKey, caller) : null, called });
        if (a.live_version_id) await exec(`INSERT INTO app.agent_runs (organization_id, agent_version_id, trigger, call_id, status) VALUES (:org, :v, 'inbound_call', :c, 'running')`, { org: a.organization_id, v: a.live_version_id, c: call!.id });
      }
      const [v] = a.live_version_id ? await q<VersionRow>(`SELECT * FROM app.ai_agent_versions WHERE id = :id`, { id: a.live_version_id }) : [];
      const cfg = v ? configFromVersion(v) : DEFAULT_CONFIG;
      const known = caller ? await q<{ n: string }>(`SELECT count(*) AS n FROM app.patients p JOIN app.patient_profiles pp ON pp.patient_id = p.id WHERE p.phone_hash = :h AND pp.deleted_at IS NULL`, { h: patientPhoneHash(deps, caller) }) : [{ n: '0' }];
      return { callId: call!.id, clinic: o?.name ?? 'the clinic', cfg, known: Number(known[0]?.n ?? 0) > 0 };
    });
    res.json({
      type: 'conversation_initiation_client_data',
      dynamic_variables: { clinic_name: out.clinic, caller_known: out.known ? 'yes' : 'no' },
      conversation_config_override: { agent: { first_message: firstMessage(out.cfg, out.clinic) } },
      custom_llm_extra_body: { dr_call_id: out.callId },
    });
  });

  // =====================================================================
  // Clinic-facing: settings
  // =====================================================================
  const manage = [user, org, requirePermission('agent:manage')] as RequestHandler[];
  const loadAgent = async () => {
    const [a] = await q<{ id: string; status: string; draft: AgentConfig | null; live_version_id: string | null; vendor_agent_id: string | null; vendor_synced_at: Date | null; vendor_sync_error: string | null }>(
      `SELECT id, status, draft, live_version_id, vendor_agent_id, vendor_synced_at, vendor_sync_error FROM app.ai_agents WHERE kind = 'voice_receptionist' ORDER BY created_at LIMIT 1`);
    return a;
  };
  const requireAgent = async () => { const a = await loadAgent(); if (!a) throw notFound('Set up the AI receptionist first'); return a; };
  const draftOf = (a: { draft: AgentConfig | null }): AgentConfig => ({ ...DEFAULT_CONFIG, ...(a.draft ?? {}) });

  async function agentView(req: Request) {
    const a = await loadAgent();
    const setup = {
      model: deps.llm?.kind === 'anthropic', voice: !!deps.voice, publicUrl: !!config.PUBLIC_API_URL, voiceBaseUrl: config.ELEVENLABS_BASE_URL,
      postCallWebhook: !!config.ELEVENLABS_WEBHOOK_SECRET, initiationWebhook: !!config.ELEVENLABS_INIT_SECRET,
    };
    const canApprove = ['owner', 'doctor'].includes(req.ctx!.org!.roleKey);
    const canManage = req.ctx!.org!.grants.has('agent:manage');
    if (!a) return { setup, agent: null, canApproveEmergency: canApprove, canManage, scripts: SAFETY_SCRIPTS };
    const versions = await q<{ id: string; version: number; suite_summary: unknown; suite_passed_at: Date | null; published_at: Date | null; publisher: string | null; created_at: Date; emergency_protocol: AgentConfig['emergency'] }>(
      `SELECT v.id, v.version, v.suite_summary, v.suite_passed_at, v.published_at, u.full_name AS publisher, v.created_at, v.emergency_protocol
         FROM app.ai_agent_versions v LEFT JOIN app.users u ON u.id = v.published_by WHERE v.agent_id = :a ORDER BY v.version DESC LIMIT 10`, { a: a.id });
    const numbers = await q<{ id: string; address: string; provider: string; display_name: string | null; branch_id: string | null; vendor_phone_id: string | null; is_active: boolean }>(
      `SELECT id, address, provider, display_name, branch_id, vendor_phone_id, is_active FROM app.channel_accounts WHERE kind = 'phone' AND agent_id = :a AND is_active ORDER BY created_at`, { a: a.id });
    const cfg = draftOf(a);
    return {
      setup, canApproveEmergency: canApprove, canManage, scripts: SAFETY_SCRIPTS,
      agent: {
        id: a.id, status: a.status, draft: cfg, liveVersionId: a.live_version_id, firstMessage: firstMessage(cfg, await clinicName()),
        vendor: { agentId: a.vendor_agent_id, syncedAt: iso(a.vendor_synced_at), error: a.vendor_sync_error },
        versions: versions.map((v) => ({ id: v.id, version: v.version, suite: v.suite_summary, suitePassedAt: iso(v.suite_passed_at), publishedAt: iso(v.published_at), publishedBy: v.publisher, createdAt: iso(v.created_at), emergencyApproved: !!v.emergency_protocol?.approvedAt, live: v.id === a.live_version_id })),
        numbers: numbers.map((n) => ({ id: n.id, number: n.address, provider: n.provider, label: n.display_name, branchId: n.branch_id, connected: !!n.vendor_phone_id })),
      },
    };
  }
  const clinicName = async () => (await q<{ name: string }>(`SELECT name FROM app.organizations WHERE id = NULLIF(current_setting('app.org_id', true), '')::uuid`))[0]?.name ?? 'the clinic';

  // Doctors may read it to sign off the emergency protocol; only managers change anything.
  const manageOrApprove: RequestHandler = (req, _res, next) => {
    if (req.ctx!.org!.grants.has('agent:manage') || req.ctx!.org!.roleKey === 'doctor') return next();
    next(forbidden());
  };
  r.get('/ai-receptionist', user, org, manageOrApprove, async (req, res) => { res.json(await inOrg(req, () => agentView(req))); });

  r.post('/ai-receptionist', ...manage, async (req, res) => {
    const out = await inOrg(req, async () => {
      if (!(await loadAgent())) {
        const [o] = await q<{ languages: string[] }>(`SELECT languages FROM app.organizations WHERE id = :id`, { id: orgId(req) });
        const langs = (o?.languages ?? []).filter((l): l is Lang => ['en', 'hi', 'hi-Latn', 'bn', 'ur'].includes(l));
        const draft: AgentConfig = { ...DEFAULT_CONFIG, languages: langs.includes('hi') ? ['hi-Latn', ...langs.filter((l) => l !== 'hi-Latn')] as Lang[] : (langs.length ? langs : DEFAULT_CONFIG.languages) };
        const [a] = await q<{ id: string }>(`INSERT INTO app.ai_agents (organization_id, kind, name, status, draft) VALUES (:org, 'voice_receptionist', 'AI receptionist', 'draft', CAST(:d AS jsonb)) RETURNING id`, { org: orgId(req), d: JSON.stringify(draft) });
        await auditFromReq(req, { action: 'agent.create', targetType: 'ai_agent', targetId: a!.id });
      }
      return agentView(req);
    });
    res.status(201).json(out);
  });

  r.put('/ai-receptionist/draft', ...manage, async (req, res) => {
    const body = parse(agentDraftBody, req.body);
    const out = await inOrg(req, async () => {
      const a = await requireAgent();
      const cur = draftOf(a);
      // Changing where emergencies are transferred needs a fresh sign-off.
      const emergencyChanged = cur.emergency.transferNumber !== body.emergency.transferNumber;
      const next: AgentConfig = {
        ...cur, ...body,
        emergency: emergencyChanged ? { ...cur.emergency, transferNumber: body.emergency.transferNumber, approvedBy: null, approvedByName: null, approvedAt: null } : cur.emergency,
      };
      await exec(`UPDATE app.ai_agents SET draft = CAST(:d AS jsonb) WHERE id = :id`, { d: JSON.stringify(next), id: a.id });
      await auditFromReq(req, { action: 'agent.draft.update', targetType: 'ai_agent', targetId: a.id, details: { emergencyChanged } });
      return agentView(req);
    });
    res.json(out);
  });

  /** A doctor or the owner signs off the emergency protocol (scripts + transfer number) before going live. */
  r.post('/ai-receptionist/emergency-approval', user, org, async (req, res) => {
    if (!['owner', 'doctor'].includes(req.ctx!.org!.roleKey)) throw forbidden('Only a doctor or the clinic owner can approve the emergency protocol');
    const out = await inOrg(req, async () => {
      const a = await requireAgent();
      const [me] = await q<{ full_name: string }>(`SELECT full_name FROM app.users WHERE id = :id`, { id: req.ctx!.userId });
      const cur = draftOf(a);
      const next: AgentConfig = { ...cur, emergency: { ...cur.emergency, approvedBy: req.ctx!.userId, approvedByName: me?.full_name ?? null, approvedAt: new Date().toISOString() } };
      await exec(`UPDATE app.ai_agents SET draft = CAST(:d AS jsonb) WHERE id = :id`, { d: JSON.stringify(next), id: a.id });
      await auditFromReq(req, { action: 'agent.emergency.approve', targetType: 'ai_agent', targetId: a.id, details: { scriptVersion: cur.emergency.scriptVersion, transferNumber: cur.emergency.transferNumber } });
      return agentView(req);
    });
    res.json(out);
  });

  async function insertVersion(org: string, agentId: string, cfg: AgentConfig) {
    const [v] = await q<{ id: string; version: number }>(
      `INSERT INTO app.ai_agent_versions (organization_id, agent_id, version, persona, voice, languages, intake_questions, guardrails, handoff_rules, emergency_protocol, allowed_tools, llm_model)
       VALUES (:org, :a, (SELECT COALESCE(max(version), 0) + 1 FROM app.ai_agent_versions WHERE agent_id = :a), CAST(:persona AS jsonb), CAST(:voice AS jsonb), CAST(:langs AS text[]),
               CAST(:intake AS jsonb), CAST(:guard AS jsonb), CAST(:handoff AS jsonb), CAST(:emergency AS jsonb), CAST(:tools AS text[]), :model) RETURNING id, version`,
      { org, a: agentId, persona: JSON.stringify(cfg.persona), voice: JSON.stringify(cfg.voice), langs: `{${cfg.languages.join(',')}}`, intake: JSON.stringify(cfg.intakeQuestions),
        guard: JSON.stringify(cfg.guardrails), handoff: JSON.stringify(cfg.handoff), emergency: JSON.stringify(cfg.emergency), tools: `{${allowedTools(cfg).join(',')}}`, model: cfg.llmModel });
    return v!;
  }

  /** Test console: runs caller lines against the draft and the real calendar, then rolls everything back. */
  r.post('/ai-receptionist/test', ...manage, async (req, res) => {
    const body = parse(testConsoleBody, req.body);
    if (!deps.llm) throw new HttpError(409, 'no_model', 'No AI model is configured on this server (ANTHROPIC_API_KEY), so the receptionist cannot be tested yet.');
    const a = await inOrg(req, requireAgent);
    const cfg = draftOf(a);
    const result = await inRollback(deps, orgId(req), async (t) => {
      const name = await clinicName();
      const v = await insertVersion(orgId(req), a.id, cfg);
      const { ctx } = await suiteFixture(deps, orgId(req), a.id, v.id, cfg, body.callerPhone ?? null);
      const greeting = firstMessage(cfg, name);
      const history: { role: 'user' | 'assistant'; text: string }[] = [{ role: 'assistant', text: greeting }];
      const turns: (Pick<TurnOutput, 'redFlag' | 'guardBlocked' | 'actions' | 'lang'> & { caller: string; reply: string; tools: { name: string; status: string; result: Record<string, unknown> }[] })[] = [];
      for (const line of body.lines) {
        const out = await runTurn(deps, deps.llm, ctx, (fn) => fn(t), { history, callerText: line });
        history.push({ role: 'user', text: line }, { role: 'assistant', text: out.text });
        turns.push({ caller: line, reply: out.text, lang: out.lang, tools: out.tools.map((x) => ({ name: x.name, status: x.status, result: x.result })), redFlag: out.redFlag, guardBlocked: out.guardBlocked, actions: out.actions });
      }
      return { greeting, turns, model: deps.llm!.kind === 'anthropic' ? cfg.llmModel : 'test model', saved: false };
    });
    res.json(result);
  });

  /** Snapshot the draft as a new version and run the 40-case safety suite on it. */
  r.post('/ai-receptionist/suite', ...manage, async (req, res) => {
    const { a, v, name } = await inOrg(req, async () => {
      const ag = await requireAgent();
      const ver = await insertVersion(orgId(req), ag.id, draftOf(ag));
      await auditFromReq(req, { action: 'agent.version.create', targetType: 'ai_agent_version', targetId: ver.id, details: { version: ver.version } });
      return { a: ag, v: ver, name: await clinicName() };
    });
    const summary = await runSuite(deps, orgId(req), a.id, v.id, draftOf(a), name);
    res.status(201).json({ versionId: v.id, version: v.version, ...summary });
  });

  r.post('/ai-receptionist/versions/:id/publish', ...manage, async (req, res) => {
    const out = await inOrg(req, async () => {
      const a = await requireAgent();
      const [v] = await q<{ id: string; version: number; suite_passed_at: Date | null; published_at: Date | null; emergency_protocol: AgentConfig['emergency'] }>(
        `SELECT id, version, suite_passed_at, published_at, emergency_protocol FROM app.ai_agent_versions WHERE id = :id AND agent_id = :a`, { id: String(req.params.id), a: a.id });
      if (!v) throw notFound('Version not found');
      if (!v.suite_passed_at) throw conflict('This version has not passed all 40 safety checks');
      if (!v.emergency_protocol?.approvedAt) {
        // A sign-off given after the snapshot still counts if it covers the same protocol.
        const d = draftOf(a).emergency;
        const same = d.approvedAt && d.scriptVersion === v.emergency_protocol.scriptVersion && d.transferNumber === v.emergency_protocol.transferNumber;
        if (!same || v.published_at) throw conflict('A doctor or the owner must approve the emergency protocol before this version goes live');
        await exec(`UPDATE app.ai_agent_versions SET emergency_protocol = CAST(:e AS jsonb) WHERE id = :id`, { id: v.id, e: JSON.stringify({ ...v.emergency_protocol, approvedBy: d.approvedBy, approvedByName: d.approvedByName, approvedAt: d.approvedAt }) });
      }
      if (!v.published_at) await exec(`UPDATE app.ai_agent_versions SET published_at = now(), published_by = :u WHERE id = :id`, { id: v.id, u: req.ctx!.userId });
      await exec(`UPDATE app.ai_agents SET live_version_id = :v, status = 'live' WHERE id = :a`, { v: v.id, a: a.id });
      await auditFromReq(req, { action: 'agent.publish', targetType: 'ai_agent_version', targetId: v.id, details: { version: v.version } });
      return a.id;
    });
    await syncAgent(orgId(req), out);
    res.json(await inOrg(req, () => agentView(req)));
  });

  r.post('/ai-receptionist/pause', ...manage, async (req, res) => {
    res.json(await inOrg(req, async () => {
      const a = await requireAgent();
      if (a.status !== 'live') throw conflict('The receptionist is not live');
      await exec(`UPDATE app.ai_agents SET status = 'paused' WHERE id = :id`, { id: a.id });
      await auditFromReq(req, { action: 'agent.pause', targetType: 'ai_agent', targetId: a.id });
      return agentView(req);
    }));
  });
  r.post('/ai-receptionist/resume', ...manage, async (req, res) => {
    res.json(await inOrg(req, async () => {
      const a = await requireAgent();
      if (a.status !== 'paused' || !a.live_version_id) throw conflict('Only a paused receptionist with a published version can be resumed');
      await exec(`UPDATE app.ai_agents SET status = 'live' WHERE id = :id`, { id: a.id });
      await auditFromReq(req, { action: 'agent.resume', targetType: 'ai_agent', targetId: a.id });
      return agentView(req);
    }));
  });
  r.post('/ai-receptionist/sync', ...manage, async (req, res) => {
    const a = await inOrg(req, requireAgent);
    if (!a.live_version_id) throw conflict('Publish a version first');
    await syncAgent(orgId(req), a.id);
    res.json(await inOrg(req, () => agentView(req)));
  });

  /**
   * Pushes the live version to ElevenLabs: rotates our per-agent key (stored there as a workspace
   * secret, here only as a keyed hash), creates/updates their agent, imports and assigns numbers.
   * Errors are stored on the agent and shown in settings; publishing itself is not undone.
   */
  async function syncAgent(org: string, agentId: string) {
    const setError = (msg: string | null) => db.withContext({ orgId: org }, () => exec(
      `UPDATE app.ai_agents SET vendor_sync_error = :e, vendor_synced_at = CASE WHEN :e::text IS NULL THEN now() ELSE vendor_synced_at END WHERE id = :id`, { e: msg, id: agentId }));
    if (!deps.voice) return setError('ElevenLabs is not configured on this server (ELEVENLABS_API_KEY).');
    if (!config.PUBLIC_API_URL) return setError('PUBLIC_API_URL is not set, so ElevenLabs cannot reach this server.');
    const data = await db.withContext({ orgId: org }, async () => {
      const [a] = await q<{ vendor_agent_id: string | null; live_version_id: string }>(`SELECT vendor_agent_id, live_version_id FROM app.ai_agents WHERE id = :id`, { id: agentId });
      const [v] = await q<VersionRow>(`SELECT * FROM app.ai_agent_versions WHERE id = :id`, { id: a!.live_version_id });
      const numbers = await q<{ id: string; address: string; provider: string; display_name: string | null; vendor_phone_id: string | null; secret_enc: Buffer | null }>(
        `SELECT ca.id, ca.address, ca.provider, ca.display_name, ca.vendor_phone_id, ic.secret_enc FROM app.channel_accounts ca
           LEFT JOIN app.integration_credentials ic ON ic.channel_account_id = ca.id AND ic.status = 'active' WHERE ca.kind = 'phone' AND ca.agent_id = :a AND ca.is_active`, { a: agentId });
      const [o] = await q<{ name: string }>(`SELECT name FROM app.organizations WHERE id = :id`, { id: org });
      return { a: a!, cfg: configFromVersion(v!), numbers, name: o?.name ?? 'Clinic' };
    });
    try {
      const key = randomToken(32);
      const secretId = await deps.voice.createSecret(`dr-agent-${agentId.slice(0, 8)}-${Date.now()}`, key);
      const payload = agentPayload({ clinicName: data.name, agentId, config: data.cfg, firstMessage: firstMessage(data.cfg, data.name), publicApiUrl: config.PUBLIC_API_URL, llmSecretId: secretId, initiationSecret: config.ELEVENLABS_INIT_SECRET ?? null });
      const vendorAgentId = await deps.voice.upsertAgent(data.a.vendor_agent_id, payload);
      await db.withContext({ orgId: org }, () => exec(`UPDATE app.ai_agents SET vendor_agent_id = :v, tool_key_hash = :h WHERE id = :id`, { v: vendorAgentId, h: hmac(config.pepper, KEY_PURPOSE, key), id: agentId }));
      for (const n of data.numbers) {
        let phoneId = n.vendor_phone_id;
        if (!phoneId) {
          if (!n.secret_enc) continue;
          const creds = JSON.parse(decrypt(config.dataKey, n.secret_enc)) as Omit<PhoneImport, 'phoneNumber' | 'label'>;
          phoneId = await deps.voice.importPhone(phonePayload({ ...creds, phoneNumber: n.address, label: n.display_name ?? `${data.name} AI line` } as PhoneImport));
          await db.withContext({ orgId: org }, () => exec(`UPDATE app.channel_accounts SET vendor_phone_id = :p WHERE id = :id`, { p: phoneId, id: n.id }));
        }
        await deps.voice.assignPhone(phoneId, vendorAgentId);
      }
      await setError(null);
      await db.withContext({ orgId: org }, () => audit({ action: 'agent.vendor_sync', organizationId: org, actorKind: 'system', targetType: 'ai_agent', targetId: agentId, details: { vendorAgentId, numbers: data.numbers.length } }));
    } catch (e) {
      deps.log.warn({ err: e, agentId }, 'ElevenLabs sync failed');
      await setError((e as Error).message.slice(0, 500));
    }
  }

  // ---------- phone numbers ----------
  r.post('/ai-receptionist/numbers', ...manage, async (req, res) => {
    const body = parse(phoneNumberBody, req.body);
    const id = await inOrg(req, async () => {
      const a = await requireAgent();
      const [taken] = await q<{ organization_id: string }>(`SELECT organization_id FROM app.channel_accounts WHERE kind = 'phone' AND address = :n`, { n: body.phoneNumber });
      if (taken) throw conflict('This number is already connected');
      if (body.branchId) { const [b] = await q(`SELECT id FROM app.branches WHERE id = :id AND deleted_at IS NULL`, { id: body.branchId }); if (!b) throw badRequest('Unknown branch'); }
      const [ca] = await q<{ id: string }>(
        `INSERT INTO app.channel_accounts (organization_id, branch_id, kind, address, telephony_vendor, provider, display_name, purpose, agent_id)
         VALUES (:org, :b, 'phone', :n, CAST(:p AS app.telephony_vendor), :p, :label, 'ai_line', :a) RETURNING id`,
        { org: orgId(req), b: body.branchId ?? null, n: body.phoneNumber, p: body.provider, label: body.label ?? null, a: a.id });
      const { phoneNumber: _n, label: _l, branchId: _b, ...creds } = body;
      void _n; void _l; void _b;
      await exec(`INSERT INTO app.integration_credentials (organization_id, provider, channel_account_id, secret_enc, config, status) VALUES (:org, :p, :ca, :enc, '{}', 'active')`,
        { org: orgId(req), p: body.provider, ca: ca!.id, enc: encrypt(config.dataKey, JSON.stringify(creds)) });
      await auditFromReq(req, { action: 'agent.number.add', targetType: 'channel_account', targetId: ca!.id, details: { provider: body.provider, number: mask(body.phoneNumber) } });
      return a;
    });
    if (id.live_version_id) await syncAgent(orgId(req), id.id);
    res.status(201).json(await inOrg(req, () => agentView(req)));
  });

  r.delete('/ai-receptionist/numbers/:id', ...manage, async (req, res) => {
    res.json(await inOrg(req, async () => {
      const [n] = await q<{ id: string }>(`UPDATE app.channel_accounts SET is_active = false, agent_id = NULL WHERE id = :id AND kind = 'phone' RETURNING id`, { id: String(req.params.id) });
      if (!n) throw notFound('Number not found');
      await exec(`UPDATE app.integration_credentials SET status = 'revoked' WHERE channel_account_id = :id`, { id: n.id });
      await auditFromReq(req, { action: 'agent.number.remove', targetType: 'channel_account', targetId: n.id });
      return agentView(req);
    }));
  });

  // =====================================================================
  // Calls
  // =====================================================================
  function callScope(req: Request) {
    const g = grant(req, 'call:read');
    const mine = req.ctx!.org!.branchIds;
    if (g.scope === 'org' || (g.scope === 'branch' && mine.length === 0)) return { sql: 'TRUE', repl: {} as Repl };
    if (g.scope === 'branch') return { sql: '(c.branch_id IS NULL OR c.branch_id IN (:mineBranches))', repl: { mineBranches: mine } as Repl };
    if (g.scope === 'assigned') return { sql: 'EXISTS (SELECT 1 FROM app.leads l WHERE l.id = c.lead_id AND l.owner_user_id = :me)', repl: { me: req.ctx!.userId } as Repl };
    return { sql: 'FALSE', repl: {} as Repl };
  }
  const CALL_SELECT = `
    SELECT c.id, c.started_at, c.ended_at, c.duration_seconds, c.status, c.outcome, c.handled_by, c.is_test, c.caller_phone_enc, c.safety_locked, c.termination_reason,
           c.patient_id, p.full_name AS patient_name, pp.id AS profile_id, pp.mrn, c.lead_id, l.display_name AS lead_name, c.branch_id,
           COALESCE(cs.summary, c.vendor_summary) AS summary, cs.next_action, cs.intake,
           (SELECT count(*) FROM app.safety_events se WHERE se.call_id = c.id AND se.kind <> 'guardrail_block') AS safety_count,
           (SELECT count(*) FROM app.handoffs h WHERE h.call_id = c.id AND h.closed_at IS NULL) AS open_handoffs,
           EXISTS (SELECT 1 FROM app.call_recordings rc WHERE rc.call_id = c.id AND rc.deleted_at IS NULL) AS has_recording
      FROM app.calls c
      LEFT JOIN app.patients p ON p.id = c.patient_id
      LEFT JOIN app.patient_profiles pp ON pp.patient_id = c.patient_id AND pp.organization_id = c.organization_id AND pp.deleted_at IS NULL
      LEFT JOIN app.leads l ON l.id = c.lead_id
      LEFT JOIN app.call_summaries cs ON cs.call_id = c.id`;
  const callJson = (c: Record<string, unknown>, full = false) => {
    const phone = c.caller_phone_enc ? decrypt(config.dataKey, c.caller_phone_enc as Buffer) : null;
    return {
      id: c.id, startedAt: iso(c.started_at), endedAt: iso(c.ended_at), durationSeconds: c.duration_seconds === null ? null : Number(c.duration_seconds),
      status: c.status, outcome: c.outcome, handledBy: c.handled_by, isTest: c.is_test, safetyLocked: c.safety_locked, terminationReason: c.termination_reason ?? null,
      caller: { phone: phone ? (full ? phone : mask(phone)) : null, name: (c.patient_name ?? c.lead_name ?? null) as string | null, patient: c.profile_id ? { profileId: c.profile_id, mrn: c.mrn } : null, leadId: c.lead_id },
      summary: c.summary ?? null, nextAction: c.next_action ?? null, intake: c.intake ?? null,
      safetyEvents: Number(c.safety_count), openHandoffs: Number(c.open_handoffs), hasRecording: !!c.has_recording,
    };
  };

  r.get('/calls', user, org, requirePermission('call:read'), async (req, res) => {
    const query = parse(callListQuery, req.query);
    const items = await inOrg(req, async () => {
      const s = callScope(req);
      const conds = [s.sql];
      if (query.from) conds.push('c.started_at >= :from');
      if (query.to) conds.push('c.started_at < :to');
      if (query.outcome) conds.push('c.outcome::text = :outcome');
      if (query.includeTests === '0') conds.push('NOT c.is_test');
      const rows = await q<Record<string, unknown>>(`${CALL_SELECT} WHERE ${conds.join(' AND ')} ORDER BY c.started_at DESC LIMIT 200`, { ...query, ...s.repl });
      return rows.map((c) => callJson(c));
    });
    res.json({ items });
  });

  async function loadCall(req: Request, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Call not found');
    const s = callScope(req);
    const [c] = await q<Record<string, unknown>>(`${CALL_SELECT} WHERE c.id = :id AND ${s.sql}`, { id, ...s.repl });
    if (!c) throw notFound('Call not found');
    return c;
  }

  r.get('/calls/:id', user, org, requirePermission('call:read'), async (req, res) => {
    const out = await inOrg(req, async () => {
      const c = await loadCall(req, String(req.params.id));
      const id = c.id as string;
      const transcript = await q<{ seq: number; speaker: string; started_ms: number; text_original: string }>(`SELECT seq, speaker, started_ms, text_original FROM app.call_transcript_segments WHERE call_id = :id ORDER BY seq`, { id });
      const tools = await q<{ tool: string; status: string; rejection_reason: string | null; created_at: Date }>(
        `SELECT ti.tool, ti.status, ti.rejection_reason, ti.created_at FROM app.tool_invocations ti JOIN app.agent_runs ar ON ar.id = ti.agent_run_id WHERE ar.call_id = :id ORDER BY ti.created_at`, { id });
      const safety = await q<{ id: string; kind: string; red_flag_key: string | null; trigger_text: string | null; detected_at: Date; reviewed_at: Date | null; reviewer: string | null }>(
        `SELECT se.id, se.kind, se.red_flag_key, se.trigger_text, se.detected_at, se.reviewed_at, u.full_name AS reviewer FROM app.safety_events se LEFT JOIN app.users u ON u.id = se.reviewed_by WHERE se.call_id = :id ORDER BY se.detected_at`, { id });
      const handoffs = await q<{ id: string; reason: string; note_for_staff: string | null; requested_at: Date; outcome: string | null; accepted_by_name: string | null; closed_at: Date | null }>(
        `SELECT h.id, h.reason, h.note_for_staff, h.requested_at, h.outcome, u.full_name AS accepted_by_name, h.closed_at FROM app.handoffs h LEFT JOIN app.users u ON u.id = h.accepted_by WHERE h.call_id = :id ORDER BY h.requested_at`, { id });
      const appts = await q<{ id: string; start: Date; status: string; doctor: string }>(
        `SELECT a.id, lower(a.slot) AS start, a.status, d.display_name AS doctor FROM app.appointments a JOIN app.doctors d ON d.id = a.doctor_id WHERE a.source_call_id = :id ORDER BY a.created_at`, { id });
      const [rec] = await q<{ duration_seconds: number; delete_after: Date }>(`SELECT duration_seconds, delete_after FROM app.call_recordings WHERE call_id = :id AND deleted_at IS NULL`, { id });
      return {
        ...callJson(c, true),
        transcript: transcript.map((t) => ({ seq: t.seq, speaker: t.speaker, atMs: t.started_ms, text: t.text_original })),
        tools: tools.map((t) => ({ tool: t.tool, status: t.status, rejection: t.rejection_reason, at: iso(t.created_at) })),
        safety: safety.map((s) => ({ id: s.id, kind: s.kind, redFlag: s.red_flag_key, text: s.trigger_text, at: iso(s.detected_at), reviewedAt: iso(s.reviewed_at), reviewer: s.reviewer })),
        handoffs: handoffs.map((h) => ({ id: h.id, reason: h.reason, note: h.note_for_staff, at: iso(h.requested_at), outcome: h.outcome, acceptedBy: h.accepted_by_name, closedAt: iso(h.closed_at) })),
        appointments: appts.map((a) => ({ id: a.id, start: iso(a.start), status: a.status, doctor: a.doctor })),
        recording: rec ? { durationSeconds: rec.duration_seconds, deleteAfter: iso(rec.delete_after) } : null,
      };
    });
    res.json(out);
  });

  r.get('/calls/:id/recording', user, org, requirePermission('call:read'), async (req, res) => {
    const { key, patientId } = await inOrg(req, async () => {
      const c = await loadCall(req, String(req.params.id));
      const [rec] = await q<{ object_key: string }>(`SELECT object_key FROM app.call_recordings WHERE call_id = :id AND deleted_at IS NULL`, { id: c.id });
      if (!rec) throw notFound('No recording for this call');
      await auditFromReq(req, { action: 'call.recording.play', targetType: 'call', targetId: c.id as string });
      if (c.patient_id) {
        await exec(`INSERT INTO app.data_access_logs (organization_id, actor_kind, actor_id, patient_id, resource_type, resource_id, purpose) VALUES (:org, 'user', :u, :p, 'call_recording', :c, 'care')`,
          { org: orgId(req), u: req.ctx!.userId, p: c.patient_id, c: c.id });
      }
      return { key: rec.object_key, patientId: c.patient_id };
    });
    void patientId;
    if (!deps.recordings) throw notFound('Recording storage is not configured');
    const audio = await deps.recordings.get(key);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(audio);
  });

  // ---------- hand-offs (reception's "calls needing a person" panel) ----------
  r.get('/handoffs', user, org, requirePermission('call:read'), async (req, res) => {
    const items = await inOrg(req, async () => {
      const s = callScope(req);
      const rows = await q<Record<string, unknown>>(
        `SELECT h.id, h.reason, h.note_for_staff, h.requested_at, h.outcome, h.accepted_at, u.full_name AS accepted_by_name, h.fallback_task_id, c.id AS call_id, c.caller_phone_enc,
                p.full_name AS patient_name, l.display_name AS lead_name, c.started_at
           FROM app.handoffs h JOIN app.calls c ON c.id = h.call_id
           LEFT JOIN app.users u ON u.id = h.accepted_by LEFT JOIN app.patients p ON p.id = c.patient_id LEFT JOIN app.leads l ON l.id = c.lead_id
          WHERE h.closed_at IS NULL AND NOT c.is_test AND ${s.sql} ORDER BY (h.reason = 'emergency') DESC, h.requested_at DESC LIMIT 100`, s.repl);
      return rows.map((h) => {
        const phone = h.caller_phone_enc ? decrypt(config.dataKey, h.caller_phone_enc as Buffer) : null;
        return { id: h.id, reason: h.reason, note: h.note_for_staff, requestedAt: iso(h.requested_at), outcome: h.outcome, acceptedAt: iso(h.accepted_at), acceptedBy: h.accepted_by_name ?? null, callId: h.call_id, caller: { phone, name: (h.patient_name ?? h.lead_name ?? null) as string | null } };
      });
    });
    res.json({ items });
  });

  const takeover = [user, org, requirePermission('call:takeover')] as RequestHandler[];
  async function loadHandoff(req: Request) {
    const s = callScope(req);
    const [h] = await q<{ id: string; accepted_by: string | null; closed_at: Date | null; fallback_task_id: string | null }>(
      `SELECT h.id, h.accepted_by, h.closed_at, h.fallback_task_id FROM app.handoffs h JOIN app.calls c ON c.id = h.call_id WHERE h.id = :id AND ${s.sql}`, { id: String(req.params.id), ...s.repl });
    if (!h) throw notFound('Hand-off not found');
    if (h.closed_at) throw conflict('This hand-off is already closed');
    return h;
  }
  r.post('/handoffs/:id/accept', ...takeover, async (req, res) => {
    await inOrg(req, async () => {
      const h = await loadHandoff(req);
      if (h.accepted_by && h.accepted_by !== req.ctx!.userId) throw conflict('Someone else is already handling this');
      await exec(`UPDATE app.handoffs SET accepted_by = :u, accepted_at = now() WHERE id = :id`, { u: req.ctx!.userId, id: h.id });
      await auditFromReq(req, { action: 'handoff.accept', targetType: 'handoff', targetId: h.id });
    });
    res.status(204).end();
  });
  r.post('/handoffs/:id/close', ...takeover, async (req, res) => {
    const body = parse(handoffCloseBody, req.body ?? {});
    await inOrg(req, async () => {
      const h = await loadHandoff(req);
      await exec(`UPDATE app.handoffs SET closed_at = now(), accepted_by = COALESCE(accepted_by, :u), accepted_at = COALESCE(accepted_at, now()), note_for_staff = CASE WHEN :note::text IS NULL THEN note_for_staff ELSE concat_ws(E'\n', note_for_staff, :note) END WHERE id = :id`,
        { u: req.ctx!.userId, id: h.id, note: body.note ?? null });
      if (h.fallback_task_id) await exec(`UPDATE app.tasks SET status = 'done', completed_at = now(), completed_by = :u WHERE id = :t AND status IN ('open','in_progress')`, { t: h.fallback_task_id, u: req.ctx!.userId });
      await auditFromReq(req, { action: 'handoff.close', targetType: 'handoff', targetId: h.id });
    });
    res.status(204).end();
  });

  r.post('/safety-events/:id/review', ...takeover, async (req, res) => {
    await inOrg(req, async () => {
      const [e] = await q<{ id: string }>(`UPDATE app.safety_events SET reviewed_by = :u, reviewed_at = now() WHERE id = :id AND reviewed_at IS NULL RETURNING id`, { u: req.ctx!.userId, id: String(req.params.id) });
      if (!e) throw notFound('Safety event not found or already reviewed');
      await auditFromReq(req, { action: 'safety_event.review', targetType: 'safety_event', targetId: e.id });
    });
    res.status(204).end();
  });

  return r;
}

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text ?? '')).join(' ') : '';

/**
 * Answers in OpenAI chat-completions format (streamed as server-sent events when asked).
 * End-call / transfer become calls to the vendor's built-in tools, if the request offered them.
 */
function replyOpenAi(res: Response, body: { stream?: boolean; model?: string }, text: string, actions: SystemAction[], tools: { function?: { name: string; parameters?: { properties?: Record<string, unknown> } } }[]) {
  const offered = new Map(tools.filter((t) => t.function?.name).map((t) => [t.function!.name, t.function!]));
  const toolCalls = actions.flatMap((a, i) => {
    if (a.kind === 'end_call' && offered.has('end_call')) return [{ index: i, id: `call_end_${i}`, type: 'function', function: { name: 'end_call', arguments: JSON.stringify({ reason: a.reason }) } }];
    if (a.kind === 'transfer') {
      const t = offered.get('transfer_to_number');
      if (!t) return [];
      const args: Record<string, string> = {};
      for (const p of Object.keys(t.parameters?.properties ?? {})) {
        if (/number|phone/i.test(p)) args[p] = a.number;
        else if (/reason|message|condition/i.test(p)) args[p] = a.reason;
      }
      if (!Object.keys(args).length) args.transfer_number = a.number;
      return [{ index: i, id: `call_transfer_${i}`, type: 'function', function: { name: 'transfer_to_number', arguments: JSON.stringify(args) } }];
    }
    return [];
  });
  const id = `chatcmpl-${randomToken(9)}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? 'doc-receptionist';
  const finish = toolCalls.length ? 'tool_calls' : 'stop';
  if (!body.stream) {
    return res.json({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index: _i, ...t }) => t) } : {}) }, finish_reason: finish }] });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  send({ role: 'assistant', content: '' });
  // Sentence by sentence, so speech can start before the whole reply is sent.
  for (const part of text.match(/[^.!?।؟]+[.!?।؟]*\s*/g) ?? [text]) send({ content: part });
  if (toolCalls.length) send({ tool_calls: toolCalls });
  send({}, finish);
  res.write('data: [DONE]\n\n');
  res.end();
}

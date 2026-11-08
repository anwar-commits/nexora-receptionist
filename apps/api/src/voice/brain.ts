import { QueryTypes, type Transaction } from '@dr/db';
import { DateTime } from 'luxon';
import type { Deps } from '../context.js';
import type { Block, Llm, Msg } from './llm.js';
import { buildSystemPrompt, type ClinicFacts } from './prompt.js';
import { detectLang, detectRedFlag, guardOutput, safetyScript, type Lang, type RedFlag } from './safety.js';
import { allowedTools, runTool, TOOL_DEFS, type CallCtx, type SystemAction } from './tools.js';

/**
 * One caller turn. Order matters and is fixed in code:
 *   1. red-flag check on what the caller said — an emergency or self-harm statement gets the
 *      approved script, staff are alerted, and the model is not asked at all;
 *   2. the model replies, using tools that run here under server-side guards (max 5 rounds);
 *   3. the reply is screened for doses, medicine advice, diagnoses and promised results
 *      before it is spoken.
 */

export interface TurnInput {
  /** Earlier turns as spoken (text only), oldest first. */
  history: { role: 'user' | 'assistant'; text: string }[];
  /** What the caller just said. Empty when the vendor asks for a reply without new speech. */
  callerText: string;
}
export interface ToolTrace { name: string; input: Record<string, unknown>; status: string; result: Record<string, unknown> }
export interface TurnOutput {
  text: string;
  lang: Lang;
  actions: SystemAction[];
  tools: ToolTrace[];
  redFlag: RedFlag | null;
  guardBlocked: string | null;
  usage: { input: number; output: number };
  usedModel: boolean;
}

/** Runs fn in a transaction scoped to the clinic. Live calls open one per step; tests share one and roll back. */
export type TxRunner = <T>(fn: (t: Transaction) => Promise<T>) => Promise<T>;

const MAX_ROUNDS = 5;
const FALLBACK: Record<Lang, string> = {
  en: "Sorry, I couldn't manage that. Someone from the clinic will call you back shortly.",
  'hi-Latn': 'Maaf kijiye, main yeh nahi kar paayi. Clinic se koi aapko jaldi call karega.',
  hi: 'माफ़ कीजिए, मैं यह नहीं कर पाई। क्लिनिक से कोई आपको जल्दी कॉल करेगा।',
  bn: 'দুঃখিত, আমি এটা করতে পারলাম না। ক্লিনিক থেকে কেউ শীঘ্রই আপনাকে ফোন করবেন।',
  ur: 'معاف کیجیے، میں یہ نہیں کر سکی۔ کلینک سے کوئی آپ کو جلد کال کرے گا۔',
};

const sel = <T extends object>(deps: Deps, sql: string, replacements: Record<string, unknown>) => deps.db.sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });

export async function runTurn(deps: Deps, llm: Llm | undefined, ctx: CallCtx, tx: TxRunner, input: TurnInput): Promise<TurnOutput> {
  const lang = detectLang(input.callerText || input.history.filter((h) => h.role === 'user').at(-1)?.text || '', ctx.config.languages[0] ?? 'en');
  const out: TurnOutput = { text: '', lang, actions: [], tools: [], redFlag: null, guardBlocked: null, usage: { input: 0, output: 0 }, usedModel: false };

  // 1. Red flags: scripted, before (and instead of) the model.
  const flag = input.callerText ? detectRedFlag(input.callerText) : null;
  if (flag) {
    out.redFlag = flag;
    out.text = safetyScript(flag, lang);
    const transferTo = flag.kind === 'emergency_redirect' ? ctx.config.emergency.transferNumber : null;
    await tx((t) => recordRedFlag(deps, ctx, t, flag, input.callerText, lang, transferTo));
    if (transferTo) out.actions.push({ kind: 'transfer', number: transferTo, reason: 'emergency' });
    return out;
  }

  if (!llm) {
    out.text = FALLBACK[lang];
    await tx((t) => runTool(deps, ctx, t, 'request_handoff', { reason: 'ai_unsure', note: 'No AI model is configured; caller needs a call back.' }));
    return out;
  }

  // 2. Model with tools.
  const system = await tx((t) => systemPrompt(deps, ctx, t));
  const tools = TOOL_DEFS.filter((d) => allowedTools(ctx.config).includes(d.name as never));
  const messages = toMessages(input);
  const spoken: string[] = [];
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await llm.complete({ model: ctx.config.llmModel, system, messages, tools, maxTokens: 400 });
      out.usedModel = true;
      out.usage.input += res.inputTokens;
      out.usage.output += res.outputTokens;
      const text = res.content.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text.trim()).filter(Boolean).join(' ');
      if (text) spoken.push(text);
      const uses = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
      if (!uses.length) break;
      messages.push({ role: 'assistant', content: res.content });
      const results: Block[] = [];
      for (const u of uses) {
        const r = await tx((t) => runTool(deps, ctx, t, u.name, u.input));
        out.tools.push({ name: u.name, input: u.input, status: r.status, result: r.result });
        if (r.action) out.actions.push(r.action);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(r.result), is_error: r.status !== 'ok' });
      }
      messages.push({ role: 'user', content: results });
      if (round === MAX_ROUNDS - 1) spoken.length = 0; // ran out of rounds mid-task: don't speak half an answer
    }
  } catch (e) {
    deps.log.error({ err: e, callId: ctx.callId }, 'voice model failed');
    spoken.length = 0;
  }
  await tx((t) => deps.db.sequelize.query(`UPDATE app.agent_runs SET input_tokens = input_tokens + :i, output_tokens = output_tokens + :o WHERE id = :id`,
    { replacements: { i: out.usage.input, o: out.usage.output, id: ctx.runId }, transaction: t }));

  if (!spoken.length) {
    out.text = FALLBACK[lang];
    if (!out.actions.some((a) => a.kind === 'transfer')) await tx((t) => runTool(deps, ctx, t, 'request_handoff', { reason: 'ai_unsure', note: 'The AI could not complete the caller\'s request.' }));
    return out;
  }

  // 3. Screen before speaking.
  const g = guardOutput(spoken.join(' '), lang);
  out.text = g.text;
  if (!g.ok) {
    out.guardBlocked = g.reason!;
    await tx((t) => deps.db.sequelize.query(
      `INSERT INTO app.safety_events (organization_id, call_id, kind, trigger_text, red_flag_key, detected_at, script_version, lang) VALUES (:org, :call, 'guardrail_block', :txt, :why, now(), :sv, :lang)`,
      { replacements: { org: ctx.orgId, call: ctx.callId, txt: spoken.join(' ').slice(0, 500), why: g.reason, sv: ctx.config.emergency.scriptVersion, lang }, transaction: t }));
  }
  return out;
}

/** Anthropic needs alternating turns starting with the caller; the vendor's greeting comes first, so a marker is added. */
function toMessages(input: TurnInput): Msg[] {
  const turns = [...input.history, ...(input.callerText ? [{ role: 'user' as const, text: input.callerText }] : [])].filter((h) => h.text.trim());
  const msgs: Msg[] = [];
  for (const h of turns) {
    const last = msgs.at(-1);
    if (last && last.role === h.role) last.content = `${last.content as string}\n${h.text}`;
    else msgs.push({ role: h.role, content: h.text });
  }
  if (!msgs.length || msgs[0]!.role !== 'user') msgs.unshift({ role: 'user', content: '(call connected)' });
  if (msgs.at(-1)!.role !== 'user') msgs.push({ role: 'user', content: '(caller is silent)' });
  return msgs;
}

async function recordRedFlag(deps: Deps, ctx: CallCtx, t: Transaction, flag: RedFlag, text: string, lang: Lang, transferTo: string | null) {
  const o = { transaction: t };
  const selfHarm = flag.kind === 'self_harm_risk';
  const [task] = await deps.db.sequelize.query<{ id: string }>(
    `INSERT INTO app.tasks (organization_id, kind, title, priority, assignee_kind, assignee_ref, due_at, related_type, related_id, created_by_kind, notes)
     VALUES (:org, :kind, :title, 'urgent', 'role', 'receptionist', now() + interval '15 minutes', 'call', :call, 'ai_agent', :note) RETURNING id`,
    { ...o, type: QueryTypes.SELECT, replacements: {
      org: ctx.orgId, kind: selfHarm ? 'safety_check_in' : 'callback', call: ctx.callId,
      title: selfHarm ? 'Safety check-in: caller spoke about harming themselves' : `Emergency mentioned on an AI call (${flag.key.replace(/_/g, ' ')})`,
      note: `Caller said: "${text.slice(0, 300)}". The AI gave the ${selfHarm ? 'Tele-MANAS 14416 / 112' : '112'} script.` } });
  await deps.db.sequelize.query(
    `INSERT INTO app.safety_events (organization_id, call_id, kind, trigger_text, red_flag_key, detected_at, script_version, transferred_to, check_in_task_id, lang)
     VALUES (:org, :call, :kind, :txt, :key, now(), :sv, :tr, :task, :lang)`,
    { ...o, replacements: { org: ctx.orgId, call: ctx.callId, kind: flag.kind, txt: text.slice(0, 500), key: flag.key, sv: ctx.config.emergency.scriptVersion, tr: transferTo, task: task!.id, lang } });
  await deps.db.sequelize.query(
    `INSERT INTO app.handoffs (organization_id, call_id, reason, note_for_staff, requested_at, fallback_task_id, outcome) VALUES (:org, :call, 'emergency', :note, now(), :task, :out)`,
    { ...o, replacements: { org: ctx.orgId, call: ctx.callId, note: `${flag.key.replace(/_/g, ' ')}: "${text.slice(0, 200)}"`, task: task!.id, out: transferTo ? 'transferred' : 'callback_task' } });
  await deps.db.sequelize.query(`UPDATE app.calls SET safety_locked = true, outcome = 'emergency_redirect' WHERE id = :call`, { ...o, replacements: { call: ctx.callId } });
  await deps.db.sequelize.query(`DELETE FROM app.slot_holds WHERE held_by_kind = 'call' AND held_by_ref = :call`, { ...o, replacements: { call: ctx.callId } });
}

async function systemPrompt(deps: Deps, ctx: CallCtx, t: Transaction) {
  const facts = await loadFacts(deps, ctx.orgId, ctx.timeZone);
  const base = buildSystemPrompt(ctx.config, facts);
  const [call] = await sel<{ safety_locked: boolean }>(deps, `SELECT safety_locked FROM app.calls WHERE id = :id`, { id: ctx.callId });
  // Tool results from earlier turns (the vendor only sends us spoken text), newest last.
  const earlier = await sel<{ tool: string; arguments: Record<string, unknown>; result: Record<string, unknown> }>(deps,
    `SELECT tool, arguments, result FROM (SELECT tool, arguments, result, created_at FROM app.tool_invocations WHERE agent_run_id = :run ORDER BY created_at DESC LIMIT 8) x ORDER BY created_at`, { run: ctx.runId });
  void t;
  return [
    base,
    '## This call',
    ctx.callerPhone ? '- The caller\'s phone number is known to the system (do not read it out). Use get_caller_context.' : '- The caller\'s number is not available: you cannot register or book; offer a call back or take their name and interest.',
    ...(call?.safety_locked ? ['- A safety script was already given on this call. Do NOT book or move appointments. Stay calm and supportive and confirm the clinic team will call.'] : []),
    ...(earlier.length ? ['- Tool results earlier in this call:', ...earlier.map((e) => `  - ${e.tool}(${JSON.stringify(e.arguments).slice(0, 200)}) → ${JSON.stringify(e.result).slice(0, 500)}`)] : []),
  ].join('\n');
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const hhmm = (s: string) => DateTime.fromFormat(s.slice(0, 5), 'HH:mm').toFormat('h:mm a');

export async function loadFacts(deps: Deps, orgId: string, timeZone: string): Promise<ClinicFacts> {
  const [org] = await sel<{ name: string; prepay_policy: string; cancellation_policy_text: string | null; free_cancellation_hours: number }>(deps,
    `SELECT o.name, s.prepay_policy, s.cancellation_policy_text, s.free_cancellation_hours FROM app.organizations o JOIN app.organization_settings s ON s.organization_id = o.id WHERE o.id = :id`, { id: orgId });
  const branches = await sel<{ name: string; address_line: string; city: string; phone: string | null; opening_hours: Record<string, [string, string][]> }>(deps,
    `SELECT name, address_line, city, phone, opening_hours FROM app.branches WHERE is_active AND deleted_at IS NULL ORDER BY created_at`, {});
  const doctors = await sel<{ display_name: string; qualifications: string | null; languages: string[]; consults: string | null }>(deps,
    `SELECT d.display_name, d.qualifications, d.languages,
            (SELECT string_agg(DISTINCT r.mode::text, '/') FROM app.schedule_rules r WHERE r.doctor_id = d.id) AS consults
       FROM app.doctors d WHERE d.is_active AND d.deleted_at IS NULL AND d.bookable_by_ai ORDER BY d.display_name`, {});
  const services = await sel<{ name: string; duration_minutes: number; modes: string[]; fee_paise: string | null; ai_may_quote_fee: boolean }>(deps,
    `SELECT name, duration_minutes, modes::text[] AS modes, fee_paise, ai_may_quote_fee FROM app.services WHERE is_active ORDER BY duration_minutes, name`, {});
  const holidays = await sel<{ on_date: string; name: string | null }>(deps,
    `SELECT on_date::text, name FROM app.holidays WHERE on_date BETWEEN (now() AT TIME ZONE :tz)::date AND (now() AT TIME ZONE :tz)::date + 30 ORDER BY on_date`, { tz: timeZone });
  const prepay = { always: 'Payment is taken in advance for all appointments.', video_only: 'Video consultations are paid in advance; clinic visits are paid at the clinic.', never: 'Payment is taken at the clinic.' }[org?.prepay_policy ?? 'video_only'] ?? '';
  return {
    name: org?.name ?? 'the clinic', timeZone,
    now: DateTime.now().setZone(timeZone).toFormat("cccc d LLLL yyyy, h:mm a"),
    branches: branches.map((b) => ({
      name: b.name, address: `${b.address_line}, ${b.city}`, phone: b.phone,
      hours: DAYS.map((d) => { const r = b.opening_hours?.[d]; return r?.length ? `${d} ${r.map(([a, z]) => `${hhmm(a)}–${hhmm(z)}`).join(', ')}` : null; }).filter(Boolean).join('; ') || 'ask the clinic',
    })),
    doctors: doctors.map((d) => ({ name: d.display_name, qualifications: d.qualifications, languages: d.languages, consults: d.consults ? `consults by ${d.consults}` : 'no hours set yet' })),
    services: services.map((s) => ({ name: s.name, durationMinutes: s.duration_minutes, modes: s.modes, price: s.ai_may_quote_fee && s.fee_paise !== null ? `₹${(Number(s.fee_paise) / 100).toLocaleString('en-IN')}` : 'not to be quoted — the clinic will confirm' })),
    holidays: holidays.map((h) => `${h.on_date}${h.name ? ` (${h.name})` : ''}`),
    cancellationPolicy: org?.cancellation_policy_text ?? (org ? `Please cancel at least ${org.free_cancellation_hours} hours before.` : null),
    prepay,
  };
}

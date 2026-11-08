import { QueryTypes } from '@dr/db';
import type { Request, Response } from 'express';
import type { Deps } from '../context.js';
import { HttpError } from '../errors.js';
import { verifyElevenLabsSignature } from './elevenlabs.js';

/**
 * ElevenLabs post-call webhook. Signed (HMAC-SHA256 over "timestamp.body"); body kept raw for that.
 *  - post_call_transcription: transcript segments, call status/duration, summary
 *  - post_call_audio: the call audio, stored encrypted, deleted after the clinic's retention period
 *  - call_initiation_failure: the call never connected
 * Each event is stored once in webhook_events, so retries are harmless.
 */

interface TranscriptTurn { role: 'agent' | 'user'; message: string | null; time_in_call_secs?: number }
interface PostCall {
  type: string;
  event_timestamp?: number;
  data: {
    agent_id?: string; conversation_id?: string; status?: string;
    transcript?: TranscriptTurn[];
    metadata?: { start_time_unix_secs?: number; call_duration_secs?: number; termination_reason?: string };
    analysis?: { transcript_summary?: string; call_successful?: string };
    full_audio?: string;
    failure_reason?: string;
  };
}

const sel = <T extends object>(deps: Deps, sql: string, replacements: Record<string, unknown>) => deps.db.sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });

export function postCallHandler(deps: Deps) {
  return async (req: Request, res: Response) => {
    const secret = deps.config.ELEVENLABS_WEBHOOK_SECRET;
    if (!secret) throw new HttpError(503, 'not_configured', 'Post-call webhook secret is not configured');
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifyElevenLabsSignature(secret, req.headers['elevenlabs-signature'] as string | undefined, raw)) throw new HttpError(401, 'unauthenticated', 'Invalid signature');
    let ev: PostCall;
    try { ev = JSON.parse(raw.toString('utf8')) as PostCall; } catch { throw new HttpError(400, 'validation_failed', 'Body is not JSON'); }
    const conv = ev.data?.conversation_id;
    if (!conv) throw new HttpError(400, 'validation_failed', 'conversation_id missing');

    // Which clinic? The call row from the call-start webhook, else the agent.
    let [call] = await sel<{ id: string; organization_id: string }>(deps, `SELECT * FROM app.voice_call_by_conversation(:c)`, { c: conv });
    let orgId = call?.organization_id;
    if (!orgId) {
      const [a] = await sel<{ id: string; organization_id: string; live_version_id: string | null }>(deps, `SELECT * FROM app.voice_agent_by_vendor(:v)`, { v: String(ev.data.agent_id ?? '') });
      if (!a) { res.status(200).json({ ignored: 'unknown agent' }); return; }
      orgId = a.organization_id;
      const start = ev.data.metadata?.start_time_unix_secs ? new Date(ev.data.metadata.start_time_unix_secs * 1000) : new Date();
      [call] = await deps.db.withContext({ orgId }, () => sel<{ id: string; organization_id: string }>(deps,
        `INSERT INTO app.calls (organization_id, direction, voice_vendor, voice_conversation_id, agent_id, agent_version_id, status, started_at)
         VALUES (:org, 'inbound', 'elevenlabs', :c, :a, :v, 'in_progress', :s)
         ON CONFLICT (voice_vendor, voice_conversation_id) WHERE voice_conversation_id IS NOT NULL DO UPDATE SET voice_conversation_id = EXCLUDED.voice_conversation_id
         RETURNING id, organization_id`, { org: orgId, c: conv, a: a.id, v: a.live_version_id, s: start }));
    }
    const callId = call!.id;

    const eventId = `${ev.type}:${conv}`;
    const [fresh] = await deps.db.withContext({ orgId }, () => sel<{ id: string }>(deps,
      `INSERT INTO app.webhook_events (provider, event_id, organization_id, signature_valid, payload, status)
       VALUES ('elevenlabs', :e, :org, true, CAST(:p AS jsonb), 'received') ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
      // Audio is large and already stored separately; keep the event small.
      { e: eventId, org: orgId, p: JSON.stringify({ type: ev.type, conversation_id: conv, agent_id: ev.data.agent_id }) }));
    if (!fresh) { res.status(200).json({ duplicate: true }); return; }

    try {
      if (ev.type === 'post_call_transcription') await onTranscript(deps, orgId, callId, ev);
      else if (ev.type === 'post_call_audio') await onAudio(deps, orgId, callId, ev);
      else if (ev.type === 'call_initiation_failure') {
        await deps.db.withContext({ orgId }, () => deps.db.sequelize.query(`UPDATE app.calls SET status = 'failed', ended_at = COALESCE(ended_at, now()), termination_reason = :r WHERE id = :id`,
          { replacements: { id: callId, r: (ev.data.failure_reason ?? 'initiation failed').slice(0, 200) } }));
      }
      await deps.db.withContext({ orgId }, () => deps.db.sequelize.query(`UPDATE app.webhook_events SET status = 'processed', processed_at = now() WHERE id = :id`, { replacements: { id: fresh.id } }));
    } catch (e) {
      deps.log.error({ err: e, callId, type: ev.type }, 'post-call webhook failed');
      await deps.db.withContext({ orgId }, () => deps.db.sequelize.query(`UPDATE app.webhook_events SET status = 'failed', error = :e, attempts = attempts + 1 WHERE id = :id`, { replacements: { id: fresh.id, e: (e as Error).message.slice(0, 500) } }));
      throw e;
    }
    res.status(200).json({ ok: true });
  };
}

async function onTranscript(deps: Deps, orgId: string, callId: string, ev: PostCall) {
  const turns = (ev.data.transcript ?? []).filter((t) => t.message && t.message.trim());
  const meta = ev.data.metadata ?? {};
  const duration = meta.call_duration_secs ?? null;
  const vendorSummary = ev.data.analysis?.transcript_summary ?? null;
  await deps.db.withContext({ orgId }, async () => {
    const [s] = await sel<{ transcript_enabled: boolean }>(deps, `SELECT transcript_enabled FROM app.organization_settings WHERE organization_id = :org`, { org: orgId });
    if (s?.transcript_enabled !== false) {
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i]!;
        const start = Math.round((t.time_in_call_secs ?? 0) * 1000);
        const next = turns[i + 1]?.time_in_call_secs;
        const end = next !== undefined ? Math.max(start, Math.round(next * 1000)) : duration !== null ? Math.max(start, duration * 1000) : start;
        await deps.db.sequelize.query(
          `INSERT INTO app.call_transcript_segments (organization_id, call_id, seq, speaker, started_ms, ended_ms, text_original)
           VALUES (:org, :call, :seq, CAST(:sp AS app.speaker), :a, :b, :txt) ON CONFLICT (call_id, seq) DO NOTHING`,
          { replacements: { org: orgId, call: callId, seq: i, sp: t.role === 'agent' ? 'ai' : 'caller', a: start, b: end, txt: t.message!.slice(0, 4000) } });
      }
    }
    await deps.db.sequelize.query(
      `UPDATE app.calls SET status = CASE WHEN status IN ('ringing','in_progress','on_hold') THEN 'completed'::app.call_status ELSE status END,
              started_at = COALESCE(CAST(:start AS timestamptz), started_at), duration_seconds = COALESCE(:dur, duration_seconds),
              ended_at = COALESCE(CAST(:start AS timestamptz), started_at) + make_interval(secs => COALESCE(:dur, 0)),
              termination_reason = :term, vendor_summary = :vs,
              outcome = COALESCE(outcome, CASE WHEN COALESCE(:dur, 0) < 10 THEN 'dropped'::app.call_outcome ELSE 'info_only'::app.call_outcome END)
        WHERE id = :id`,
      { replacements: { id: callId, start: meta.start_time_unix_secs ? new Date(meta.start_time_unix_secs * 1000).toISOString() : null, dur: duration, term: meta.termination_reason?.slice(0, 200) ?? null, vs: vendorSummary?.slice(0, 2000) ?? null } });
    await deps.db.sequelize.query(`UPDATE app.agent_runs SET status = 'succeeded', ended_at = now() WHERE call_id = :id AND status = 'running'`, { replacements: { id: callId } });
  });

  // Summary for staff. With a real model: our own structured summary (English); otherwise the vendor's.
  let summary: { summary: string; intake: Record<string, unknown>; next_action: string | null; model: string } | null = null;
  if (deps.llm?.kind === 'anthropic' && turns.length) {
    try {
      const [m] = await deps.db.withContext({ orgId }, () => sel<{ llm_model: string }>(deps, `SELECT v.llm_model FROM app.calls c JOIN app.ai_agent_versions v ON v.id = c.agent_version_id WHERE c.id = :id`, { id: callId }));
      const transcript = turns.map((t) => `${t.role === 'agent' ? 'AI' : 'Caller'}: ${t.message}`).join('\n').slice(0, 20_000);
      const r = await deps.llm.complete({
        model: m?.llm_model ?? 'claude-sonnet-5-5', tools: [], maxTokens: 500,
        system: 'You summarise clinic reception phone calls for staff. Write in English. Do not add medical opinions or diagnoses; report only what was said. Reply with JSON only: {"summary": "2-3 sentences", "intake": {"reason": "...", "since": "...", "prior_treatment": "...", "preference": "..."}, "next_action": "one line or null"}. Use null for anything not mentioned.',
        messages: [{ role: 'user', content: transcript }],
      });
      const text = r.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { summary: string; intake?: Record<string, unknown>; next_action?: string | null };
      if (typeof json.summary === 'string') summary = { summary: json.summary.slice(0, 2000), intake: json.intake ?? {}, next_action: json.next_action ?? null, model: r.model };
    } catch (e) {
      deps.log.warn({ err: e, callId }, 'call summary failed; using vendor summary');
    }
  }
  if (!summary && vendorSummary) summary = { summary: vendorSummary.slice(0, 2000), intake: {}, next_action: null, model: 'elevenlabs' };
  if (summary) {
    await deps.db.withContext({ orgId }, () => deps.db.sequelize.query(
      `INSERT INTO app.call_summaries (call_id, organization_id, summary, intake, next_action, model) VALUES (:call, :org, :s, CAST(:i AS jsonb), :n, :m)
       ON CONFLICT (call_id) DO UPDATE SET summary = EXCLUDED.summary, intake = EXCLUDED.intake, next_action = EXCLUDED.next_action, model = EXCLUDED.model`,
      { replacements: { call: callId, org: orgId, s: summary.summary, i: JSON.stringify(summary.intake), n: summary.next_action, m: summary.model } }));
  }
}

async function onAudio(deps: Deps, orgId: string, callId: string, ev: PostCall) {
  if (!ev.data.full_audio || !deps.recordings) return;
  await deps.db.withContext({ orgId }, async () => {
    const [s] = await sel<{ recording_enabled: boolean; recording_retention_days: number }>(deps, `SELECT recording_enabled, recording_retention_days FROM app.organization_settings WHERE organization_id = :org`, { org: orgId });
    if (!s?.recording_enabled || s.recording_retention_days <= 0) return; // the clinic does not keep recordings
    const [c] = await sel<{ duration_seconds: number | null }>(deps, `SELECT duration_seconds FROM app.calls WHERE id = :id`, { id: callId });
    const audio = Buffer.from(ev.data.full_audio!, 'base64');
    const key = `calls/${orgId}/${callId}`;
    const size = await deps.recordings!.put(key, audio);
    await deps.db.sequelize.query(
      `INSERT INTO app.call_recordings (organization_id, call_id, object_key, duration_seconds, delete_after, content_type, size_bytes)
       VALUES (:org, :call, :key, :dur, now() + make_interval(days => :days), 'audio/mpeg', :size) ON CONFLICT (call_id) DO NOTHING`,
      { replacements: { org: orgId, call: callId, key, dur: c?.duration_seconds ?? 0, days: s.recording_retention_days, size } });
  });
}

/** Deletes recordings past their clinic's retention period. Run daily (pnpm --filter api recordings:purge). */
export async function purgeExpiredRecordings(deps: Deps): Promise<number> {
  if (!deps.recordings) return 0;
  const orgs = await sel<{ id: string }>(deps, `SELECT id FROM app.organizations WHERE deleted_at IS NULL`, {});
  let n = 0;
  for (const o of orgs) {
    const due = await deps.db.withContext({ orgId: o.id }, () => sel<{ id: string; object_key: string }>(deps,
      `SELECT id, object_key FROM app.call_recordings WHERE deleted_at IS NULL AND delete_after <= now() LIMIT 500`, {}));
    for (const r of due) {
      await deps.recordings.remove(r.object_key);
      await deps.db.withContext({ orgId: o.id }, () => deps.db.sequelize.query(`UPDATE app.call_recordings SET deleted_at = now() WHERE id = :id`, { replacements: { id: r.id } }));
      n++;
    }
  }
  return n;
}

import { DateTime } from 'luxon';
import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, Card, Drawer, Empty, Notice, Pill, SectionTitle, TextArea, Toggle } from '../../components/ui';
import { api, apiBlob } from '../../lib/api';
import { errorText, useClinic, useSave } from '../../lib/clinic';
import { phoneLabel } from '../../lib/format';
import { useZone } from '../../lib/schedule';
import { HANDOFF_LABEL, OUTCOME_LABEL, TOOL_LABEL, useCall, useCalls, useHandoffs, type CallSummary, type Handoff } from '../../lib/voice';

const dur = (s: number | null) => (s === null ? '—' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
const outcomeTone = (o: string | null) => (o === 'emergency_redirect' ? 'warn' : o === 'booked' || o === 'rescheduled' ? 'ok' : o === 'handed_off' ? 'ai' : 'n') as 'warn' | 'ok' | 'ai' | 'n';

function Recording({ callId }: { callId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (url) return <audio controls src={url} className="w-full" aria-label="Call recording" />;
  return (
    <div className="flex items-center gap-3">
      <Button loading={loading} onClick={async () => { setLoading(true); try { setUrl(URL.createObjectURL(await apiBlob(`/calls/${callId}/recording`))); } catch (e) { setErr(e); } finally { setLoading(false); } }}>Play recording</Button>
      <span className="text-xs text-ink-2">Playing a recording is logged.</span>
      {err ? <Notice>{errorText(err)}</Notice> : null}
    </div>
  );
}

export function CallDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const zone = useZone();
  const { can } = useClinic();
  const q = useCall(id);
  const review = useSave((sid: string) => api(`/safety-events/${sid}/review`, { method: 'POST', body: {} }), ['call', 'calls']);
  const c = q.data;
  const t = (iso: string) => DateTime.fromISO(iso).setZone(zone).toFormat('d LLL, h:mm a');
  return (
    <Drawer title={c ? `Call · ${t(c.startedAt)}` : 'Call'} onClose={onClose} width={620}>
      {q.error ? <Notice>{errorText(q.error)}</Notice> : null}
      {!c ? <p className="text-ink-2">Loading…</p> : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <b>{c.caller.name ?? (c.caller.phone ? phoneLabel(c.caller.phone) : 'Unknown caller')}</b>
            {c.caller.name && c.caller.phone ? <span className="text-ink-2">{phoneLabel(c.caller.phone)}</span> : null}
            {c.caller.patient ? <Link className="font-semibold text-teal" to={`/patients/${c.caller.patient.profileId}`}>{c.caller.patient.mrn}</Link> : null}
            <span className="ml-auto flex gap-1.5">{c.outcome ? <Pill tone={outcomeTone(c.outcome)}>{OUTCOME_LABEL[c.outcome] ?? c.outcome}</Pill> : null}<Pill>{dur(c.durationSeconds)}</Pill>{c.isTest ? <Pill>Test</Pill> : null}</span>
          </div>
          {c.safety.filter((s) => s.kind !== 'guardrail_block').map((s) => (
            <div key={s.id} className="rounded-xl border border-[#F2D3A2] bg-warn-tint px-3.5 py-3 text-sm">
              <b className="text-warn-ink">{s.kind === 'self_harm_risk' ? 'Self-harm risk' : 'Emergency'}{s.redFlag ? ` · ${s.redFlag.replace(/_/g, ' ')}` : ''}</b> at {t(s.at)}
              {s.text ? <div className="mt-1">Caller said: "{s.text}"</div> : null}
              <div className="mt-2 flex items-center gap-2">{s.reviewedAt ? <span className="text-ink-2">Reviewed by {s.reviewer} · {t(s.reviewedAt)}</span> : can('call:takeover') ? <Button className="h-8 px-3 text-xs" loading={review.isPending} onClick={() => review.mutate(s.id)}>Mark reviewed</Button> : null}</div>
            </div>
          ))}
          {c.summary ? <Card className="p-4"><div className="text-xs font-bold tracking-[.06em] text-ink-2">SUMMARY</div><p className="mt-1 text-sm">{c.summary}</p>{c.nextAction ? <p className="mt-2 text-sm"><b>Next:</b> {c.nextAction}</p> : null}
            {c.intake && Object.values(c.intake).some(Boolean) ? <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">{Object.entries(c.intake).filter(([, v]) => v).map(([k, v]) => <Fragment key={k}><dt className="text-ink-2">{k.replace(/_/g, ' ')}</dt><dd>{v}</dd></Fragment>)}</dl> : null}</Card> : null}
          {c.appointments.length ? <div className="text-sm"><b>Booked on this call:</b> {c.appointments.map((a) => `${a.doctor}, ${t(a.start)} (${a.status})`).join('; ')}</div> : null}
          {c.recording ? <div className="flex flex-col gap-1"><Recording callId={c.id} /><span className="text-xs text-ink-2">Kept until {DateTime.fromISO(c.recording.deleteAfter).setZone(zone).toFormat('d LLL yyyy')}, then deleted.</span></div> : null}
          {c.handoffs.length ? <div className="text-sm"><b>Hand-offs:</b> {c.handoffs.map((h) => `${HANDOFF_LABEL[h.reason] ?? h.reason}${h.closedAt ? ' (closed)' : ''}`).join(', ')}</div> : null}
          <section>
            <h3 className="mb-2 text-sm font-bold">Transcript</h3>
            {c.transcript.length === 0 ? <Empty>The transcript arrives a few seconds after the call ends.</Empty> : (
              <ol className="flex flex-col gap-2">
                {c.transcript.map((s) => (
                  <li key={s.seq} className={`max-w-[88%] rounded-xl px-3.5 py-2 text-sm ${s.speaker === 'caller' ? 'ml-auto bg-surface shadow-sm' : 'bg-teal-tint/60'}`}>
                    <span className="mr-1.5 text-xs font-bold text-ink-2">{s.speaker === 'ai' ? 'AI' : s.speaker === 'caller' ? 'Caller' : s.speaker} · {Math.floor(s.atMs / 60000)}:{String(Math.floor((s.atMs % 60000) / 1000)).padStart(2, '0')}</span>{s.text}
                  </li>
                ))}
              </ol>
            )}
          </section>
          {c.tools.length ? (
            <section><h3 className="mb-2 text-sm font-bold">What the AI did</h3>
              <div className="flex flex-wrap gap-1.5">{c.tools.map((x, i) => <Pill key={i} tone={x.status === 'ok' ? 'n' : 'warn'}>{TOOL_LABEL[x.tool] ?? x.tool}{x.status !== 'ok' ? ` — refused (${x.rejection})` : ''}</Pill>)}</div>
            </section>
          ) : null}
          {c.safety.some((s) => s.kind === 'guardrail_block') ? <p className="text-xs text-ink-2">{c.safety.filter((s) => s.kind === 'guardrail_block').length} AI reply was replaced before being spoken because it touched on medicines, a diagnosis or promised results.</p> : null}
        </>
      )}
    </Drawer>
  );
}

/** Calls answered by the AI receptionist. */
export function CallsPage() {
  const zone = useZone();
  const [params, setParams] = useSearchParams();
  const [tests, setTests] = useState(false);
  const calls = useCalls(tests);
  const open = params.get('c');
  const row = (c: CallSummary) => (
    <li key={c.id}>
      <button type="button" onClick={() => setParams({ c: c.id })} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left text-sm hover:bg-canvas">
        <span className="w-28 shrink-0 text-ink-2">{DateTime.fromISO(c.startedAt).setZone(zone).toFormat('d LLL, h:mm a')}</span>
        <b className="w-44 shrink-0 truncate">{c.caller.name ?? c.caller.phone ?? 'Unknown caller'}</b>
        <span className="min-w-0 flex-1 truncate text-ink-2">{c.summary ?? (c.status === 'in_progress' ? 'On the call now…' : 'No summary yet')}</span>
        {c.safetyEvents ? <Pill tone="warn">Safety</Pill> : null}
        {c.openHandoffs ? <Pill tone="ai">Needs staff</Pill> : null}
        {c.outcome ? <Pill tone={outcomeTone(c.outcome)}>{OUTCOME_LABEL[c.outcome] ?? c.outcome}</Pill> : <Pill>{c.status.replace('_', ' ')}</Pill>}
        <span className="w-14 text-right font-mono text-xs text-ink-2">{dur(c.durationSeconds)}</span>
      </button>
    </li>
  );
  return (
    <div className="flex flex-col gap-5">
      <SectionTitle title="Calls" subtitle="Every call the AI receptionist answered: summary, transcript, what it booked and when it handed over." action={<Toggle label="Show test calls" checked={tests} onChange={setTests} />} />
      {calls.error ? <Notice>{errorText(calls.error)}</Notice> : null}
      <Card>
        {calls.isLoading ? <p className="p-4 text-ink-2">Loading…</p> : (calls.data ?? []).length === 0 ? <div className="p-4"><Empty>No calls yet. They appear here once the AI receptionist is live on a phone number.</Empty></div> : (
          <ul className="flex flex-col divide-y divide-line-2">{(calls.data ?? []).map(row)}</ul>
        )}
      </Card>
      {open ? <CallDrawer id={open} onClose={() => setParams({})} /> : null}
    </div>
  );
}

function HandoffRow({ h }: { h: Handoff }) {
  const zone = useZone();
  const { can } = useClinic();
  const accept = useSave(() => api(`/handoffs/${h.id}/accept`, { method: 'POST', body: {} }), ['handoffs']);
  const close = useSave((note: string) => api(`/handoffs/${h.id}/close`, { method: 'POST', body: note ? { note } : {} }), ['handoffs', 'tasks', 'calls']);
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState('');
  const urgent = h.reason === 'emergency';
  return (
    <li className={`flex flex-col gap-2 py-2.5 text-sm ${urgent ? 'rounded-lg bg-warn-tint px-2.5' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={urgent ? 'warn' : 'ai'}>{HANDOFF_LABEL[h.reason] ?? h.reason}</Pill>
        <b>{h.caller.name ?? (h.caller.phone ? phoneLabel(h.caller.phone) : 'Unknown caller')}</b>
        <span className="text-xs text-ink-2">{DateTime.fromISO(h.requestedAt).setZone(zone).toFormat('h:mm a')}</span>
        <Link to={`/calls?c=${h.callId}`} className="ml-auto text-xs font-semibold text-teal">Call →</Link>
      </div>
      {h.note ? <div className="text-ink-2">{h.note}</div> : null}
      {h.caller.name && h.caller.phone ? <a className="font-mono text-xs font-semibold text-teal" href={`tel:${h.caller.phone}`}>{phoneLabel(h.caller.phone)}</a> : null}
      {accept.error || close.error ? <Notice>{errorText(accept.error ?? close.error)}</Notice> : null}
      {can('call:takeover') ? (closing ? (
        <div className="flex flex-col gap-2">
          <TextArea label="What happened" name={`note-${h.id}`} value={note} onChange={(e) => setNote(e.target.value)} className="min-h-16" />
          <div className="flex gap-2"><Button variant="primary" className="h-8 px-3 text-xs" loading={close.isPending} onClick={() => close.mutate(note.trim())}>Close</Button><Button className="h-8 px-3 text-xs" onClick={() => setClosing(false)}>Back</Button></div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {h.acceptedBy ? <span className="text-xs text-ink-2">{h.acceptedBy} is on it</span> : <Button className="h-8 px-3 text-xs" loading={accept.isPending} onClick={() => accept.mutate(undefined)}>I'll call back</Button>}
          <Button variant="primary" className="h-8 px-3 text-xs" onClick={() => setClosing(true)}>Done</Button>
        </div>
      )) : null}
    </li>
  );
}

/** Reception: callers the AI handed over, emergencies first. */
export function CallsPanel() {
  const list = useHandoffs();
  const items = list.data ?? [];
  return (
    <Card className="p-5">
      <div className="flex items-center"><h2 className="font-display text-lg font-bold">Calls needing a person</h2>{items.length ? <span className="ml-2"><Pill tone={items.some((h) => h.reason === 'emergency') ? 'warn' : 'ai'}>{items.length}</Pill></span> : null}<Link to="/calls" className="ml-auto text-[13px] font-semibold text-teal">All calls →</Link></div>
      {list.error ? <Notice>{errorText(list.error)}</Notice> : null}
      {items.length === 0 ? <p className="mt-2 text-sm text-ink-2">No one is waiting for a call back.</p> : <ul className="mt-2 flex flex-col divide-y divide-line-2">{items.map((h) => <HandoffRow key={h.id} h={h} />)}</ul>}
    </Card>
  );
}

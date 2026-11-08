import { LEAD_SOURCES, type LeadStage } from '@dr/contracts';
import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, Card, Drawer, Empty, Field, Notice, Pill, Select, TextArea, Toggle } from '../../components/ui';
import { ApiRequestError, api } from '../../lib/api';
import { errorText, useClinic, useSave, type Member } from '../../lib/clinic';
import { STAGES, STAGE_LABEL, SOURCE_LABEL, ownerLabel, useLeads, useTasks, type Lead, type LeadDetail, type ScoringRule } from '../../lib/crm';
import { phoneLabel } from '../../lib/format';
import { todayIn, useZone, type PatientView } from '../../lib/schedule';
import { BookingDrawer } from '../schedule/Booking';
import { AddTaskForm, TaskList } from './Tasks';

const when = (iso: string | null, zone: string) => (iso ? DateTime.fromISO(iso).setZone(zone).toFormat('ccc d LLL, h:mm a') : null);
const scoreTone = (s: number) => (s >= 70 ? 'ok' : s >= 40 ? 'teal' : 'n');

function useStaff() {
  const { orgId, can } = useClinic();
  return useQuery({ queryKey: ['members', orgId], queryFn: () => api<{ items: Member[] }>('/members').then((r) => r.items), enabled: can('member:read') });
}

function OwnerSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const staff = useStaff();
  return (
    <Select label="Owner" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="unassigned">Unassigned</option>
      <option value="ai">AI (follow-up calls start with the AI release)</option>
      {staff.data?.filter((m) => m.status === 'active').map((m) => <option key={m.userId} value={`user:${m.userId}`}>{m.fullName} · {m.roleName}</option>)}
    </Select>
  );
}
const ownerBody = (v: string) => (v.startsWith('user:') ? { ownerKind: 'user', ownerUserId: v.slice(5) } : { ownerKind: v, ownerUserId: null });

// ---------------------------------------------------------------------------
function AddLeadDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const zone = useZone();
  const [f, setF] = useState({ displayName: '', phone: '', interest: '', source: 'phone_call', owner: 'unassigned', wantsVisitBy: '', nextActionAt: '', note: '' });
  const [existing, setExisting] = useState<string | null>(null);
  const save = useSave(() => api<Lead>('/leads', {
    method: 'POST',
    body: {
      displayName: f.displayName || null, phone: f.phone || null, interest: f.interest || null, source: f.source, ...ownerBody(f.owner),
      wantsVisitBy: f.wantsVisitBy || null, nextActionAt: f.nextActionAt ? DateTime.fromISO(f.nextActionAt, { zone }).toISO() : null, note: f.note || undefined,
    },
  }), ['leads']);
  const submit = (e: FormEvent) => {
    e.preventDefault(); setExisting(null);
    save.mutate(undefined, {
      onSuccess: (l) => onCreated(l.id),
      onError: (err) => { if (err instanceof ApiRequestError) setExisting((err.error.details as { leadId?: string } | undefined)?.leadId ?? null); },
    });
  };
  return (
    <Drawer title="Add lead" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {save.error ? <Notice>{errorText(save.error)}{existing ? <button type="button" className="ml-2 font-semibold text-teal underline" onClick={() => onCreated(existing)}>Open it</button> : null}</Notice> : null}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
          <Field label="Mobile number" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </div>
        <Field label="Interested in" placeholder="e.g. Hair transplant cost, PRP, acne scars" value={f.interest} onChange={(e) => setF({ ...f, interest: e.target.value })} />
        <div className="grid grid-cols-2 gap-4">
          <Select label="Source" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
            {LEAD_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
          </Select>
          <OwnerSelect value={f.owner} onChange={(v) => setF({ ...f, owner: v })} />
          <Field label="Wants a visit by (optional)" type="date" value={f.wantsVisitBy} onChange={(e) => setF({ ...f, wantsVisitBy: e.target.value })} />
          <Field label="Next follow-up (optional)" type="datetime-local" value={f.nextActionAt} onChange={(e) => setF({ ...f, nextActionAt: e.target.value })} />
        </div>
        <TextArea label="Note (optional)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="What they asked, in their words" />
        <Button variant="primary" type="submit" className="self-end" loading={save.isPending} disabled={!f.displayName.trim() && !f.phone.trim()}>Add lead</Button>
      </form>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
function LinkPatient({ lead }: { lead: LeadDetail }) {
  const { orgId, can } = useClinic();
  const [mode, setMode] = useState<'none' | 'register' | 'link'>('none');
  const [f, setF] = useState({ fullName: lead.displayName ?? '', phone: lead.phone ?? '' });
  const [q, setQ] = useState('');
  const results = useQuery({ queryKey: ['patients', orgId, q], queryFn: () => api<{ items: PatientView[] }>(`/patients?q=${encodeURIComponent(q)}`).then((r) => r.items), enabled: mode === 'link' && q.trim().length >= 2 && can('patient:read') });
  const register = useSave(() => api(`/leads/${lead.id}/patient`, { method: 'POST', body: { fullName: f.fullName, phone: f.phone } }), ['lead', 'leads', 'patients']);
  const link = useSave((profileId: string) => api(`/leads/${lead.id}`, { method: 'PATCH', body: { patientProfileId: profileId } }), ['lead', 'leads']);
  return (
    <div className="flex flex-col gap-3">
      {register.error || link.error ? <Notice>{errorText(register.error ?? link.error)}</Notice> : null}
      <div className="flex gap-2">
        <Button onClick={() => setMode(mode === 'register' ? 'none' : 'register')}>Register as patient</Button>
        {can('patient:read') ? <Button variant="ghost" onClick={() => setMode(mode === 'link' ? 'none' : 'link')}>Link existing patient</Button> : null}
      </div>
      {mode === 'register' ? (
        <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); register.mutate(undefined); }}>
          <Field label="Full name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
          <Field label="Mobile number" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <Button variant="primary" type="submit" loading={register.isPending} disabled={f.fullName.trim().length < 2 || f.phone.trim().length < 10}>Register</Button>
        </form>
      ) : null}
      {mode === 'link' ? (
        <div className="flex flex-col gap-2">
          <Field label="Find patient" placeholder="Full mobile number, patient ID or name" value={q} onChange={(e) => setQ(e.target.value)} />
          {results.data?.map((p) => (
            <button key={p.id} type="button" onClick={() => link.mutate(p.id)} className="rounded-lg border border-line bg-surface px-3 py-2 text-left text-sm hover:border-teal">
              <b>{p.fullName}</b> <span className="text-ink-2">{p.mrn} · {phoneLabel(p.phone)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { orgId, can } = useClinic();
  const zone = useZone();
  const lead = useQuery({ queryKey: ['lead', orgId, id], queryFn: () => api<LeadDetail>(`/leads/${id}`) });
  const tasks = useTasks({ relatedType: 'lead', relatedId: id });
  const manage = can('lead:manage');
  const [note, setNote] = useState('');
  const [lost, setLost] = useState('');
  const [askLost, setAskLost] = useState(false);
  const [booking, setBooking] = useState<PatientView | null>(null);
  const [edit, setEdit] = useState<{ interest: string; owner: string; nextActionAt: string; wantsVisitBy: string } | null>(null);
  useEffect(() => {
    const l = lead.data;
    if (l) setEdit({ interest: l.interest ?? '', owner: l.ownerKind === 'user' ? `user:${l.ownerUserId}` : l.ownerKind, nextActionAt: l.nextActionAt ? DateTime.fromISO(l.nextActionAt).setZone(zone).toFormat("yyyy-LL-dd'T'HH:mm") : '', wantsVisitBy: l.wantsVisitBy ?? '' });
  }, [lead.data, zone]);

  const stage = useSave((v: { stage: LeadStage; lostReason?: string }) => api(`/leads/${id}/stage`, { method: 'POST', body: v }), ['lead', 'leads']);
  const addNote = useSave(() => api(`/leads/${id}/notes`, { method: 'POST', body: { text: note } }), ['lead', 'leads']);
  const save = useSave(() => api(`/leads/${id}`, {
    method: 'PATCH',
    body: { interest: edit!.interest || null, ...ownerBody(edit!.owner), nextActionAt: edit!.nextActionAt ? DateTime.fromISO(edit!.nextActionAt, { zone }).toISO() : null, wantsVisitBy: edit!.wantsVisitBy || null },
  }), ['lead', 'leads']);
  const err = stage.error ?? addNote.error ?? save.error;
  const l = lead.data;

  const openBooking = async () => { if (l?.patient) setBooking(await api<PatientView>(`/patients/${l.patient.profileId}`)); };

  return (
    <Drawer title={l ? (l.displayName ?? 'Lead') : 'Lead'} onClose={onClose} width={620}>
      {!l ? (lead.error ? <Notice>{errorText(lead.error)}</Notice> : <p className="text-ink-2">Loading…</p>) : (
        <>
          {err ? <Notice>{errorText(err)}</Notice> : null}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Pill tone={scoreTone(l.score)}>Score {l.score}</Pill>
            <Pill>{SOURCE_LABEL[l.source] ?? l.source}</Pill>
            {l.phone ? <span className="font-mono">{phoneLabel(l.phone)}</span> : null}
            {l.patient ? <Link to={`/patients/${l.patient.profileId}`} className="font-semibold text-teal">{l.patient.mrn} →</Link> : null}
          </div>
          {l.scoreBreakdown.length ? <p className="text-xs text-ink-2">Score: {l.scoreBreakdown.map((b) => `${b.points > 0 ? '+' : ''}${b.points} ${b.label.toLowerCase()}`).join(' · ')}</p> : <p className="text-xs text-ink-2">No scoring rule applies yet.</p>}

          <section className="flex flex-col gap-2">
            <h3 className="text-[13px] font-bold tracking-[.06em] text-ink-2">STAGE</h3>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Stage">
              {STAGES.map((s) => (
                <button key={s.key} type="button" role="radio" aria-checked={l.stage === s.key} disabled={!manage || stage.isPending}
                  onClick={() => (s.key === 'lost' ? setAskLost(true) : stage.mutate({ stage: s.key }))}
                  className={`h-8 rounded-full border px-3 text-xs font-semibold ${l.stage === s.key ? 'border-teal bg-teal text-white' : 'border-line bg-surface text-ink-2 hover:text-ink'}`}>{s.label}</button>
              ))}
            </div>
            {askLost ? (
              <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); stage.mutate({ stage: 'lost', lostReason: lost }, { onSuccess: () => { setAskLost(false); setLost(''); } }); }}>
                <Field label="Why was it lost?" value={lost} onChange={(e) => setLost(e.target.value)} placeholder="e.g. Chose another clinic" />
                <Button type="submit" disabled={lost.trim().length < 3}>Mark lost</Button>
              </form>
            ) : null}
            {l.stage === 'lost' && l.lostReason ? <p className="text-sm text-ink-2">Lost: {l.lostReason}</p> : null}
            <p className="text-xs text-ink-2">Booking a visit moves the lead to Booked, and completing it moves it to Consulted, automatically.</p>
          </section>

          {edit ? (
            <form className="grid grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
              <Field label="Interested in" value={edit.interest} onChange={(e) => setEdit({ ...edit, interest: e.target.value })} disabled={!manage} />
              <OwnerSelect value={edit.owner} onChange={(v) => setEdit({ ...edit, owner: v })} />
              <Field label="Next follow-up" type="datetime-local" value={edit.nextActionAt} onChange={(e) => setEdit({ ...edit, nextActionAt: e.target.value })} disabled={!manage} />
              <Field label="Wants a visit by" type="date" value={edit.wantsVisitBy} onChange={(e) => setEdit({ ...edit, wantsVisitBy: e.target.value })} disabled={!manage} />
              {manage ? <Button type="submit" className="col-span-2 justify-self-end" loading={save.isPending}>Save</Button> : null}
            </form>
          ) : null}

          <section className="flex flex-col gap-2 border-t border-line pt-4">
            <h3 className="text-[13px] font-bold tracking-[.06em] text-ink-2">PATIENT</h3>
            {l.patient ? (
              <div className="flex items-center gap-3 text-sm">
                <span><b>{l.patient.fullName}</b> · {l.patient.mrn}{l.hasUpcomingAppointment ? ' · visit booked' : ''}</span>
                {can('appointment:manage') ? <Button className="ml-auto" variant="primary" onClick={() => void openBooking()}>Book visit</Button> : null}
              </div>
            ) : manage ? <LinkPatient lead={l} /> : <p className="text-sm text-ink-2">Not registered yet.</p>}
          </section>

          <section className="flex flex-col gap-2 border-t border-line pt-4">
            <h3 className="text-[13px] font-bold tracking-[.06em] text-ink-2">TASKS</h3>
            <TaskList tasks={tasks.data} empty="No open tasks." />
            {manage ? <AddTaskForm related={{ type: 'lead', id: l.id }} /> : null}
          </section>

          <section className="flex flex-col gap-2 border-t border-line pt-4">
            <h3 className="text-[13px] font-bold tracking-[.06em] text-ink-2">HISTORY</h3>
            {manage ? (
              <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); addNote.mutate(undefined, { onSuccess: () => setNote('') }); }}>
                <Field label="Add a note" value={note} onChange={(e) => setNote(e.target.value)} className="flex-1" />
                <Button type="submit" disabled={!note.trim()} loading={addNote.isPending}>Add</Button>
              </form>
            ) : null}
            <ol className="flex flex-col gap-2.5">
              {l.events.map((e) => (
                <li key={e.id} className="text-sm">
                  <div><b>{e.kind === 'stage_changed' ? `${e.fromStage ? STAGE_LABEL[e.fromStage] : '—'} → ${STAGE_LABEL[e.toStage!]}` : e.kind === 'created' ? 'Lead created' : e.kind === 'note' ? 'Note' : e.kind === 'patient_linked' ? 'Registered as a patient' : e.kind === 'task_created' ? 'Task added' : e.kind === 'task_done' ? 'Task done' : e.kind === 'owner_changed' ? 'Owner changed' : e.kind.replace(/_/g, ' ')}</b>
                    <span className="text-ink-2"> · {e.actor === 'system' ? 'automatic' : e.actor} · {when(e.at, zone)}</span></div>
                  {e.note ? <div className="text-ink-2">{e.note}</div> : null}
                </li>
              ))}
            </ol>
          </section>
          {booking ? <BookingDrawer date={todayIn(zone)} patient={booking} onClose={() => setBooking(null)} /> : null}
        </>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
function RulesDrawer({ onClose }: { onClose: () => void }) {
  const { orgId, can } = useClinic();
  const rules = useQuery({ queryKey: ['scoring', orgId], queryFn: () => api<{ items: ScoringRule[] }>('/lead-scoring-rules').then((r) => r.items) });
  const update = useSave(({ id, ...body }: { id: string; points?: number; isActive?: boolean }) => api(`/lead-scoring-rules/${id}`, { method: 'PATCH', body }), ['scoring', 'leads', 'lead']);
  const edit = can('org:update');
  return (
    <Drawer title="How the score is built" onClose={onClose}>
      <p className="text-sm text-ink-2">The score is the sum of the rules below, from 0 to 100. Each lead shows which rules gave its points.</p>
      {update.error ? <Notice>{errorText(update.error)}</Notice> : null}
      <Card className="divide-y divide-line-2">
        {rules.data?.map((r) => (
          <div key={r.id} className="flex items-center gap-3 px-4 py-3">
            <Toggle label={r.label} checked={r.isActive} disabled={!edit} onChange={(v) => update.mutate({ id: r.id, isActive: v })} />
            <input type="number" aria-label={`Points for ${r.label}`} min={-50} max={50} defaultValue={r.points} disabled={!edit}
              onBlur={(e) => { const n = Number(e.target.value); if (n !== r.points && Number.isInteger(n)) update.mutate({ id: r.id, points: n }); }}
              className="ml-auto h-9 w-20 rounded-lg border border-line bg-surface px-2 text-right font-mono text-sm" />
          </div>
        ))}
      </Card>
      {!edit ? <p className="text-sm text-ink-2">Only the clinic owner can change the rules.</p> : null}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
export function PipelinePage() {
  const { can } = useClinic();
  const zone = useZone();
  const [params, setParams] = useSearchParams();
  const owner = params.get('owner') ?? '';
  const source = params.get('source') ?? '';
  const open = params.get('lead');
  const [view, setView] = useState<'board' | 'table'>('board');
  const [adding, setAdding] = useState(false);
  const [rules, setRules] = useState(false);
  const leads = useLeads({ owner, source });
  const setParam = (k: string, v: string | null) => setParams((p) => { if (v) p.set(k, v); else p.delete(k); return p; });
  const items = leads.data ?? [];
  const openCount = items.filter((l) => !['retained', 'lost'].includes(l.stage)).length;
  const overdue = items.filter((l) => l.overdue).length;

  if (!can('lead:read')) return <Notice>Your role cannot see the pipeline.</Notice>;
  const Card_ = ({ l }: { l: Lead }) => (
    <button type="button" onClick={() => setParam('lead', l.id)} className="flex w-full flex-col gap-1 rounded-xl border border-line bg-surface p-3 text-left text-sm shadow-sm hover:border-teal">
      <div className="flex items-center gap-2"><b className="truncate">{l.displayName ?? 'Unknown caller'}</b><span className="ml-auto"><Pill tone={scoreTone(l.score)}>{l.score}</Pill></span></div>
      {l.interest ? <div className="truncate text-ink-2">{l.interest}</div> : null}
      <div className="flex flex-wrap gap-x-2 text-xs text-ink-2"><span>{SOURCE_LABEL[l.source] ?? l.source}</span><span>· {ownerLabel(l)}</span></div>
      {l.nextActionAt ? <div className={`text-xs font-semibold ${l.overdue ? 'text-warn-ink' : 'text-teal'}`}>{l.overdue ? 'Overdue · ' : ''}{when(l.nextActionAt, zone)}</div> : null}
    </button>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="font-display text-[26px] font-bold">Patient pipeline</h1>
          <p className="mt-1 text-ink-2">{openCount} open · enquiry to retention</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-line bg-surface p-0.5" role="radiogroup" aria-label="View">
            {(['board', 'table'] as const).map((v) => <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)} className={`h-8 rounded-md px-3 text-sm font-semibold ${view === v ? 'bg-teal-tint text-[#0B5E57]' : 'text-ink-2'}`}>{v === 'board' ? 'Board' : 'Table'}</button>)}
          </div>
          <select aria-label="Owner" value={owner} onChange={(e) => setParam('owner', e.target.value || null)} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm">
            <option value="">Owner: anyone</option><option value="me">Mine</option><option value="ai">AI</option><option value="unassigned">Unassigned</option>
          </select>
          <select aria-label="Source" value={source} onChange={(e) => setParam('source', e.target.value || null)} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm">
            <option value="">Source: all</option>{LEAD_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
          </select>
          <Button className="h-9" onClick={() => setRules(true)}>Scoring rules</Button>
          {can('lead:manage') ? <Button variant="primary" className="h-9" onClick={() => setAdding(true)}>+ Add lead</Button> : null}
        </div>
      </div>
      {overdue ? <Notice>{overdue} follow-up{overdue > 1 ? 's are' : ' is'} overdue.</Notice> : null}
      {leads.error ? <Notice>{errorText(leads.error)}</Notice> : null}

      {leads.isPending ? <p className="text-ink-2">Loading…</p> : items.length === 0 ? <Empty>No leads yet. Add enquiries from calls, walk-ins and ads here; the AI receptionist will add its own once it is live.</Empty> : view === 'board' ? (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {STAGES.map((s) => {
            const col = items.filter((l) => l.stage === s.key);
            return (
              <div key={s.key} className="flex w-[232px] shrink-0 flex-col gap-2">
                <div className="flex items-center gap-2 px-1 text-sm font-semibold">{s.label}<span className="text-ink-2">{col.length}</span></div>
                <div className="flex min-h-24 flex-col gap-2 rounded-xl bg-[#EEEAE1] p-2">{col.map((l) => <Card_ key={l.id} l={l} />)}</div>
              </div>
            );
          })}
        </div>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[#FBF9F4] text-left text-[11px] font-bold tracking-[.06em] text-ink-2"><tr><th className="px-4 py-2.5">LEAD</th><th className="px-4">STAGE</th><th className="px-4">SCORE</th><th className="px-4">INTEREST</th><th className="px-4">SOURCE</th><th className="px-4">OWNER</th><th className="px-4">NEXT</th></tr></thead>
            <tbody>
              {items.map((l) => (
                <tr key={l.id} onClick={() => setParam('lead', l.id)} className="cursor-pointer border-t border-line-2 hover:bg-teal-tint/30">
                  <td className="px-4 py-3 font-semibold">{l.displayName ?? 'Unknown caller'}</td><td className="px-4">{STAGE_LABEL[l.stage]}</td><td className="px-4"><Pill tone={scoreTone(l.score)}>{l.score}</Pill></td>
                  <td className="px-4">{l.interest ?? '—'}</td><td className="px-4">{SOURCE_LABEL[l.source]}</td><td className="px-4">{ownerLabel(l)}</td>
                  <td className={`px-4 ${l.overdue ? 'font-semibold text-warn-ink' : ''}`}>{when(l.nextActionAt, zone) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <Notice kind="ai">Lead score = transparent rules, not a black box. Open "Scoring rules" to see or change them.</Notice>

      {adding ? <AddLeadDrawer onClose={() => setAdding(false)} onCreated={(id) => { setAdding(false); setParam('lead', id); }} /> : null}
      {open ? <LeadDrawer id={open} onClose={() => setParam('lead', null)} /> : null}
      {rules ? <RulesDrawer onClose={() => setRules(false)} /> : null}
    </div>
  );
}

import { LANGUAGES, type ConsultMode } from '@dr/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, ChipGroup, Empty, Field, Notice, Pill, Select, TextArea, Toggle } from '../../components/ui';
import { api } from '../../lib/api';
import { errorText, useClinic, useClinicData, useSave, type DoctorDetail, type DoctorSummary, type Member, type Rule } from '../../lib/clinic';
import { DAYS, MODE_LABEL, parseRupees, rupees } from '../../lib/format';

const LANGUAGE_OPTIONS = Object.entries(LANGUAGES).map(([value, label]) => ({ value, label }));
const initials = (name: string) => name.replace(/^Dr\.?\s*/i, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

type ProfileForm = {
  displayName: string; qualifications: string; registrationNumber: string; registrationCouncil: string; yearsExperience: string;
  departmentId: string; userId: string; languages: string[]; bioApproved: string; slotMinutes: string; bufferMinutes: string;
  maxOnlinePerDay: string; bookableByAi: boolean; isActive: boolean;
};
const emptyProfile: ProfileForm = {
  displayName: '', qualifications: '', registrationNumber: '', registrationCouncil: '', yearsExperience: '', departmentId: '', userId: '',
  languages: ['hi', 'en'], bioApproved: '', slotMinutes: '20', bufferMinutes: '5', maxOnlinePerDay: '', bookableByAi: true, isActive: true,
};
const toForm = (d: DoctorDetail): ProfileForm => ({
  displayName: d.displayName, qualifications: d.qualifications ?? '', registrationNumber: d.registrationNumber ?? '', registrationCouncil: d.registrationCouncil ?? '',
  yearsExperience: d.yearsExperience?.toString() ?? '', departmentId: d.departmentId ?? '', userId: d.userId ?? '', languages: d.languages,
  bioApproved: d.bioApproved ?? '', slotMinutes: String(d.slotMinutes), bufferMinutes: String(d.bufferMinutes),
  maxOnlinePerDay: d.maxOnlinePerDay?.toString() ?? '', bookableByAi: d.bookableByAi, isActive: d.isActive,
});
const intOrNull = (s: string) => (s.trim() === '' ? null : Number(s));
function toBody(f: ProfileForm) {
  return {
    displayName: f.displayName, qualifications: f.qualifications || null, registrationNumber: f.registrationNumber || null,
    registrationCouncil: f.registrationCouncil || null, yearsExperience: intOrNull(f.yearsExperience), departmentId: f.departmentId || null,
    userId: f.userId || null, languages: f.languages, bioApproved: f.bioApproved || null, slotMinutes: Number(f.slotMinutes),
    bufferMinutes: Number(f.bufferMinutes), maxOnlinePerDay: intOrNull(f.maxOnlinePerDay), bookableByAi: f.bookableByAi,
  };
}

function Profile({ doctor, onCreated }: { doctor: DoctorDetail | null; onCreated: (id: string) => void }) {
  const { can, orgId } = useClinic();
  const { departments } = useClinicData();
  const editable = can('doctor:manage');
  const members = useQuery({ queryKey: ['members', orgId], queryFn: () => api<{ items: Member[] }>('/members').then((r) => r.items), enabled: can('member:read') });
  const [f, setF] = useState<ProfileForm>(doctor ? toForm(doctor) : emptyProfile);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setF(doctor ? toForm(doctor) : emptyProfile); }, [doctor]);
  useEffect(() => { setSaved(false); }, [doctor?.id]);

  const save = useSave(async () => {
    if (doctor) return api<DoctorDetail>(`/doctors/${doctor.id}`, { method: 'PATCH', body: { ...toBody(f), isActive: f.isActive } });
    return api<DoctorDetail>('/doctors', { method: 'POST', body: toBody(f) });
  }, ['doctors', 'doctor']);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    save.mutate(undefined, { onSuccess: (d) => { setSaved(true); if (!doctor) onCreated(d.id); } });
  };
  const doctorAccounts = members.data?.filter((m) => m.roleKey === 'doctor' && m.status !== 'removed') ?? [];

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {save.error ? <Notice>{errorText(save.error)}</Notice> : saved ? <Notice kind="ok">Saved.</Notice> : null}
      <fieldset disabled={!editable || save.isPending} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name as patients hear it" placeholder="Dr. Arjun Mehta" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
          <Field label="Qualifications" placeholder="MBBS, MD (Dermatology)" value={f.qualifications} onChange={(e) => setF({ ...f, qualifications: e.target.value })} />
          <Field label="Registration number" value={f.registrationNumber} onChange={(e) => setF({ ...f, registrationNumber: e.target.value })}
            hint={doctor ? (doctor.registrationVerified ? 'Verified by DocReceptionist' : 'Not verified yet. Our team checks it against the council register.') : undefined} />
          <Field label="Medical council" placeholder="Bihar Medical Council" value={f.registrationCouncil} onChange={(e) => setF({ ...f, registrationCouncil: e.target.value })} />
          <Select label="Department" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}>
            <option value="">None</option>
            {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
          <Field label="Years of experience" inputMode="numeric" value={f.yearsExperience} onChange={(e) => setF({ ...f, yearsExperience: e.target.value })} />
        </div>
        {can('member:read') ? (
          <Select label="Staff account (lets the doctor sign in and edit their own hours)" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>
            <option value="">Not linked</option>
            {doctorAccounts.map((m) => <option key={m.userId} value={m.userId}>{m.fullName}{m.status === 'invited' ? ' (invited)' : ''}</option>)}
          </Select>
        ) : null}
        <ChipGroup label="Languages the doctor consults in" options={LANGUAGE_OPTIONS} value={f.languages} onChange={(v) => setF({ ...f, languages: v })} />
        <TextArea label="Approved profile text (optional)" value={f.bioApproved} maxLength={1500} onChange={(e) => setF({ ...f, bioApproved: e.target.value })}
          hint="The AI may read this to callers. Keep it factual; no claims of guaranteed results." />
        <div className="grid grid-cols-3 gap-4">
          <Field label="Slot length (min)" inputMode="numeric" value={f.slotMinutes} onChange={(e) => setF({ ...f, slotMinutes: e.target.value })} />
          <Field label="Gap between patients (min)" inputMode="numeric" value={f.bufferMinutes} onChange={(e) => setF({ ...f, bufferMinutes: e.target.value })} />
          <Field label="Max video consults a day" inputMode="numeric" placeholder="No limit" value={f.maxOnlinePerDay} onChange={(e) => setF({ ...f, maxOnlinePerDay: e.target.value })} />
        </div>
        <Toggle label="Bookable by AI" description="The AI receptionist offers this doctor's free slots to callers." checked={f.bookableByAi} onChange={(v) => setF({ ...f, bookableByAi: v })} />
        {doctor ? <Toggle label="Active" description="Inactive doctors are hidden from booking but keep their history." checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} /> : null}
      </fieldset>
      {editable ? <div className="flex"><Button variant="primary" type="submit" loading={save.isPending} disabled={f.displayName.trim().length < 2} className="ml-auto">{doctor ? 'Save profile' : 'Add doctor'}</Button></div> : null}
    </form>
  );
}

/** Weekly sessions, grouped by day. Saved as a whole with PUT /doctors/:id/schedule. */
function WeeklyHours({ doctor, others }: { doctor: DoctorDetail; others: DoctorSummary[] }) {
  const { can } = useClinic();
  const { branches } = useClinicData();
  const openBranches = branches.data?.filter((b) => b.isActive) ?? [];
  const [rules, setRules] = useState<Rule[]>(doctor.weeklyHours);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setRules(doctor.weeklyHours); }, [doctor]);
  // A refetch after saving must not hide the result; only switching doctor does.
  useEffect(() => { setWarnings([]); setSaved(false); }, [doctor.id]);
  const editable = can('schedule:manage');
  const dirty = JSON.stringify(rules.map(({ id: _id, ...r }) => r)) !== JSON.stringify(doctor.weeklyHours.map(({ id: _id, ...r }) => r));

  const save = useSave(() => api<{ weeklyHours: Rule[]; warnings: string[] }>(`/doctors/${doctor.id}/schedule`, {
    method: 'PUT', body: { rules: rules.map(({ weekday, start, end, mode, branchId }) => ({ weekday, start, end, mode, branchId: mode === 'clinic' ? branchId : null })) },
  }), ['doctors', 'doctor']);

  const update = (i: number, patch: Partial<Rule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = (weekday: number) => setRules([...rules, { weekday, start: '10:00', end: '13:00', mode: 'clinic', branchId: openBranches[0]?.id ?? null }]);
  const copyFrom = (id: string) => {
    const src = others.find((o) => o.id === id);
    if (src) setRules(src.weeklyHours.map(({ id: _id, ...r }) => r));
  };

  return (
    <div className="flex flex-col gap-3">
      {save.error ? <Notice>{errorText(save.error)}</Notice> : null}
      {saved && !dirty && warnings.length === 0 ? <Notice kind="ok">Hours saved. The AI only offers slots inside these hours, minus leave and existing bookings.</Notice> : null}
      {warnings.length ? <Notice>Saved, but check: {warnings.join('; ')}.</Notice> : null}
      <div className="flex flex-col">
        {DAYS.map((d, weekday) => {
          const day = rules.map((r, i) => ({ r, i })).filter((x) => x.r.weekday === weekday);
          return (
            <div key={d.key} className="flex flex-wrap items-start gap-3 border-b border-line-2 py-2.5 last:border-0">
              <div className="w-12 pt-2 text-sm font-semibold">{d.short}</div>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                {day.length === 0 ? <span className="pt-2 text-sm text-ink-2">Off</span> : null}
                {day.map(({ r, i }) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <input type="time" aria-label={`${d.long} session start`} value={r.start} disabled={!editable} onChange={(e) => update(i, { start: e.target.value })} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm" />
                    <span className="text-ink-2">–</span>
                    <input type="time" aria-label={`${d.long} session end`} value={r.end} disabled={!editable} onChange={(e) => update(i, { end: e.target.value })} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm" />
                    <select aria-label={`${d.long} session mode`} value={r.mode} disabled={!editable} onChange={(e) => {
                      const mode = e.target.value as ConsultMode;
                      update(i, { mode, branchId: mode === 'clinic' ? (r.branchId ?? openBranches[0]?.id ?? null) : null });
                    }} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm">
                      {(['clinic', 'video', 'phone'] as const).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                    </select>
                    {r.mode === 'clinic' ? (
                      <select aria-label={`${d.long} session branch`} value={r.branchId ?? ''} disabled={!editable} onChange={(e) => update(i, { branchId: e.target.value })} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm">
                        {branches.data?.map((b) => <option key={b.id} value={b.id} disabled={!b.isActive}>{b.name}</option>)}
                      </select>
                    ) : null}
                    {editable ? <button type="button" onClick={() => setRules(rules.filter((_, j) => j !== i))} className="px-1 text-ink-2 hover:text-ink" aria-label={`Remove ${d.long} session`}>✕</button> : null}
                  </div>
                ))}
              </div>
              {editable ? <button type="button" onClick={() => add(weekday)} className="pt-2 text-[13px] font-semibold text-teal">+ Session</button> : null}
            </div>
          );
        })}
      </div>
      {editable ? (
        <div className="flex flex-wrap items-center gap-2">
          {others.some((o) => o.weeklyHours.length) ? (
            <select aria-label="Copy hours from another doctor" value="" onChange={(e) => copyFrom(e.target.value)} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm">
              <option value="">Copy hours from…</option>
              {others.filter((o) => o.weeklyHours.length).map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
            </select>
          ) : null}
          <Button variant="primary" className="ml-auto" disabled={!dirty} loading={save.isPending}
            onClick={() => { setSaved(false); save.mutate(undefined, { onSuccess: (r) => { setWarnings(r.warnings); setSaved(true); } }); }}>Save hours</Button>
        </div>
      ) : null}
    </div>
  );
}

function ServicesOffered({ doctor }: { doctor: DoctorDetail }) {
  const { can } = useClinic();
  const { services } = useClinicData();
  const active = services.data?.filter((s) => s.isActive) ?? [];
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setPicked(Object.fromEntries(doctor.services.map((s) => [s.serviceId, s.feeOverridePaise === null ? '' : String(s.feeOverridePaise / 100)])));
  }, [doctor]);
  useEffect(() => { setSaved(false); }, [doctor.id]);
  const editable = can('doctor:manage');
  const invalid = Object.values(picked).some((v) => Number.isNaN(parseRupees(v)));
  const save = useSave(() => api(`/doctors/${doctor.id}/services`, {
    method: 'PUT', body: { items: Object.entries(picked).map(([serviceId, fee]) => ({ serviceId, feeOverridePaise: parseRupees(fee) })) },
  }), ['doctors', 'doctor']);

  if (active.length === 0) return <Empty>Add services under Services and fees first.</Empty>;
  return (
    <div className="flex flex-col gap-2">
      {save.error ? <Notice>{errorText(save.error)}</Notice> : saved ? <Notice kind="ok">Saved.</Notice> : null}
      {active.map((s) => {
        const on = s.id in picked;
        return (
          <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line-2 px-3 py-2">
            <label className="flex flex-1 items-center gap-2.5 text-sm">
              <input type="checkbox" checked={on} disabled={!editable} onChange={() => {
                const next = { ...picked };
                if (on) delete next[s.id]; else next[s.id] = '';
                setPicked(next);
              }} className="size-4 accent-teal" />
              <span><b>{s.name}</b> <span className="text-ink-2">· standard fee {rupees(s.feePaise)}</span></span>
            </label>
            {on ? (
              <input aria-label={`${s.name} fee for this doctor (₹)`} placeholder="Same as standard" value={picked[s.id]} disabled={!editable}
                onChange={(e) => setPicked({ ...picked, [s.id]: e.target.value })} className={`h-9 w-40 rounded-lg border bg-surface px-2 text-sm ${Number.isNaN(parseRupees(picked[s.id] ?? '')) ? 'border-[#C97A06]' : 'border-line'}`} />
            ) : null}
          </div>
        );
      })}
      {editable ? <Button variant="primary" className="self-end" disabled={invalid} loading={save.isPending} onClick={() => { setSaved(false); save.mutate(undefined, { onSuccess: () => setSaved(true) }); }}>Save services</Button> : null}
    </div>
  );
}

const fmtRange = (a: string, b: string) => {
  const o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  return `${new Date(a).toLocaleString('en-IN', o)} → ${new Date(b).toLocaleString('en-IN', o)}`;
};

function LeaveList({ doctor }: { doctor: DoctorDetail }) {
  const { can } = useClinic();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const add = useSave(() => api<{ affectedAppointments: number }>(`/doctors/${doctor.id}/leave`, {
    method: 'POST', body: { startsAt: new Date(from).toISOString(), endsAt: new Date(to).toISOString(), reason: reason || null },
  }), ['doctor']);
  const remove = useSave((id: string) => api(`/doctors/${doctor.id}/leave/${id}`, { method: 'DELETE' }), ['doctor']);
  const editable = can('schedule:manage');

  return (
    <div className="flex flex-col gap-3">
      {add.error || remove.error ? <Notice>{errorText(add.error ?? remove.error)}</Notice> : null}
      {result ? <Notice kind="ok">{result}</Notice> : null}
      {doctor.upcomingLeave.length === 0 ? <p className="text-sm text-ink-2">No upcoming leave.</p> : (
        <ul className="flex flex-col gap-2">
          {doctor.upcomingLeave.map((l) => (
            <li key={l.id} className="flex items-center gap-3 rounded-[10px] border border-line-2 px-3 py-2 text-sm">
              <Pill tone="warn">{l.kind === 'leave' ? 'Leave' : 'Blocked'}</Pill>
              <span>{fmtRange(l.startsAt, l.endsAt)}{l.reason ? <span className="text-ink-2"> · {l.reason}</span> : null}</span>
              {editable ? <button type="button" onClick={() => remove.mutate(l.id)} className="ml-auto text-[13px] font-semibold text-teal">Remove</button> : null}
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => {
          e.preventDefault(); setResult(null);
          add.mutate(undefined, {
            onSuccess: (r) => {
              setFrom(''); setTo(''); setReason('');
              setResult(r.affectedAppointments ? `Leave added. ${r.affectedAppointments} booked appointment(s) fall in this time and need moving.` : 'Leave added. No booked appointments are affected.');
            },
          });
        }}>
          <Field label="From" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Field label="To" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
          <Field label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button type="submit" loading={add.isPending} disabled={!from || !to}>Add leave</Button>
        </form>
      ) : null}
    </div>
  );
}

function RemoveDoctor({ doctor, onRemoved }: { doctor: DoctorDetail; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useSave(() => api(`/doctors/${doctor.id}`, { method: 'DELETE' }), ['doctors']);
  return (
    <div className="flex flex-wrap items-center gap-3">
      {remove.error ? <Notice>{errorText(remove.error)}</Notice> : null}
      {confirming ? (
        <>
          <span className="text-sm">Remove {doctor.displayName} from the clinic? Their past records stay.</span>
          <Button type="button" onClick={() => setConfirming(false)}>Keep</Button>
          <Button type="button" loading={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: onRemoved })} className="border-critical text-critical">Remove doctor</Button>
        </>
      ) : <Button type="button" variant="ghost" onClick={() => setConfirming(true)}>Remove doctor…</Button>}
    </div>
  );
}

function SectionBox({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <h3 className="font-display text-base font-bold">{title}</h3>
      {subtitle ? <p className="mt-0.5 text-[13px] text-ink-2">{subtitle}</p> : null}
      <div className="mt-4">{children}</div>
    </Card>
  );
}

/** Step 3 / Settings › Doctors and hours. */
export function Doctors() {
  const { can, orgId } = useClinic();
  const { doctors, departments } = useClinicData();
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const list = doctors.data?.filter((d) => d.isActive || selected === d.id) ?? [];
  const inactive = doctors.data?.filter((d) => !d.isActive) ?? [];
  const sel = selected ?? (list[0]?.id ?? (can('doctor:manage') ? 'new' : null));
  const detail = useQuery({
    queryKey: ['doctor', orgId, sel],
    queryFn: () => api<DoctorDetail>(`/doctors/${sel}`),
    enabled: !!sel && sel !== 'new',
  });
  const dept = (id: string | null) => departments.data?.find((d) => d.id === id)?.name;

  if (doctors.isPending) return <p className="text-ink-2">Loading…</p>;
  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="flex flex-[0_1_300px] flex-col gap-2">
        {[...list, ...inactive.filter((d) => !list.includes(d))].map((d) => (
          <button key={d.id} type="button" onClick={() => setSelected(d.id)} aria-current={sel === d.id ? 'true' : undefined}
            className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${sel === d.id ? 'border-teal bg-surface ring-1 ring-teal' : 'border-line bg-surface hover:shadow-sm'}`}>
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-teal-tint text-[13px] font-bold text-[#0B5E57]">{initials(d.displayName)}</span>
            <span className="min-w-0 text-sm">
              <b className="block truncate">{d.displayName}</b>
              <span className="block truncate text-ink-2">
                {[dept(d.departmentId), d.modes.map((m) => MODE_LABEL[m]).join(' + ') || 'No hours yet'].filter(Boolean).join(' · ')}
              </span>
            </span>
            {!d.isActive ? <span className="ml-auto"><Pill>Inactive</Pill></span> : d.weeklyHours.length === 0 ? <span className="ml-auto"><Pill tone="warn">No hours</Pill></span> : null}
          </button>
        ))}
        {list.length === 0 && inactive.length === 0 ? <Empty>No doctors yet.</Empty> : null}
        {can('doctor:manage') ? <Button onClick={() => setSelected('new')} className="mt-1">+ Add doctor</Button> : null}
      </div>

      <div className="flex min-w-0 flex-[1_1_560px] flex-col gap-4">
        {sel === 'new' ? (
          <SectionBox title="New doctor" subtitle="Add the doctor first, then set their weekly hours and services.">
            <Profile doctor={null} onCreated={(id) => setSelected(id)} />
          </SectionBox>
        ) : !sel ? <Empty>Your role cannot add doctors.</Empty> : detail.isPending ? <p className="text-ink-2">Loading…</p> : detail.data ? (
          <>
            <SectionBox title={detail.data.displayName} subtitle={detail.data.registrationVerified ? 'Registration verified' : 'Registration not verified yet'}>
              <Profile doctor={detail.data} onCreated={() => {}} />
            </SectionBox>
            <SectionBox title="Weekly hours" subtitle="Clinic sessions are at a branch; video and phone sessions are online. The AI only offers slots inside these hours.">
              <WeeklyHours doctor={detail.data} others={(doctors.data ?? []).filter((d) => d.id !== detail.data!.id)} />
            </SectionBox>
            <SectionBox title="Services offered" subtitle="Leave the fee blank to use the standard fee.">
              <ServicesOffered doctor={detail.data} />
            </SectionBox>
            <SectionBox title="Leave" subtitle="No slots are offered while a doctor is on leave.">
              <LeaveList doctor={detail.data} />
            </SectionBox>
            {can('doctor:manage') ? <RemoveDoctor doctor={detail.data} onRemoved={() => setSelected(null)} /> : null}
          </>
        ) : <Notice>{errorText(detail.error)}</Notice>}
      </div>
    </div>
  );
}

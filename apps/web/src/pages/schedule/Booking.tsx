import { LANGUAGES, type ConsultMode } from '@dr/contracts';
import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button, Drawer, Empty, Field, Notice, Pill, Select, TextArea } from '../../components/ui';
import { ApiRequestError, api } from '../../lib/api';
import { errorText, useClinic, useClinicData, useSave, type DoctorSummary } from '../../lib/clinic';
import { MODE_LABEL, phoneLabel, rupees } from '../../lib/format';
import { fmtDay, fmtTime, todayIn, useZone, type AppointmentView, type DaySlotsView, type PatientView, type SlotView } from '../../lib/schedule';

const LANGUAGE_OPTIONS = Object.entries(LANGUAGES);

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------
export function NewPatientForm({ initialPhone = '', initialName = '', onCreated, onCancel }: { initialPhone?: string; initialName?: string; onCreated: (p: PatientView) => void; onCancel?: () => void }) {
  const { branches } = useClinicData();
  const [f, setF] = useState({ fullName: initialName, phone: initialPhone, dateOfBirth: '', sex: '', preferredLanguage: 'hi', homeBranchId: '', city: '' });
  const [existing, setExisting] = useState<string | null>(null);
  const save = useSave(() => api<PatientView>('/patients', {
    method: 'POST',
    body: { fullName: f.fullName, phone: f.phone, dateOfBirth: f.dateOfBirth || null, sex: f.sex || null, preferredLanguage: f.preferredLanguage, homeBranchId: f.homeBranchId || null, city: f.city || null },
  }), ['patients']);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setExisting(null);
    save.mutate(undefined, {
      onSuccess: onCreated,
      onError: (err) => {
        const id = err instanceof ApiRequestError ? (err.error.details as { patientProfileId?: string } | undefined)?.patientProfileId : undefined;
        if (id) setExisting(id);
      },
    });
  };
  const useExisting = async () => {
    if (!existing) return;
    onCreated(await api<PatientView>(`/patients/${existing}`));
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {save.error ? (
        <Notice>
          {errorText(save.error)}
          {existing ? <button type="button" onClick={() => void useExisting()} className="ml-2 font-semibold text-teal underline">Use this patient</button> : null}
        </Notice>
      ) : null}
      <div className="grid grid-cols-2 gap-4">
        <Field label="Full name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        <Field label="Mobile number" type="tel" placeholder="98765 43210" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <Field label="Date of birth (optional)" type="date" value={f.dateOfBirth} onChange={(e) => setF({ ...f, dateOfBirth: e.target.value })} />
        <Select label="Sex (optional)" value={f.sex} onChange={(e) => setF({ ...f, sex: e.target.value })}>
          <option value="">Not given</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option>
        </Select>
        <Select label="Prefers to speak" value={f.preferredLanguage} onChange={(e) => setF({ ...f, preferredLanguage: e.target.value })}>
          {LANGUAGE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <Select label="Home branch" value={f.homeBranchId} onChange={(e) => setF({ ...f, homeBranchId: e.target.value })}>
          <option value="">Any branch</option>
          {branches.data?.filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
      </div>
      <Field label="City (optional)" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
      <div className="flex gap-2">
        {onCancel ? <Button type="button" onClick={onCancel}>Cancel</Button> : null}
        <Button variant="primary" type="submit" loading={save.isPending} disabled={f.fullName.trim().length < 2 || f.phone.trim().length < 10} className="ml-auto">Register patient</Button>
      </div>
    </form>
  );
}

function PatientPicker({ value, onChange }: { value: PatientView | null; onChange: (p: PatientView | null) => void }) {
  const { orgId, can } = useClinic();
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => { const id = setTimeout(() => setDebounced(term.trim()), 250); return () => clearTimeout(id); }, [term]);
  const results = useQuery({
    queryKey: ['patients', orgId, debounced],
    queryFn: () => api<{ items: PatientView[] }>(`/patients?q=${encodeURIComponent(debounced)}`).then((r) => r.items),
    enabled: debounced.length >= 2,
  });

  if (value) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-teal bg-surface px-4 py-3">
        <div className="min-w-0 text-sm"><b>{value.fullName}</b> <span className="text-ink-2">· {value.mrn} · {phoneLabel(value.phone)}</span></div>
        <button type="button" onClick={() => onChange(null)} className="ml-auto text-[13px] font-semibold text-teal">Change</button>
      </div>
    );
  }
  if (creating) {
    const digits = term.replace(/\D/g, '');
    return <NewPatientForm initialPhone={digits.length >= 10 ? term : ''} initialName={digits.length >= 10 ? '' : term} onCreated={(p) => { setCreating(false); onChange(p); }} onCancel={() => setCreating(false)} />;
  }
  return (
    <div className="flex flex-col gap-2">
      <Field label="Find patient" placeholder="Full mobile number, patient ID or name" value={term} onChange={(e) => setTerm(e.target.value)} autoFocus />
      {debounced.length >= 2 ? (
        results.isPending ? <p className="text-sm text-ink-2">Searching…</p> : results.data?.length ? (
          <ul className="flex flex-col divide-y divide-line-2 rounded-xl border border-line bg-surface">
            {results.data.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => onChange(p)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-teal-tint/40">
                  <b>{p.fullName}</b><span className="text-ink-2">{p.mrn} · {phoneLabel(p.phone)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-2">No patient found.</p>
      ) : null}
      {can('patient:manage') ? <Button type="button" onClick={() => setCreating(true)} className="self-start">+ Register new patient</Button> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------
export function SlotPicker({ doctorId, serviceId, mode, branchId, startDate, value, onChange }: {
  doctorId: string; serviceId: string; mode: ConsultMode; branchId: string | null; startDate: string; value: SlotView | null; onChange: (s: SlotView) => void;
}) {
  const { orgId } = useClinic();
  const zone = useZone();
  const [from, setFrom] = useState(startDate < todayIn(zone) ? todayIn(zone) : startDate);
  const avail = useQuery({
    queryKey: ['availability', orgId, doctorId, serviceId, mode, branchId, from],
    queryFn: () => api<{ days: DaySlotsView[] }>(`/availability?doctorId=${doctorId}&serviceId=${serviceId}&mode=${mode}&from=${from}&days=7${branchId ? `&branchId=${branchId}` : ''}`).then((r) => r.days),
  });
  const [day, setDay] = useState<string | null>(null);
  const days = avail.data ?? [];
  const selected = days.find((d) => d.date === day) ?? days.find((d) => d.slots.length) ?? days[0];
  const shift = (n: number) => { setFrom(DateTime.fromISO(from).plus({ days: n }).toISODate()!); setDay(null); };
  const canGoBack = from > todayIn(zone);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <button type="button" disabled={!canGoBack} onClick={() => shift(-7)} className="grid size-9 place-items-center rounded-lg border border-line bg-surface disabled:opacity-40" aria-label="Previous week">‹</button>
        <div className="flex flex-1 gap-1.5 overflow-x-auto">
          {days.map((d) => (
            <button key={d.date} type="button" onClick={() => setDay(d.date)} aria-pressed={selected?.date === d.date}
              className={`flex min-w-[64px] flex-1 flex-col items-center rounded-lg border px-1 py-1.5 text-xs ${selected?.date === d.date ? 'border-teal bg-teal-tint text-[#0B5E57]' : 'border-line bg-surface'} ${d.slots.length ? '' : 'opacity-50'}`}>
              <b>{DateTime.fromISO(d.date).toFormat('ccc')}</b>
              <span>{DateTime.fromISO(d.date).toFormat('d LLL')}</span>
              <span className="text-[10px] text-ink-2">{d.slots.length ? `${d.slots.length} free` : 'none'}</span>
            </button>
          ))}
        </div>
        <button type="button" onClick={() => shift(7)} className="grid size-9 place-items-center rounded-lg border border-line bg-surface" aria-label="Next week">›</button>
      </div>
      {avail.isPending ? <p className="text-sm text-ink-2">Finding free times…</p> : avail.error ? <Notice>{errorText(avail.error)}</Notice> : selected?.slots.length ? (
        <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Free times">
          {selected.slots.map((s) => {
            const on = value?.start === s.start;
            return (
              <button key={s.start} type="button" role="radio" aria-checked={on} onClick={() => onChange(s)}
                className={`h-10 rounded-lg border text-sm font-semibold ${on ? 'border-teal bg-teal text-white' : 'border-line bg-surface hover:border-teal'}`}>
                {fmtTime(s.start, zone)}
              </button>
            );
          })}
        </div>
      ) : <Empty>No free times this day. Pick another day or week.</Empty>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------
const offers = (d: DoctorSummary, serviceId: string) => d.serviceIds.length === 0 || d.serviceIds.includes(serviceId);

export function BookingDrawer({ date, doctorId: initialDoctor, patient: initialPatient, onClose, onBooked }: {
  date: string; doctorId?: string; patient?: PatientView | null; onClose: () => void; onBooked?: (a: AppointmentView) => void;
}) {
  const { doctors, services, branches } = useClinicData();
  const zone = useZone();
  const [patient, setPatient] = useState<PatientView | null>(initialPatient ?? null);
  const activeServices = services.data?.filter((s) => s.isActive) ?? [];
  const [serviceId, setServiceId] = useState('');
  const [doctorId, setDoctorId] = useState(initialDoctor ?? '');
  const [mode, setMode] = useState<ConsultMode>('clinic');
  const [branchId, setBranchId] = useState<string>('');
  const [slot, setSlot] = useState<SlotView | null>(null);
  const [reason, setReason] = useState('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  // Start with the shortest service (usually the consultation), not the first in the alphabet.
  useEffect(() => {
    const first = [...activeServices].sort((a, b) => a.durationMinutes - b.durationMinutes)[0];
    if (!serviceId && first) setServiceId(first.id);
  }, [activeServices, serviceId]);
  const service = activeServices.find((s) => s.id === serviceId);
  const eligible = useMemo(() => (doctors.data ?? []).filter((d) => d.isActive && offers(d, serviceId) && d.weeklyHours.length), [doctors.data, serviceId]);
  useEffect(() => { if (eligible.length && !eligible.some((d) => d.id === doctorId)) setDoctorId(eligible[0]!.id); }, [eligible, doctorId]);
  const doctor = eligible.find((d) => d.id === doctorId);
  const modes = (service?.modes ?? []).filter((m) => doctor?.modes.includes(m));
  useEffect(() => { if (modes.length && !modes.includes(mode)) setMode(modes[0]!); }, [modes, mode]);
  const doctorBranches = (branches.data ?? []).filter((b) => doctor?.branchIds.includes(b.id));
  useEffect(() => { setSlot(null); }, [serviceId, doctorId, mode, branchId]);

  const book = useSave(() => api<AppointmentView>('/appointments', {
    method: 'POST',
    body: { patientProfileId: patient!.id, doctorId, serviceId, mode, branchId: mode === 'clinic' ? slot!.branchId : null, start: slot!.start, reasonText: reason || null, idempotencyKey },
  }), ['appointments', 'availability', 'patients', 'patient']);

  return (
    <Drawer title="Book an appointment" onClose={onClose} width={600}>
      {book.error ? <Notice>{errorText(book.error)}</Notice> : null}
      <section className="flex flex-col gap-2"><h3 className="text-[13px] font-bold tracking-[.06em] text-ink-2">1 · PATIENT</h3><PatientPicker value={patient} onChange={setPatient} /></section>
      <section className="flex flex-col gap-3">
        <h3 className="text-[13px] font-bold tracking-[.06em] text-ink-2">2 · WHAT AND WITH WHOM</h3>
        {activeServices.length === 0 ? <Notice>Add a service under Settings › Services and fees first.</Notice> : (
          <div className="grid grid-cols-2 gap-4">
            <Select label="Service" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
              {activeServices.map((s) => <option key={s.id} value={s.id}>{s.name} · {rupees(s.feePaise)}</option>)}
            </Select>
            <Select label="Doctor" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} disabled={!eligible.length}>
              {eligible.length ? eligible.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>) : <option>No doctor offers this</option>}
            </Select>
          </div>
        )}
        {doctor && modes.length ? (
          <div className="flex flex-wrap items-end gap-3">
            <div role="radiogroup" aria-label="Visit type" className="flex gap-2">
              {modes.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                  className={`h-10 rounded-full border px-4 text-sm font-semibold ${mode === m ? 'border-teal bg-teal-tint text-[#0B5E57]' : 'border-line bg-surface text-ink-2'}`}>{MODE_LABEL[m]}</button>
              ))}
            </div>
            {mode === 'clinic' && doctorBranches.length > 1 ? (
              <Select label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-56">
                <option value="">Any of the doctor's branches</option>
                {doctorBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            ) : null}
          </div>
        ) : doctor ? <Notice>{doctor.displayName} has no {service?.modes.map((m) => MODE_LABEL[m].toLowerCase()).join(' or ')} sessions for this service.</Notice> : null}
      </section>
      {doctor && modes.includes(mode) ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-bold tracking-[.06em] text-ink-2">3 · TIME</h3>
          <SlotPicker doctorId={doctor.id} serviceId={serviceId} mode={mode} branchId={mode === 'clinic' && branchId ? branchId : null} startDate={date} value={slot} onChange={setSlot} />
        </section>
      ) : null}
      <TextArea label="Reason for visit (optional)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="In the patient's words, e.g. hair fall for 6 months" />
      <div className="sticky bottom-0 -mx-6 flex items-center gap-3 border-t border-line bg-canvas px-6 py-4">
        <div className="text-sm">
          {slot && patient ? <><b>{patient.fullName}</b> · {fmtDay(slot.start, zone)}, {fmtTime(slot.start, zone)}{slot.branchId ? ` · ${branches.data?.find((b) => b.id === slot.branchId)?.name}` : ` · ${MODE_LABEL[mode]}`}</> : <span className="text-ink-2">Choose a patient and a time.</span>}
        </div>
        <Button variant="primary" className="ml-auto" disabled={!patient || !slot} loading={book.isPending}
          onClick={() => book.mutate(undefined, { onSuccess: (a) => { onBooked?.(a); onClose(); } })}>Book</Button>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// One appointment: details and actions
// ---------------------------------------------------------------------------
const ACTIONS: Record<string, { status: string; label: string; primary?: boolean }[]> = {
  booked: [{ status: 'confirmed', label: 'Mark confirmed' }, { status: 'checked_in', label: 'Check in', primary: true }, { status: 'in_consultation', label: 'Start consultation' }, { status: 'no_show', label: 'No-show' }],
  confirmed: [{ status: 'checked_in', label: 'Check in', primary: true }, { status: 'in_consultation', label: 'Start consultation' }, { status: 'no_show', label: 'No-show' }],
  checked_in: [{ status: 'in_consultation', label: 'Send in to doctor', primary: true }, { status: 'completed', label: 'Mark completed' }],
  in_consultation: [{ status: 'completed', label: 'Mark completed', primary: true }],
};

export function AppointmentDrawer({ appointment, onClose }: { appointment: AppointmentView; onClose: () => void }) {
  const { can } = useClinic();
  const { branches } = useClinicData();
  const zone = useZone();
  const [a, setA] = useState(appointment);
  const [panel, setPanel] = useState<'none' | 'cancel' | 'move'>('none');
  const [reason, setReason] = useState('');
  const [slot, setSlot] = useState<SlotView | null>(null);
  const invalidate = ['appointments', 'availability', 'patient', 'patients'];
  const status = useSave((s: string) => api<AppointmentView>(`/appointments/${a.id}/status`, { method: 'POST', body: { status: s } }), invalidate);
  const cancel = useSave(() => api<AppointmentView>(`/appointments/${a.id}/cancel`, { method: 'POST', body: { reason } }), invalidate);
  const move = useSave(() => api<AppointmentView>(`/appointments/${a.id}/reschedule`, { method: 'POST', body: { start: slot!.start, branchId: slot!.branchId } }), invalidate);
  const err = status.error ?? cancel.error ?? move.error;
  const manage = can('appointment:manage');
  const branch = branches.data?.find((b) => b.id === a.branchId)?.name;
  const date = DateTime.fromISO(a.start).setZone(zone).toISODate()!;
  const done = (n: AppointmentView) => { setA(n); setPanel('none'); setReason(''); setSlot(null); };

  return (
    <Drawer title={a.patient.fullName} onClose={onClose}>
      {err ? <Notice>{errorText(err)}</Notice> : null}
      <dl className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-2.5 text-sm">
        <dt className="text-ink-2">Status</dt><dd><StatusPill status={a.status} /></dd>
        <dt className="text-ink-2">When</dt><dd><b>{fmtDay(a.start, zone)}, {fmtTime(a.start, zone)}–{fmtTime(a.end, zone)}</b></dd>
        <dt className="text-ink-2">Doctor</dt><dd>{a.doctorName}</dd>
        <dt className="text-ink-2">Service</dt><dd>{a.serviceName} · {rupees(a.feePaise)}</dd>
        <dt className="text-ink-2">Where</dt><dd>{a.mode === 'clinic' ? branch ?? 'Clinic' : `${MODE_LABEL[a.mode]} consultation`}</dd>
        <dt className="text-ink-2">Patient ID</dt><dd className="font-mono">{a.patient.mrn}</dd>
        {a.reasonText ? <><dt className="text-ink-2">Reason</dt><dd>{a.reasonText}</dd></> : null}
        {a.cancelledReason ? <><dt className="text-ink-2">{a.status === 'cancelled' ? 'Cancelled because' : 'Note'}</dt><dd>{a.cancelledReason}</dd></> : null}
        <dt className="text-ink-2">Booked by</dt><dd>{a.bookedByKind === 'ai_agent' ? 'AI receptionist' : a.bookedByKind === 'staff' ? 'Clinic staff' : a.bookedByKind} · {DateTime.fromISO(a.createdAt).setZone(zone).toFormat('d LLL, h:mm a')}</dd>
      </dl>
      {a.mode === 'video' && ['booked', 'confirmed'].includes(a.status) ? <Notice kind="ai">Video links are created when video consultations are switched on.</Notice> : null}

      {manage && ACTIONS[a.status] ? (
        <div className="flex flex-wrap gap-2">
          {ACTIONS[a.status]!.filter((x) => a.mode === 'clinic' || x.status !== 'checked_in').map((x) => (
            <Button key={x.status} variant={x.primary ? 'primary' : undefined} loading={status.isPending && status.variables === x.status}
              onClick={() => status.mutate(x.status, { onSuccess: done })}>{x.label}</Button>
          ))}
        </div>
      ) : null}

      {manage && ['booked', 'confirmed'].includes(a.status) ? (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="flex gap-2">
            <Button onClick={() => setPanel(panel === 'move' ? 'none' : 'move')}>Reschedule…</Button>
            <Button variant="ghost" onClick={() => setPanel(panel === 'cancel' ? 'none' : 'cancel')}>Cancel appointment…</Button>
          </div>
          {panel === 'move' ? (
            <div className="flex flex-col gap-3">
              <SlotPicker doctorId={a.doctorId} serviceId={a.serviceId} mode={a.mode} branchId={null} startDate={date} value={slot} onChange={setSlot} />
              <Button variant="primary" className="self-end" disabled={!slot} loading={move.isPending} onClick={() => move.mutate(undefined, { onSuccess: done })}>
                Move to {slot ? `${fmtDay(slot.start, zone)}, ${fmtTime(slot.start, zone)}` : '…'}
              </Button>
            </div>
          ) : null}
          {panel === 'cancel' ? (
            <div className="flex flex-col gap-3">
              <TextArea label="Why is it cancelled?" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Patient is travelling" />
              <Button className="self-end border-critical text-critical" disabled={reason.trim().length < 3} loading={cancel.isPending} onClick={() => cancel.mutate(undefined, { onSuccess: done })}>Cancel appointment</Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

export function StatusPill({ status }: { status: AppointmentView['status'] }) {
  const tone = { booked: 'teal', confirmed: 'teal', checked_in: 'ai', in_consultation: 'ai', completed: 'ok', cancelled: 'n', no_show: 'warn', rescheduled: 'n' } as const;
  const label = { booked: 'Booked', confirmed: 'Confirmed', checked_in: 'Checked in', in_consultation: 'With doctor', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show', rescheduled: 'Moved' } as const;
  return <Pill tone={tone[status]}>{label[status]}</Pill>;
}

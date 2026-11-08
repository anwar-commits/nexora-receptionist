import { DateTime } from 'luxon';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Button, Card, Drawer, Empty, Notice, Pill, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { errorText, useClinic, useClinicData, useSave } from '../../lib/clinic';
import { money, rupees } from '../../lib/format';
import { useConversations, useDues, type DueItem } from '../../lib/reception';
import { LIVE, fmtDayLong, todayIn, useAppointments, useZone, type AppointmentView, type PatientView } from '../../lib/schedule';
import { MyTasks } from '../crm/Tasks';
import { AppointmentDrawer, BookingDrawer, PatientPicker } from '../schedule/Booking';
import { WaitingRoom } from '../schedule/WaitingRoom';
import { CollectDrawer } from './Payments';
import { CallsPanel } from '../ai/Calls';

function WalkInDrawer({ onClose }: { onClose: () => void }) {
  const { doctors, services } = useClinicData();
  const zone = useZone();
  const weekday = DateTime.now().setZone(zone).weekday - 1;
  const [patient, setPatient] = useState<PatientView | null>(null);
  const clinicServices = (services.data ?? []).filter((s) => s.isActive && s.modes.includes('clinic')).sort((a, b) => a.durationMinutes - b.durationMinutes);
  // Doctors with a clinic session today come first.
  const docs = useMemo(() => (doctors.data ?? []).filter((d) => d.isActive)
    .map((d) => ({ d, today: d.weeklyHours.some((r) => r.weekday === weekday && r.mode === 'clinic') }))
    .sort((a, b) => Number(b.today) - Number(a.today)), [doctors.data, weekday]);
  const [doctorId, setDoctorId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const doctor = doctorId || docs[0]?.d.id || '';
  const service = serviceId || clinicServices[0]?.id || '';
  const [token, setToken] = useState<string | null>(null);
  const save = useSave(() => api<{ token: string }>('/queue/walk-in', { method: 'POST', body: { patientProfileId: patient!.id, doctorId: doctor, serviceId: service } }), ['queue', 'dues']);
  return (
    <Drawer title="Walk-in" onClose={onClose}>
      {token ? (
        <div className="flex flex-col items-center gap-4 py-6">
          <div className="text-sm text-ink-2">Token for {patient?.fullName}</div>
          <div className="rounded-2xl bg-navy px-8 py-5 font-mono text-5xl font-bold text-white">{token}</div>
          <p className="text-sm text-ink-2">They are in the waiting room. Collect the fee from "To collect".</p>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      ) : (
        <>
          {save.error ? <Notice>{errorText(save.error)}</Notice> : null}
          <PatientPicker value={patient} onChange={setPatient} />
          <div className="grid grid-cols-2 gap-4">
            <Select label="Doctor" value={doctor} onChange={(e) => setDoctorId(e.target.value)}>
              {docs.map(({ d, today }) => <option key={d.id} value={d.id}>{d.displayName}{today ? '' : ' (no clinic session today)'}</option>)}
            </Select>
            <Select label="Service" value={service} onChange={(e) => setServiceId(e.target.value)}>
              {clinicServices.map((s) => <option key={s.id} value={s.id}>{s.name} · {rupees(s.feePaise)}</option>)}
            </Select>
          </div>
          <Button variant="primary" disabled={!patient || !doctor || !service} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: (r) => setToken(r.token) })}>Add to waiting room</Button>
        </>
      )}
    </Drawer>
  );
}

function ToCollect({ onCollect }: { onCollect: (d: DueItem) => void }) {
  const dues = useDues();
  const zone = useZone();
  const open = dues.data?.items.filter((d) => d.duePaise > 0) ?? [];
  return (
    <Card className="p-5">
      <div className="flex items-center"><h2 className="font-display text-lg font-bold">To collect</h2><span className="ml-auto font-mono text-sm font-semibold">{money(dues.data?.totalDuePaise ?? 0)}</span></div>
      {dues.error ? <Notice>{errorText(dues.error)}</Notice> : null}
      {open.length === 0 ? <p className="mt-2 text-sm text-ink-2">Nothing due right now.</p> : (
        <ul className="mt-2 flex flex-col divide-y divide-line-2">
          {open.map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-2 text-sm">
              {d.token ? <span className="rounded-md bg-navy px-1.5 py-0.5 font-mono text-xs font-bold text-white">{d.token}</span> : <span className="w-[42px] text-xs text-ink-2">{DateTime.fromISO(d.at).setZone(zone).toFormat('h:mm')}</span>}
              <span className="min-w-0 flex-1 truncate"><b>{d.patient.fullName}</b> <span className="text-ink-2">· {d.service}{d.kind === 'walk_in' ? ' · walk-in' : ''}</span></span>
              <span className="font-mono">{money(d.duePaise)}</span>
              <Button className="h-8 px-3 text-xs" onClick={() => onCollect(d)}>Collect</Button>
            </li>
          ))}
        </ul>
      )}
      <Link to="/payments" className="mt-3 inline-block text-[13px] font-semibold text-teal">Today's payments and day close →</Link>
    </Card>
  );
}

function InboxPreview() {
  const list = useConversations('status=open');
  const zone = useZone();
  const items = (list.data ?? []).slice(0, 5);
  const unread = (list.data ?? []).reduce((n, c) => n + c.unread, 0);
  return (
    <Card className="p-5">
      <div className="flex items-center"><h2 className="font-display text-lg font-bold">Inbox</h2>{unread ? <span className="ml-2"><Pill tone="teal">{unread} unread</Pill></span> : null}<Link to="/inbox" className="ml-auto text-[13px] font-semibold text-teal">Open inbox →</Link></div>
      {items.length === 0 ? <p className="mt-2 text-sm text-ink-2">No open conversations.</p> : (
        <ul className="mt-2 flex flex-col divide-y divide-line-2">
          {items.map((c) => (
            <li key={c.id}><Link to={`/inbox?c=${c.id}`} className="flex items-center gap-2 py-2 text-sm">
              <b className="shrink-0">{c.party.name ?? c.party.phone}</b>
              <span className="min-w-0 flex-1 truncate text-ink-2">"{c.lastMessage?.body}"</span>
              <span className="text-xs text-ink-2">{c.lastMessageAt ? DateTime.fromISO(c.lastMessageAt).setZone(zone).toFormat('h:mm a') : ''}</span>
              {c.unread ? <span className="grid h-5 min-w-5 place-items-center rounded-full bg-teal px-1.5 text-[11px] font-bold text-white">{c.unread}</span> : null}
            </Link></li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Arriving() {
  const zone = useZone();
  const { can } = useClinic();
  const appts = useAppointments(todayIn(zone));
  const keys = ['appointments', 'queue', 'dues', 'timeline', 'leads'];
  const act = useSave(({ id, status }: { id: string; status: string }) => api(`/appointments/${id}/status`, { method: 'POST', body: { status } }), keys);
  const [open, setOpen] = useState<AppointmentView | null>(null);
  const list = (appts.data ?? []).filter((a) => a.status === 'booked' || a.status === 'confirmed');
  const now = Date.now();
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2"><h2 className="font-display text-lg font-bold">Arriving today</h2><span className="text-sm text-ink-2">{list.length} not checked in</span></div>
      {act.error ? <div className="mt-2"><Notice>{errorText(act.error)}</Notice></div> : null}
      {list.length === 0 ? <p className="mt-2 text-sm text-ink-2">Everyone booked for today has arrived.</p> : (
        <ul className="mt-2 flex flex-col divide-y divide-line-2">
          {list.map((a) => {
            const late = new Date(a.start).getTime() < now;
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <span className={`w-16 font-semibold ${late ? 'text-warn-ink' : ''}`}>{DateTime.fromISO(a.start).setZone(zone).toFormat('h:mm a')}</span>
                <button type="button" onClick={() => setOpen(a)} className="min-w-0 flex-1 truncate text-left"><b>{a.patient.fullName}</b> <span className="text-ink-2">· {a.doctorName} · {a.mode === 'clinic' ? a.serviceName : `${a.mode} consult`}</span></button>
                {a.status === 'confirmed' ? <Pill tone="teal">Confirmed</Pill> : null}
                {can('appointment:manage') && a.mode === 'clinic' ? <Button variant="primary" className="h-8 px-3 text-xs" loading={act.isPending && act.variables?.id === a.id} onClick={() => act.mutate({ id: a.id, status: 'checked_in' })}>Check in</Button> : null}
                {can('appointment:manage') && late ? <button type="button" className="text-xs font-semibold text-ink-2 hover:text-ink" onClick={() => act.mutate({ id: a.id, status: 'no_show' })}>No-show</button> : null}
              </li>
            );
          })}
        </ul>
      )}
      {open ? <AppointmentDrawer appointment={open} onClose={() => setOpen(null)} /> : null}
    </Card>
  );
}

/** The front desk for one day: who is here, who is waiting, what is owed, who wrote in. */
export function ReceptionPage() {
  const { can } = useClinic();
  const zone = useZone();
  const today = todayIn(zone);
  const appts = useAppointments(today);
  const dues = useDues();
  const [walkIn, setWalkIn] = useState(false);
  const [booking, setBooking] = useState(false);
  const [collect, setCollect] = useState<DueItem | 'free' | null>(null);
  const items = appts.data ?? [];
  const live = items.filter((a) => LIVE.has(a.status) || a.status === 'completed');
  const stats = [
    { label: 'Appointments today', value: String(live.length) },
    { label: 'Checked in', value: String(items.filter((a) => ['checked_in', 'in_consultation', 'completed'].includes(a.status)).length) },
    { label: 'Waiting now', value: String(items.filter((a) => a.status === 'checked_in').length) },
    { label: 'To collect', value: money(dues.data?.totalDuePaise ?? 0) },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <div><h1 className="font-display text-[26px] font-bold">Reception</h1><p className="mt-1 text-ink-2">{fmtDayLong(today, zone)}</p></div>
        <div className="ml-auto flex gap-2">
          {can('appointment:manage') ? <Button onClick={() => setWalkIn(true)}>Walk-in</Button> : null}
          {can('payment:collect') ? <Button onClick={() => setCollect('free')}>Collect payment</Button> : null}
          {can('appointment:manage') ? <Button variant="primary" onClick={() => setBooking(true)}>New booking</Button> : null}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        {stats.map((s) => <Card key={s.label} className="p-4"><div className="text-xs font-bold tracking-[.06em] text-ink-2">{s.label.toUpperCase()}</div><div className="mt-1 text-2xl font-bold">{s.value}</div></Card>)}
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[1fr_400px]">
        <div className="flex flex-col gap-5">
          <Arriving />
          <WaitingRoom />
          {items.length === 0 ? <Empty>No appointments today.</Empty> : null}
        </div>
        <div className="flex flex-col gap-5">
          {can('payment:collect') ? <ToCollect onCollect={setCollect} /> : null}
          {can('inbox:read') ? <InboxPreview /> : null}
          {can('call:read') ? <CallsPanel /> : null}
          <Card className="p-5"><MyTasks /></Card>
        </div>
      </div>
      {walkIn ? <WalkInDrawer onClose={() => setWalkIn(false)} /> : null}
      {booking ? <BookingDrawer date={today} onClose={() => setBooking(false)} /> : null}
      {collect ? (
        <CollectDrawer onClose={() => setCollect(null)} target={collect === 'free' ? null : {
          patient: collect.patient, duePaise: collect.duePaise,
          ...(collect.kind === 'appointment' ? { appointmentId: collect.id } : { queueTokenId: collect.id }),
        }} />
      ) : null}
    </div>
  );
}

import { LANGUAGES } from '@dr/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button, Card, Drawer, Empty, Field, Notice, SectionTitle, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { errorText, useClinic, useClinicData, useSave } from '../../lib/clinic';
import { SOURCE_LABEL } from '../../lib/crm';
import { MODE_LABEL, phoneLabel, rupees } from '../../lib/format';
import { fmtDay, fmtTime, todayIn, useZone, type AppointmentView, type PatientDetail, type PatientView } from '../../lib/schedule';
import { ConsentCard, PatientLeadsAndTasks, TimelineCard } from '../crm/PatientCrm';
import { AppointmentDrawer, BookingDrawer, NewPatientForm, StatusPill } from './Booking';

export function PatientsPage() {
  const { orgId, can } = useClinic();
  const { branches } = useClinicData();
  const zone = useZone();
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  const [registering, setRegistering] = useState(false);
  const [upcoming, setUpcoming] = useState(false);
  useEffect(() => { const id = setTimeout(() => setQ(term.trim()), 250); return () => clearTimeout(id); }, [term]);
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(upcoming ? { upcoming: '1' } : {}) }).toString();
  const list = useQuery({
    queryKey: ['patients', orgId, qs],
    queryFn: () => api<{ items: PatientView[] }>(`/patients${qs ? `?${qs}` : ''}`).then((r) => r.items),
    enabled: !!orgId && can('patient:read'),
  });
  const branchName = (id: string | null) => (id ? branches.data?.find((b) => b.id === id)?.name ?? '—' : 'Any');

  if (!can('patient:read')) return <Notice>Your role cannot see patients.</Notice>;
  return (
    <div className="flex flex-col gap-5">
      <SectionTitle title="Patients" subtitle="Search by the full mobile number, the patient ID (e.g. LH-1001) or part of the name."
        action={can('patient:manage') ? <Button variant="primary" onClick={() => setRegistering(true)}>+ Register patient</Button> : undefined} />
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Search" placeholder="98765 43210, LH-1001 or Ravi" value={term} onChange={(e) => setTerm(e.target.value)} className="w-96" />
        <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" className="accent-teal" checked={upcoming} onChange={(e) => setUpcoming(e.target.checked)} />Has an upcoming visit</label>
        <span className="mb-3 ml-auto text-xs text-ink-2">Numbers are masked until you open a record.</span>
      </div>
      {list.error ? <Notice>{errorText(list.error)}</Notice> : null}
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[#FBF9F4] text-left text-[11px] font-bold tracking-[.06em] text-ink-2">
            <tr><th className="px-4 py-2.5">PATIENT</th><th className="px-4">ID</th><th className="px-4">MOBILE</th><th className="px-4">LAST VISIT</th><th className="px-4">NEXT VISIT</th><th className="px-4">BRANCH</th><th className="px-4">SOURCE</th></tr>
          </thead>
          <tbody>
            {list.data?.map((p) => (
              <tr key={p.id} className="border-t border-line-2 hover:bg-teal-tint/30">
                <td className="px-4 py-3"><Link to={`/patients/${p.id}`} className="font-semibold text-ink hover:text-teal">{p.fullName}</Link></td>
                <td className="px-4 font-mono">{p.mrn}</td>
                <td className="px-4 font-mono">{p.phoneMasked ? p.phone : phoneLabel(p.phone)}</td>
                <td className="px-4">{p.lastVisitAt ? fmtDay(p.lastVisitAt, zone) : '—'}</td>
                <td className="px-4">{p.nextAppointmentAt ? `${fmtDay(p.nextAppointmentAt, zone)}, ${fmtTime(p.nextAppointmentAt, zone)}` : '—'}</td>
                <td className="px-4">{branchName(p.homeBranchId)}</td>
                <td className="px-4">{p.source ? SOURCE_LABEL[p.source] ?? p.source : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data?.length === 0 ? <div className="p-4"><Empty>{q ? 'No patient matches.' : 'No patients yet.'}</Empty></div> : null}
        {list.data?.length === 50 ? <p className="px-4 py-2 text-xs text-ink-2">Showing the 50 most recent. Search to narrow down.</p> : null}
      </Card>
      {registering ? (
        <Drawer title="Register patient" onClose={() => setRegistering(false)}>
          <NewPatientForm onCreated={() => setRegistering(false)} onCancel={() => setRegistering(false)} />
        </Drawer>
      ) : null}
    </div>
  );
}

export function PatientPage() {
  const { id = '' } = useParams();
  const { orgId, can } = useClinic();
  const { branches } = useClinicData();
  const zone = useZone();
  const detail = useQuery({ queryKey: ['patient', orgId, id], queryFn: () => api<PatientDetail>(`/patients/${id}`), enabled: !!orgId });
  const [editing, setEditing] = useState(false);
  const [booking, setBooking] = useState(false);
  const [open, setOpen] = useState<AppointmentView | null>(null);
  const [f, setF] = useState({ fullName: '', phone: '', city: '', homeBranchId: '', preferredLanguage: 'hi', dateOfBirth: '' });
  useEffect(() => {
    const p = detail.data;
    if (p) setF({ fullName: p.fullName, phone: p.phone, city: p.city ?? '', homeBranchId: p.homeBranchId ?? '', preferredLanguage: p.preferredLanguage, dateOfBirth: p.dateOfBirth ?? '' });
  }, [detail.data]);
  const save = useSave(() => api(`/patients/${id}`, {
    method: 'PATCH', body: { fullName: f.fullName, phone: f.phone, city: f.city || null, homeBranchId: f.homeBranchId || null, preferredLanguage: f.preferredLanguage, dateOfBirth: f.dateOfBirth || null },
  }), ['patient', 'patients']);

  if (detail.isPending) return <p className="text-ink-2">Loading…</p>;
  if (!detail.data) return <Notice>{errorText(detail.error)}</Notice>;
  const p = detail.data;
  const upcoming = p.appointments.filter((a) => new Date(a.end) > new Date() && ['booked', 'confirmed', 'checked_in', 'in_consultation'].includes(a.status));
  const past = p.appointments.filter((a) => !upcoming.includes(a)).reverse();

  return (
    <div className="flex flex-col gap-5">
      <Link to="/patients" className="text-[13px] font-semibold text-teal">← Patients</Link>
      <SectionTitle title={p.fullName} subtitle={<span className="font-mono">{p.mrn} · {phoneLabel(p.phone)}</span>}
        action={<>
          {can('patient:manage') ? <Button onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit details'}</Button> : null}
          {can('appointment:manage') ? <Button variant="primary" onClick={() => setBooking(true)}>+ Book appointment</Button> : null}
        </>} />
      {editing ? (
        <Card className="p-5">
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: () => setEditing(false) }); }}>
            {save.error ? <Notice>{errorText(save.error)}</Notice> : null}
            <div className="grid grid-cols-3 gap-4">
              <Field label="Full name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
              <Field label="Mobile number" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
              <Field label="Date of birth" type="date" value={f.dateOfBirth} onChange={(e) => setF({ ...f, dateOfBirth: e.target.value })} />
              <Select label="Prefers to speak" value={f.preferredLanguage} onChange={(e) => setF({ ...f, preferredLanguage: e.target.value })}>
                {Object.entries(LANGUAGES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
              <Select label="Home branch" value={f.homeBranchId} onChange={(e) => setF({ ...f, homeBranchId: e.target.value })}>
                <option value="">Any branch</option>
                {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
              <Field label="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
            </div>
            <Button variant="primary" type="submit" className="self-end" loading={save.isPending}>Save</Button>
          </form>
        </Card>
      ) : (
        <Card className="grid grid-cols-2 gap-x-8 gap-y-2 p-5 text-sm md:grid-cols-4">
          <div><div className="text-ink-2">Date of birth</div>{p.dateOfBirth ?? '—'}</div>
          <div><div className="text-ink-2">Language</div>{LANGUAGES[p.preferredLanguage as keyof typeof LANGUAGES] ?? p.preferredLanguage}</div>
          <div><div className="text-ink-2">Home branch</div>{p.homeBranchId ? branches.data?.find((b) => b.id === p.homeBranchId)?.name : 'Any'}</div>
          <div><div className="text-ink-2">City</div>{p.city ?? '—'}</div>
        </Card>
      )}
      {[['Upcoming', upcoming], ['History', past]].map(([label, items]) => (
        <Card key={label as string} className="p-5">
          <h3 className="font-display text-base font-bold">{label as string}</h3>
          {(items as AppointmentView[]).length ? (
            <ul className="mt-3 flex flex-col divide-y divide-line-2">
              {(items as AppointmentView[]).map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => setOpen(a)} className="flex w-full flex-wrap items-center gap-3 py-2.5 text-left text-sm hover:bg-teal-tint/30">
                    <span className="w-44 font-semibold">{fmtDay(a.start, zone)}, {fmtTime(a.start, zone)}</span>
                    <span className="flex-1">{a.serviceName} with {a.doctorName} · {MODE_LABEL[a.mode]} · {rupees(a.feePaise)}</span>
                    <StatusPill status={a.status} />
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-sm text-ink-2">None.</p>}
        </Card>
      ))}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <TimelineCard profileId={p.id} />
        <div className="flex flex-col gap-5">
          <PatientLeadsAndTasks profileId={p.id} />
          <ConsentCard profileId={p.id} />
        </div>
      </div>
      {booking ? <BookingDrawer date={todayIn(zone)} patient={p} onClose={() => setBooking(false)} /> : null}
      {open ? <AppointmentDrawer appointment={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

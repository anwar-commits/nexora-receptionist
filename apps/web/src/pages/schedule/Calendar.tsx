import { DateTime } from 'luxon';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, Card, Empty, Notice, Pill } from '../../components/ui';
import { errorText, useClinic, useClinicData } from '../../lib/clinic';
import { DAYS, MODE_LABEL } from '../../lib/format';
import { LIVE, fmtDay, fmtDayLong, fmtTime, minuteOfDay, todayIn, useAppointments, useAttention, useZone, type AppointmentView } from '../../lib/schedule';
import { AppointmentDrawer, BookingDrawer } from './Booking';

const PX_PER_MIN = 1.4;
const BLOCK: Record<string, string> = {
  booked: 'border-teal bg-teal-tint text-[#0B5E57]', confirmed: 'border-teal bg-teal-tint text-[#0B5E57]',
  checked_in: 'border-ai bg-ai-tint text-ai-ink', in_consultation: 'border-ai bg-ai-tint text-ai-ink',
  completed: 'border-[#2E8B57] bg-ok-tint text-[#1E6B41]', no_show: 'border-[#C97A06] bg-warn-tint text-warn-ink',
  cancelled: 'border-line bg-surface text-ink-2 line-through', rescheduled: 'border-line bg-surface text-ink-2 line-through',
};

export function CalendarPage() {
  const zone = useZone();
  const { can } = useClinic();
  const { doctors, branches } = useClinicData();
  const [params, setParams] = useSearchParams();
  const date = params.get('date') ?? todayIn(zone);
  const branchFilter = params.get('branch') ?? '';
  const [showCancelled, setShowCancelled] = useState(false);
  const [booking, setBooking] = useState<{ doctorId?: string } | null>(null);
  const [open, setOpen] = useState<AppointmentView | null>(null);
  const appts = useAppointments(date);
  const attention = useAttention();

  const go = (d: string) => setParams((p) => { p.set('date', d); return p; });
  const weekday = DateTime.fromISO(date, { zone }).weekday - 1;

  const columns = useMemo(() => (doctors.data ?? []).filter((d) => d.isActive).map((d) => {
    const sessions = d.weeklyHours.filter((r) => r.weekday === weekday && (!branchFilter || r.branchId === branchFilter || r.mode !== 'clinic'));
    const items = (appts.data ?? []).filter((a) => a.doctorId === d.id && (showCancelled || LIVE.has(a.status) || a.status === 'completed' || a.status === 'no_show') && (!branchFilter || a.branchId === branchFilter || a.mode !== 'clinic'));
    return { doctor: d, sessions, items };
  }).filter((c) => !branchFilter || c.sessions.length || c.items.length), [doctors.data, appts.data, weekday, branchFilter, showCancelled]);

  // Visible hours: from the earliest session/appointment to the latest, at least 09:00–18:00.
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let startMin = 9 * 60;
  let endMin = 18 * 60;
  for (const c of columns) {
    for (const s of c.sessions) { startMin = Math.min(startMin, toMin(s.start)); endMin = Math.max(endMin, toMin(s.end)); }
    for (const a of c.items) { startMin = Math.min(startMin, minuteOfDay(a.start, zone)); endMin = Math.max(endMin, minuteOfDay(a.end, zone) || 24 * 60); }
  }
  startMin = Math.floor(startMin / 60) * 60;
  endMin = Math.min(24 * 60, Math.ceil(endMin / 60) * 60);
  const hours = Array.from({ length: (endMin - startMin) / 60 }, (_, i) => startMin / 60 + i);
  const nowMin = date === todayIn(zone) ? minuteOfDay(new Date().toISOString(), zone) : null;
  const live = (appts.data ?? []).filter((a) => LIVE.has(a.status));
  const counts = { total: live.length, waiting: live.filter((a) => a.status === 'checked_in').length, done: (appts.data ?? []).filter((a) => a.status === 'completed').length };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-[26px] font-bold">Calendar</h1>
        <div className="ml-4 flex items-center gap-1.5">
          <Button className="h-9 px-3" onClick={() => go(DateTime.fromISO(date).minus({ days: 1 }).toISODate()!)} aria-label="Previous day">‹</Button>
          <Button className="h-9" onClick={() => go(todayIn(zone))}>Today</Button>
          <Button className="h-9 px-3" onClick={() => go(DateTime.fromISO(date).plus({ days: 1 }).toISODate()!)} aria-label="Next day">›</Button>
          <input type="date" aria-label="Go to date" value={date} onChange={(e) => e.target.value && go(e.target.value)} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm" />
        </div>
        <div className="text-[15px] font-semibold">{fmtDayLong(date, zone)}</div>
        <div className="ml-auto flex items-center gap-3">
          {(branches.data?.length ?? 0) > 1 ? (
            <select aria-label="Branch" value={branchFilter} onChange={(e) => setParams((p) => { if (e.target.value) p.set('branch', e.target.value); else p.delete('branch'); return p; })} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm">
              <option value="">All branches</option>
              {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          ) : null}
          <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" className="accent-teal" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />Show cancelled</label>
          {can('appointment:manage') ? <Button variant="primary" onClick={() => setBooking({})}>+ Book appointment</Button> : null}
        </div>
      </div>

      {attention.data?.length ? (
        <Notice>
          <b>{attention.data.length} upcoming appointment{attention.data.length > 1 ? 's' : ''} clash with leave or a holiday:</b>{' '}
          {attention.data.slice(0, 4).map((a, i) => (
            <span key={a.id}>{i ? ', ' : ''}<button type="button" className="font-semibold underline" onClick={() => setOpen(a)}>{a.patient.fullName} ({fmtDay(a.start, zone)} {fmtTime(a.start, zone)}, {a.doctorName})</button></span>
          ))}
          {attention.data.length > 4 ? ` and ${attention.data.length - 4} more` : ''}. Open each one to move it.
        </Notice>
      ) : null}

      <div className="flex gap-3 text-sm text-ink-2">
        <span><b className="text-ink">{counts.total}</b> still to come</span>
        <span><b className="text-ink">{counts.waiting}</b> waiting</span>
        <span><b className="text-ink">{counts.done}</b> completed</span>
      </div>

      {appts.error ? <Notice>{errorText(appts.error)}</Notice> : null}
      {columns.length === 0 ? <Empty>No doctors work {branchFilter ? 'at this branch ' : ''}on {DAYS[weekday]!.long}s.</Empty> : (
        <Card className="overflow-x-auto">
          <div className="flex min-w-full">
            <div className="sticky left-0 z-10 w-16 shrink-0 border-r border-line bg-surface">
              <div className="h-14 border-b border-line" />
              <div className="relative" style={{ height: (endMin - startMin) * PX_PER_MIN }}>
                {hours.map((h) => (
                  <div key={h} className="absolute right-2 -translate-y-1/2 text-[11px] text-ink-2" style={{ top: (h * 60 - startMin) * PX_PER_MIN }}>
                    {h === 0 ? '' : DateTime.fromObject({ hour: h }).toFormat('h a')}
                  </div>
                ))}
              </div>
            </div>
            {columns.map(({ doctor, sessions, items }) => (
              <div key={doctor.id} className="min-w-[220px] max-w-[420px] flex-1 border-r border-line-2 last:border-r-0">
                <div className="flex h-14 flex-col justify-center border-b border-line px-3">
                  <b className="truncate text-sm">{doctor.displayName}</b>
                  <span className="truncate text-xs text-ink-2">{sessions.length ? sessions.map((s) => `${MODE_LABEL[s.mode]} ${s.start}–${s.end}`).join(' · ') : 'Off today'}</span>
                </div>
                <div className="relative bg-[#F3F0E9]" style={{ height: (endMin - startMin) * PX_PER_MIN }}>
                  {hours.map((h) => <div key={h} className="absolute inset-x-0 border-t border-line-2" style={{ top: (h * 60 - startMin) * PX_PER_MIN }} />)}
                  {sessions.map((s, i) => (
                    <button key={i} type="button" disabled={!can('appointment:manage')} onClick={() => setBooking({ doctorId: doctor.id })}
                      title={`${MODE_LABEL[s.mode]} session${s.branchId ? ` at ${branches.data?.find((b) => b.id === s.branchId)?.name ?? ''}` : ''} — click to book`}
                      className={`absolute inset-x-0 ${s.mode === 'clinic' ? 'bg-surface' : 'bg-[#F4F2FE]'} hover:bg-teal-tint/40`}
                      style={{ top: (toMin(s.start) - startMin) * PX_PER_MIN, height: (toMin(s.end) - toMin(s.start)) * PX_PER_MIN }} />
                  ))}
                  {items.map((a) => {
                    const top = (minuteOfDay(a.start, zone) - startMin) * PX_PER_MIN;
                    const height = Math.max(22, (new Date(a.end).getTime() - new Date(a.start).getTime()) / 60_000 * PX_PER_MIN - 2);
                    return (
                      <button key={a.id} type="button" onClick={() => setOpen(a)} style={{ top: top + 1, height }}
                        className={`absolute inset-x-1.5 z-[1] overflow-hidden rounded-md border-l-[3px] px-2 py-0.5 text-left text-xs shadow-sm ${BLOCK[a.status]}`}>
                        <b className="block truncate">{fmtTime(a.start, zone)} {a.patient.fullName}</b>
                        {height > 30 ? <span className="block truncate">{a.mode !== 'clinic' ? `${MODE_LABEL[a.mode]} · ` : ''}{a.serviceName}</span> : null}
                      </button>
                    );
                  })}
                  {nowMin !== null && nowMin >= startMin && nowMin <= endMin ? <div className="absolute inset-x-0 z-[2] border-t-2 border-critical" style={{ top: (nowMin - startMin) * PX_PER_MIN }} aria-hidden /> : null}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="flex flex-wrap gap-2 text-xs text-ink-2">
        <Pill tone="teal">Booked</Pill><Pill tone="ai">Checked in / with doctor</Pill><Pill tone="ok">Completed</Pill><Pill tone="warn">No-show</Pill>
        <span className="ml-2">White = clinic hours, lilac = video/phone hours. Click a session to book.</span>
      </div>

      {booking ? <BookingDrawer date={date} doctorId={booking.doctorId} onClose={() => setBooking(null)} onBooked={(a) => go(DateTime.fromISO(a.start).setZone(zone).toISODate()!)} /> : null}
      {open ? <AppointmentDrawer appointment={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

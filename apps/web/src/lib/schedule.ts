import type { AppointmentStatus, AppointmentView, ConsultMode, SlotView } from '@dr/contracts';
import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { api } from './api';
import { useClinic } from './clinic';

export type { AppointmentView, SlotView };

export interface PatientView {
  id: string; mrn: string; fullName: string; phone: string; dateOfBirth: string | null; sex: string | null;
  preferredLanguage: string; homeBranchId: string | null; city: string | null; nextAppointmentAt: string | null;
}
export interface PatientDetail extends PatientView { appointments: AppointmentView[] }
export interface DaySlotsView { date: string; slots: SlotView[] }

/** The clinic's time zone; every date and time on screen is shown in it, whatever the device's zone. */
export function useZone() {
  const { current } = useClinic();
  return current.data?.timezone ?? 'Asia/Kolkata';
}

export const todayIn = (zone: string) => DateTime.now().setZone(zone).toISODate()!;
export const dayRange = (date: string, zone: string) => {
  const d = DateTime.fromISO(date, { zone });
  return { from: d.startOf('day').toUTC().toISO()!, to: d.plus({ days: 1 }).startOf('day').toUTC().toISO()! };
};
export const fmtTime = (iso: string, zone: string) => DateTime.fromISO(iso).setZone(zone).toFormat('h:mm a');
export const fmtDay = (iso: string, zone: string) => DateTime.fromISO(iso).setZone(zone).toFormat('ccc d LLL');
export const fmtDayLong = (date: string, zone: string) => DateTime.fromISO(date, { zone }).toFormat('cccc, d LLLL yyyy');
/** Minutes after midnight in the clinic's zone. */
export const minuteOfDay = (iso: string, zone: string) => {
  const d = DateTime.fromISO(iso).setZone(zone);
  return d.hour * 60 + d.minute;
};

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  booked: 'Booked', confirmed: 'Confirmed', checked_in: 'Checked in', in_consultation: 'With doctor', completed: 'Completed',
  cancelled: 'Cancelled', no_show: 'No-show', rescheduled: 'Moved',
};
export const STATUS_TONE: Record<AppointmentStatus, 'teal' | 'ok' | 'warn' | 'ai' | 'n'> = {
  booked: 'teal', confirmed: 'teal', checked_in: 'ai', in_consultation: 'ai', completed: 'ok', cancelled: 'n', no_show: 'warn', rescheduled: 'n',
};
export const LIVE = new Set<AppointmentStatus>(['booked', 'confirmed', 'checked_in', 'in_consultation']);
export const MODE_ICON: Record<ConsultMode, string> = { clinic: '🏥', video: '🎥', phone: '📞' };

export function useAppointments(date: string) {
  const { orgId, can } = useClinic();
  const zone = useZone();
  const { from, to } = dayRange(date, zone);
  return useQuery({
    queryKey: ['appointments', orgId, date],
    queryFn: () => api<{ items: AppointmentView[] }>(`/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then((r) => r.items),
    enabled: !!orgId && can('appointment:read'),
    refetchInterval: 30_000,
  });
}

export function useAttention() {
  const { orgId, can } = useClinic();
  return useQuery({
    queryKey: ['appointments', orgId, 'attention'],
    queryFn: () => api<{ items: AppointmentView[] }>('/appointments/attention').then((r) => r.items),
    enabled: !!orgId && can('appointment:read'),
  });
}

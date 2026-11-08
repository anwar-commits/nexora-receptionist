import { useQuery } from '@tanstack/react-query';
import { Button, Card, Empty, Notice, Pill } from '../../components/ui';
import { api } from '../../lib/api';
import { errorText, useClinic, useSave } from '../../lib/clinic';
import type { QueueItem } from '../../lib/crm';
import { money } from '../../lib/format';
import { useDues } from '../../lib/reception';
import { fmtTime, useZone } from '../../lib/schedule';

const STATUS = { waiting: ['Waiting', 'teal'], called: ['Called', 'ai'], in_room: ['With doctor', 'ai'], done: ['Done', 'ok'], left: ['Left', 'n'] } as const;

/** Today's waiting room for one branch: tokens per doctor, in order. */
export function WaitingRoom({ branchId }: { branchId?: string }) {
  const { orgId, can } = useClinic();
  const zone = useZone();
  const queue = useQuery({
    queryKey: ['queue', orgId, branchId ?? ''],
    queryFn: () => api<{ branchId: string; items: QueueItem[] }>(`/queue${branchId ? `?branchId=${branchId}` : ''}`),
    refetchInterval: 20_000,
  });
  const keys = ['queue', 'appointments'];
  const call = useSave((id: string) => api(`/queue/${id}/call`, { method: 'POST' }), keys);
  const left = useSave((id: string) => api(`/queue/${id}/left`, { method: 'POST' }), keys);
  const sendIn = useSave((i: QueueItem) => (i.appointmentId
    ? api(`/appointments/${i.appointmentId}/status`, { method: 'POST', body: { status: 'in_consultation' } })
    : api(`/queue/${i.id}/in-room`, { method: 'POST' })), keys);
  const finish = useSave((i: QueueItem) => api(`/queue/${i.id}/done`, { method: 'POST' }), keys);
  const dues = useDues(branchId);
  const dueFor = (i: QueueItem) => dues.data?.items.find((d) => (i.appointmentId ? d.id === i.appointmentId : d.id === i.id));
  const reorder = useSave((v: { doctorId: string; tokenIds: string[] }) => api('/queue/reorder', { method: 'POST', body: v }), keys);
  const err = call.error ?? left.error ?? sendIn.error ?? finish.error ?? reorder.error ?? queue.error;
  const manage = can('appointment:manage');
  const items = queue.data?.items ?? [];
  const doctors = [...new Map(items.map((i) => [i.doctorId, i.doctorName])).entries()];

  const move = (doctorId: string, id: string, dir: -1 | 1) => {
    const waiting = items.filter((i) => i.doctorId === doctorId && (i.status === 'waiting' || i.status === 'called'));
    const idx = waiting.findIndex((i) => i.id === id);
    const j = idx + dir;
    if (j < 0 || j >= waiting.length) return;
    const ids = waiting.map((i) => i.id);
    [ids[idx], ids[j]] = [ids[j]!, ids[idx]!];
    reorder.mutate({ doctorId, tokenIds: ids });
  };

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-lg font-bold">Waiting room</h2>
        <span className="text-sm text-ink-2">{items.filter((i) => i.status === 'waiting' || i.status === 'called').length} waiting</span>
      </div>
      <p className="mt-0.5 text-[13px] text-ink-2">Checking a patient in gives them a token. Tokens follow the visit: with doctor, then done.</p>
      {err ? <div className="mt-3"><Notice>{errorText(err)}</Notice></div> : null}
      {items.length === 0 ? <div className="mt-3"><Empty>No one has checked in yet today.</Empty></div> : (
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
          {doctors.map(([doctorId, name]) => {
            const list = items.filter((i) => i.doctorId === doctorId);
            const waiting = list.filter((i) => i.status === 'waiting' || i.status === 'called');
            return (
              <div key={doctorId} className="rounded-xl border border-line">
                <div className="border-b border-line px-3 py-2 text-sm font-semibold">{name}</div>
                <ul className="divide-y divide-line-2">
                  {list.map((i) => {
                    const [label, tone] = STATUS[i.status];
                    const wi = waiting.findIndex((w) => w.id === i.id);
                    return (
                      <li key={i.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 text-sm ${['done', 'left'].includes(i.status) ? 'opacity-60' : ''}`}>
                        <span className="rounded-md bg-navy px-1.5 py-0.5 font-mono text-xs font-bold text-white">{i.token}</span>
                        <span className="min-w-0 flex-1 truncate"><b>{i.patient.fullName}</b>{i.appointmentStart ? <span className="text-ink-2"> · {fmtTime(i.appointmentStart, zone)}</span> : null}</span>
                        <span className="flex w-full flex-wrap gap-1.5 pl-9">
                          <Pill tone={tone}>{label}{i.waitingMinutes !== null ? ` · ${i.waitingMinutes} min` : ''}</Pill>
                          {i.isWalkIn ? <Pill>Walk-in</Pill> : null}
                          {dueFor(i) ? (dueFor(i)!.duePaise > 0 ? <Pill tone="warn">{money(dueFor(i)!.duePaise)} due</Pill> : <Pill tone="ok">Paid</Pill>) : null}
                        </span>
                        {manage && wi >= 0 ? (
                          <span className="flex w-full items-center gap-1.5 pl-9">
                            {i.status === 'waiting' ? <Button className="h-8 px-2.5 text-xs" onClick={() => call.mutate(i.id)}>Call</Button> : null}
                            <Button variant="primary" className="h-8 px-2.5 text-xs" onClick={() => sendIn.mutate(i)}>Send in</Button>
                            <button type="button" aria-label={`Move ${i.patient.fullName} up`} disabled={wi === 0} onClick={() => move(doctorId, i.id, -1)} className="grid size-8 place-items-center rounded-lg border border-line disabled:opacity-30">↑</button>
                            <button type="button" aria-label={`Move ${i.patient.fullName} down`} disabled={wi === waiting.length - 1} onClick={() => move(doctorId, i.id, 1)} className="grid size-8 place-items-center rounded-lg border border-line disabled:opacity-30">↓</button>
                            <button type="button" onClick={() => left.mutate(i.id)} className="ml-auto text-xs font-semibold text-ink-2 hover:text-ink">Left</button>
                          </span>
                        ) : manage && i.isWalkIn && i.status === 'in_room' ? (
                          <span className="flex w-full pl-9"><Button className="h-8 px-2.5 text-xs" onClick={() => finish.mutate(i)}>Done</Button></span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

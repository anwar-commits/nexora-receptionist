import { STAFF_CONSENT_PURPOSES } from '@dr/contracts';
import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, Card, Notice, Pill } from '../../components/ui';
import { api } from '../../lib/api';
import { errorText, useClinic, useSave } from '../../lib/clinic';
import { CONSENT_LABEL, STAGE_LABEL, useTasks, type Consent, type TimelineItem } from '../../lib/crm';
import { useZone } from '../../lib/schedule';
import { AddTaskForm, TaskList } from './Tasks';

/** Consent ledger for one patient: current state per purpose, record a change, see the history. */
export function ConsentCard({ profileId }: { profileId: string }) {
  const { orgId, can } = useClinic();
  const zone = useZone();
  const data = useQuery({ queryKey: ['consents', orgId, profileId], queryFn: () => api<{ current: Record<string, Consent>; history: Consent[] }>(`/patients/${profileId}/consents`) });
  const record = useSave((v: { purpose: string; state: 'given' | 'withdrawn' }) => api(`/patients/${profileId}/consents`, { method: 'POST', body: v }), ['consents', 'timeline']);
  const [history, setHistory] = useState(false);
  const manage = can('patient:manage');
  return (
    <Card className="p-5">
      <h3 className="font-display text-base font-bold">Consents</h3>
      <p className="mt-0.5 text-[13px] text-ink-2">Record what the patient agreed to, in the clinic. Every change is kept; nothing is overwritten.</p>
      {record.error ? <div className="mt-3"><Notice>{errorText(record.error)}</Notice></div> : null}
      <ul className="mt-3 flex flex-col divide-y divide-line-2">
        {STAFF_CONSENT_PURPOSES.map((p) => {
          const c = data.data?.current[p];
          return (
            <li key={p} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
              <span className="flex-1 font-semibold">{CONSENT_LABEL[p]}</span>
              {c ? <Pill tone={c.state === 'given' ? 'ok' : 'n'}>{c.state === 'given' ? 'Given' : 'Withdrawn'} · {DateTime.fromISO(c.recordedAt).setZone(zone).toFormat('d LLL yyyy')}</Pill> : <Pill>Not recorded</Pill>}
              {manage ? (
                c?.state === 'given'
                  ? <button type="button" className="text-[13px] font-semibold text-ink-2 hover:text-ink" onClick={() => record.mutate({ purpose: p, state: 'withdrawn' })}>Record withdrawal</button>
                  : <button type="button" className="text-[13px] font-semibold text-teal" onClick={() => record.mutate({ purpose: p, state: 'given' })}>Record consent</button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {data.data?.history.length ? (
        <button type="button" className="mt-2 text-[13px] font-semibold text-teal" onClick={() => setHistory(!history)}>{history ? 'Hide' : 'Show'} consent history ({data.data.history.length})</button>
      ) : null}
      {history ? (
        <ul className="mt-2 flex flex-col gap-1 text-xs text-ink-2">
          {data.data?.history.map((h) => <li key={h.id}>{DateTime.fromISO(h.recordedAt).setZone(zone).toFormat('d LLL yyyy, h:mm a')} · {CONSENT_LABEL[h.purpose]} {h.state} · {h.capturedVia.replace('_', ' ')}{h.recordedBy ? ` · ${h.recordedBy}` : ''}</li>)}
        </ul>
      ) : null}
    </Card>
  );
}

export function TimelineCard({ profileId }: { profileId: string }) {
  const { orgId } = useClinic();
  const zone = useZone();
  const data = useQuery({ queryKey: ['timeline', orgId, profileId], queryFn: () => api<{ items: TimelineItem[] }>(`/patients/${profileId}/timeline`).then((r) => r.items) });
  const DOT = { appointment: 'bg-teal', lead: 'bg-ai', consent: 'bg-[#2E8B57]' } as const;
  return (
    <Card className="p-5">
      <h3 className="font-display text-base font-bold">Timeline</h3>
      {data.error ? <Notice>{errorText(data.error)}</Notice> : null}
      {data.data?.length === 0 ? <p className="mt-2 text-sm text-ink-2">Nothing yet.</p> : (
        <ol className="mt-3 flex flex-col">
          {data.data?.map((i, n) => (
            <li key={n} className="relative flex gap-3 pb-4 last:pb-0">
              <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${DOT[i.kind]}`} aria-hidden />
              <div className="text-sm">
                <div className="font-semibold">{i.title}</div>
                {i.detail ? <div className="text-ink-2">{i.detail}</div> : null}
                <div className="text-xs text-ink-2">{DateTime.fromISO(i.at).setZone(zone).toFormat('ccc d LLL, h:mm a')}{i.actor ? ` · ${i.actor === 'system' ? 'automatic' : i.actor}` : ''}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export function PatientLeadsAndTasks({ profileId }: { profileId: string }) {
  const { can, orgId } = useClinic();
  const tasks = useTasks({ relatedType: 'patient', relatedId: profileId });
  const leads = useQuery({
    queryKey: ['leads', orgId, `patient=${profileId}`],
    queryFn: () => api<{ items: { id: string; stage: keyof typeof STAGE_LABEL; interest: string | null; score: number }[] }>(`/leads?patientProfileId=${profileId}&includeClosed=1`).then((r) => r.items),
    enabled: can('lead:read'),
  });
  const [adding, setAdding] = useState(false);
  return (
    <Card className="p-5">
      <div className="flex items-center">
        <h3 className="font-display text-base font-bold">Pipeline and tasks</h3>
        <Button className="ml-auto h-9" onClick={() => setAdding(!adding)}>{adding ? 'Close' : '+ Task'}</Button>
      </div>
      {leads.data?.length ? (
        <ul className="mt-3 flex flex-col gap-1.5 text-sm">
          {leads.data.map((l) => <li key={l.id}><Link to={`/pipeline?lead=${l.id}`} className="font-semibold text-teal">{STAGE_LABEL[l.stage]}</Link>{l.interest ? ` · ${l.interest}` : ''} · score {l.score}</li>)}
        </ul>
      ) : can('lead:read') ? <p className="mt-2 text-sm text-ink-2">Not on the pipeline.</p> : null}
      {adding ? <div className="mt-3"><AddTaskForm related={{ type: 'patient', id: profileId }} onDone={() => setAdding(false)} /></div> : null}
      <div className="mt-3"><TaskList tasks={tasks.data} empty="No open tasks." /></div>
    </Card>
  );
}

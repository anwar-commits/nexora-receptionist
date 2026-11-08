import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button, Empty, Field, Notice, Pill, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { errorText, useClinic, useSave, type Member, type RoleInfo } from '../../lib/clinic';
import { useTasks, type Task } from '../../lib/crm';
import { useZone } from '../../lib/schedule';

const PRIORITY_TONE = { low: 'n', normal: 'n', high: 'warn', urgent: 'warn' } as const;

export function TaskList({ tasks, empty = 'Nothing to do.' }: { tasks: Task[] | undefined; empty?: string }) {
  const zone = useZone();
  const close = useSave(({ id, status }: { id: string; status: 'done' | 'cancelled' }) => api(`/tasks/${id}`, { method: 'PATCH', body: { status } }), ['tasks', 'lead', 'leads']);
  if (!tasks) return <p className="text-sm text-ink-2">Loading…</p>;
  if (tasks.length === 0) return <p className="text-sm text-ink-2">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line-2">
      {close.error ? <Notice>{errorText(close.error)}</Notice> : null}
      {tasks.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
          <input type="checkbox" aria-label={`Mark "${t.title}" done`} className="size-4 accent-teal" disabled={close.isPending}
            checked={t.status === 'done'} onChange={() => close.mutate({ id: t.id, status: 'done' })} />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{t.title}</div>
            <div className="text-xs text-ink-2">
              {t.assignee.name ? `For ${t.assignee.name}` : null}
              {t.related ? <> · {t.related.type === 'lead' ? <Link className="text-teal" to={`/pipeline?lead=${t.related.id}`}>{t.related.label ?? 'Lead'}</Link> : t.related.type === 'patient' ? <Link className="text-teal" to={`/patients/${t.related.id}`}>{t.related.label ?? 'Patient'}</Link> : t.related.label}</> : null}
              {t.dueAt ? ` · due ${DateTime.fromISO(t.dueAt).setZone(zone).toFormat('ccc d LLL, h:mm a')}` : ''}
            </div>
          </div>
          {t.overdue ? <Pill tone="warn">Overdue</Pill> : null}
          {t.priority !== 'normal' ? <Pill tone={PRIORITY_TONE[t.priority]}>{t.priority}</Pill> : null}
          <button type="button" onClick={() => close.mutate({ id: t.id, status: 'cancelled' })} className="text-xs font-semibold text-ink-2 hover:text-ink">Cancel</button>
        </li>
      ))}
    </ul>
  );
}

export function AddTaskForm({ related, onDone }: { related?: { type: 'lead' | 'patient' | 'appointment'; id: string }; onDone?: () => void }) {
  const { orgId, can } = useClinic();
  const zone = useZone();
  const members = useQuery({ queryKey: ['members', orgId], queryFn: () => api<{ items: Member[] }>('/members').then((r) => r.items), enabled: can('member:read') });
  const roles = useQuery({ queryKey: ['roles', orgId], queryFn: () => api<{ items: RoleInfo[] }>('/roles').then((r) => r.items), enabled: can('role:read') });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ user: { id: string } }>('/me', { org: false }) });
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('me');
  const [due, setDue] = useState(DateTime.now().setZone(zone).plus({ days: 1 }).set({ hour: 10, minute: 0 }).toFormat("yyyy-LL-dd'T'HH:mm"));
  const [priority, setPriority] = useState('normal');
  const save = useSave(() => {
    const [kind, ref] = assignee === 'me' ? ['user', me.data!.user.id] : assignee.split(':');
    return api('/tasks', {
      method: 'POST',
      body: {
        kind: 'follow_up', title, priority, dueAt: due ? DateTime.fromISO(due, { zone }).toISO() : null,
        ...(kind === 'user' ? { assigneeUserId: ref } : { assigneeRole: ref }),
        ...(related ? { relatedType: related.type, relatedId: related.id } : {}),
      },
    });
  }, ['tasks', 'lead']);
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(undefined, { onSuccess: () => { setTitle(''); onDone?.(); } }); };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {save.error ? <Notice>{errorText(save.error)}</Notice> : null}
      <Field label="Task" placeholder="e.g. Call back with transplant package details" value={title} onChange={(e) => setTitle(e.target.value)} />
      <div className="grid grid-cols-3 gap-3">
        <Select label="For" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="me">Me</option>
          {members.data?.filter((m) => m.status === 'active' && m.userId !== me.data?.user.id).map((m) => <option key={m.userId} value={`user:${m.userId}`}>{m.fullName}</option>)}
          {roles.data?.filter((r) => r.key !== 'owner').map((r) => <option key={r.key} value={`role:${r.key}`}>Any {r.name.toLowerCase()}</option>)}
        </Select>
        <Field label="Due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        <Select label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
        </Select>
      </div>
      <Button type="submit" className="self-end" loading={save.isPending} disabled={title.trim().length < 3 || !me.data}>Add task</Button>
    </form>
  );
}

/** Home card: the signed-in member's open tasks. */
export function MyTasks() {
  const tasks = useTasks({ mine: true });
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center">
        <h2 className="font-display text-lg font-bold">Your tasks</h2>
        <Button className="ml-auto h-9" onClick={() => setAdding(!adding)}>{adding ? 'Close' : '+ Task'}</Button>
      </div>
      {adding ? <AddTaskForm onDone={() => setAdding(false)} /> : null}
      {tasks.data?.length === 0 && !adding ? <Empty>No open tasks for you or your role.</Empty> : <TaskList tasks={tasks.data} />}
    </div>
  );
}

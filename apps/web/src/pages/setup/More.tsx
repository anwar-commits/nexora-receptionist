import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, ChoiceCards, Empty, Field, Notice, Pill, Select, Toggle } from '../../components/ui';
import { api } from '../../lib/api';
import { errorText, useClinic, useClinicData, useSave, type Holiday, type Member, type RoleInfo, type Settings } from '../../lib/clinic';
import { parseRupees } from '../../lib/format';

/** Saves a partial settings change and reports the result inline. */
function useSettingsForm<T extends Partial<Settings>>(initial: (s: Settings) => T) {
  const { settings } = useClinicData();
  const [form, setForm] = useState<T | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (settings.data) setForm(initial(settings.data)); }, [settings.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useSave((body: Partial<Settings>) => api<Settings>('/settings', { method: 'PATCH', body }), ['settings']);
  const dirty = !!form && !!settings.data && JSON.stringify(form) !== JSON.stringify(initial(settings.data));
  return { form, setForm, save, saved, setSaved, dirty };
}

/** Step 5 / Settings › AI phone line. */
export function PhoneAndAi({ onDone, submitLabel = 'Save' }: { onDone?: () => void; submitLabel?: string }) {
  const { can } = useClinic();
  const { form, setForm, save, saved, setSaved } = useSettingsForm((s) => ({ aiPickupMode: s.aiPickupMode, aiPickupAfterSeconds: s.aiPickupAfterSeconds, phoneSetupChoice: s.phoneSetupChoice }));
  const editable = can('org:update');
  if (!form) return <p className="text-ink-2">Loading…</p>;
  return (
    <div className="flex flex-col gap-5">
      <Notice kind="ai">
        Phone numbers and call forwarding connect in the telephony release. Choose your plan now; nothing is changed on your phone line yet, and the AI receptionist does not answer calls until the line is connected and tested with you.
      </Notice>
      {save.error ? <Notice>{errorText(save.error)}</Notice> : saved && !onDone ? <Notice kind="ok">Saved.</Notice> : null}
      <fieldset disabled={!editable} className="flex flex-col gap-5">
        <Card className="p-5">
          <h3 className="mb-3 font-display text-base font-bold">How will patients reach the AI?</h3>
          <ChoiceCards name="Phone setup" value={form.phoneSetupChoice} onChange={(v) => setForm({ ...form, phoneSetupChoice: v })} options={[
            { value: 'forward_existing', title: 'Keep your current number', body: 'Calls your staff do not answer are forwarded to the AI. Patients notice nothing.', badge: 'Recommended' },
            { value: 'new_number', title: 'Get a new number for the AI', body: 'An Indian number (Exotel or Plivo) you can put on ads and Google.' },
            { value: 'later', title: 'Decide later', body: 'Finish setup now; we will ask again before going live.' },
          ]} />
        </Card>
        <Card className="p-5">
          <h3 className="mb-3 font-display text-base font-bold">When should the AI pick up?</h3>
          <ChoiceCards name="AI pickup" value={form.aiPickupMode} onChange={(v) => setForm({ ...form, aiPickupMode: v })} options={[
            { value: 'after_ring', title: 'When staff do not answer', body: `After ${form.aiPickupAfterSeconds} seconds of ringing.`, badge: 'Recommended' },
            { value: 'after_hours', title: 'Only outside opening hours', body: 'Staff take every call while the clinic is open.' },
            { value: 'always', title: 'Every call', body: 'The AI answers first and hands over to staff when needed.' },
          ]} />
          {form.aiPickupMode === 'after_ring' ? (
            <Field label="Seconds of ringing before the AI answers" inputMode="numeric" className="mt-4 w-48" value={String(form.aiPickupAfterSeconds)}
              onChange={(e) => setForm({ ...form, aiPickupAfterSeconds: Number(e.target.value.replace(/\D/g, '')) || 0 })} hint="Between 5 and 90" />
          ) : null}
        </Card>
      </fieldset>
      {editable ? (
        <Button variant="primary" className="self-end" loading={save.isPending} disabled={!form.phoneSetupChoice}
          onClick={() => { setSaved(false); save.mutate(form, { onSuccess: () => { setSaved(true); onDone?.(); } }); }}>{submitLabel}</Button>
      ) : null}
    </div>
  );
}

/** Settings › Calls and recording. */
export function CallsAndRecording() {
  const { can } = useClinic();
  const { form, setForm, save, saved, setSaved, dirty } = useSettingsForm((s) => ({
    recordingEnabled: s.recordingEnabled, transcriptEnabled: s.transcriptEnabled, recordingRetentionDays: s.recordingRetentionDays,
    transcriptRetentionDays: s.transcriptRetentionDays, outboundStartLocal: s.outboundStartLocal, outboundEndLocal: s.outboundEndLocal,
    refundLimitReceptionistPaise: s.refundLimitReceptionistPaise,
  }));
  const [refund, setRefund] = useState('');
  useEffect(() => { if (form) setRefund(String(form.refundLimitReceptionistPaise / 100)); }, [form?.refundLimitReceptionistPaise]); // eslint-disable-line react-hooks/exhaustive-deps
  const editable = can('org:update');
  if (!form) return <p className="text-ink-2">Loading…</p>;
  const refundPaise = parseRupees(refund);
  const refundBad = refundPaise === null || Number.isNaN(refundPaise);
  const num = (v: string) => Number(v.replace(/\D/g, '')) || 0;

  return (
    <div className="flex flex-col gap-5">
      {save.error ? <Notice>{errorText(save.error)}</Notice> : saved && !dirty ? <Notice kind="ok">Saved.</Notice> : null}
      <fieldset disabled={!editable} className="flex flex-col gap-5">
        <Card className="flex flex-col gap-4 p-5">
          <h3 className="font-display text-base font-bold">Recording</h3>
          <Toggle label="Record call audio" checked={form.recordingEnabled} onChange={(v) => setForm({ ...form, recordingEnabled: v })}
            description="When calls go live, callers hear a short recording notice before anything is recorded." />
          <Toggle label="Keep a written transcript" checked={form.transcriptEnabled} onChange={(v) => setForm({ ...form, transcriptEnabled: v })}
            description="Used for the call summary, follow-ups and quality review." />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Delete audio after (days)" inputMode="numeric" value={String(form.recordingRetentionDays)} onChange={(e) => setForm({ ...form, recordingRetentionDays: num(e.target.value) })} disabled={!form.recordingEnabled} hint="0 to 3650" />
            <Field label="Delete transcripts after (days)" inputMode="numeric" value={String(form.transcriptRetentionDays)} onChange={(e) => setForm({ ...form, transcriptRetentionDays: num(e.target.value) })} disabled={!form.transcriptEnabled} hint="30 to 3650" />
          </div>
          <p className="text-[13px] text-ink-2">Choose periods your legal adviser is comfortable with. Automatic deletion runs once call recording goes live.</p>
        </Card>
        <Card className="flex flex-col gap-4 p-5">
          <h3 className="font-display text-base font-bold">Follow-up calls and refunds</h3>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Call patients from" type="time" value={form.outboundStartLocal} onChange={(e) => setForm({ ...form, outboundStartLocal: e.target.value })} />
            <Field label="Until" type="time" value={form.outboundEndLocal} onChange={(e) => setForm({ ...form, outboundEndLocal: e.target.value })} />
          </div>
          <Field label="Largest refund a receptionist can approve (₹)" value={refund} onChange={(e) => setRefund(e.target.value)} className="w-64"
            error={refundBad ? 'Enter an amount like 5000' : undefined} hint="Applies when payments and refunds arrive. Larger refunds will need the owner or a branch manager." />
        </Card>
      </fieldset>
      {editable ? (
        <Button variant="primary" className="self-end" loading={save.isPending} disabled={refundBad}
          onClick={() => { setSaved(false); save.mutate({ ...form, refundLimitReceptionistPaise: refundPaise! }, { onSuccess: () => setSaved(true) }); }}>Save</Button>
      ) : null}
    </div>
  );
}

/** Settings › Holidays. */
export function Holidays() {
  const { can, orgId } = useClinic();
  const { branches } = useClinicData();
  const holidays = useQuery({ queryKey: ['holidays', orgId], queryFn: () => api<{ items: Holiday[] }>('/holidays').then((r) => r.items), enabled: !!orgId });
  const [onDate, setOnDate] = useState('');
  const [name, setName] = useState('');
  const [branchId, setBranchId] = useState('');
  const add = useSave(() => api('/holidays', { method: 'POST', body: { onDate, name, branchId: branchId || null } }), ['holidays']);
  const remove = useSave((id: string) => api(`/holidays/${id}`, { method: 'DELETE' }), ['holidays']);
  const editable = can('branch:manage');
  const branchName = (id: string | null) => (id ? branches.data?.find((b) => b.id === id)?.name ?? 'Branch' : 'All branches');

  return (
    <div className="flex flex-col gap-5">
      {add.error || remove.error ? <Notice>{errorText(add.error ?? remove.error)}</Notice> : null}
      <Card className="p-5">
        {holidays.data?.length ? (
          <ul className="flex flex-col divide-y divide-line-2">
            {holidays.data.map((h) => (
              <li key={h.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="w-32 font-mono">{new Date(`${h.onDate}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
                <b>{h.name}</b><Pill>{branchName(h.branchId)}</Pill>
                {editable ? <button type="button" onClick={() => remove.mutate(h.id)} className="ml-auto text-[13px] font-semibold text-teal">Remove</button> : null}
              </li>
            ))}
          </ul>
        ) : <Empty>No upcoming holidays. The AI tells callers the clinic is closed on these days and offers the next open day.</Empty>}
      </Card>
      {editable ? (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(undefined, { onSuccess: () => { setOnDate(''); setName(''); } }); }}>
          <Field label="Date" type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} />
          <Field label="Holiday" placeholder="Chhath Puja" value={name} onChange={(e) => setName(e.target.value)} />
          <Select label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">All branches</option>
            {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <Button type="submit" loading={add.isPending} disabled={!onDate || name.trim().length < 2}>Add holiday</Button>
        </form>
      ) : null}
    </div>
  );
}

/** Settings › Departments. */
export function Departments() {
  const { can } = useClinic();
  const { departments } = useClinicData();
  const [name, setName] = useState('');
  const add = useSave(() => api('/departments', { method: 'POST', body: { name } }), ['departments']);
  return (
    <div className="flex flex-col gap-5">
      {add.error ? <Notice>{errorText(add.error)}</Notice> : null}
      <Card className="p-5">
        {departments.data?.length ? (
          <ul className="flex flex-wrap gap-2">{departments.data.map((d) => <li key={d.id}><Pill tone="teal">{d.name}</Pill></li>)}</ul>
        ) : <Empty>No departments. They are optional: use them to group doctors and services, e.g. Hair, Skin.</Empty>}
      </Card>
      {can('org:update') ? (
        <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); add.mutate(undefined, { onSuccess: () => setName('') }); }}>
          <Field label="New department" placeholder="Skin" value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" loading={add.isPending} disabled={name.trim().length < 2}>Add</Button>
        </form>
      ) : null}
    </div>
  );
}

/** Settings › Staff: list and invite. */
export function Staff() {
  const { can, orgId } = useClinic();
  const { branches } = useClinicData();
  const members = useQuery({ queryKey: ['members', orgId], queryFn: () => api<{ items: Member[] }>('/members').then((r) => r.items), enabled: can('member:read') });
  const roles = useQuery({ queryKey: ['roles', orgId], queryFn: () => api<{ items: RoleInfo[] }>('/roles').then((r) => r.items), enabled: can('role:read') });
  const [form, setForm] = useState({ fullName: '', phone: '', email: '', roleId: '', branchIds: [] as string[] });
  const [done, setDone] = useState<string | null>(null);
  const invite = useSave(() => api('/members', {
    method: 'POST', body: { fullName: form.fullName, phone: form.phone || undefined, email: form.email || undefined, roleId: form.roleId, branchIds: form.branchIds },
  }), ['members']);
  const branchName = (id: string) => branches.data?.find((b) => b.id === id)?.name ?? '';
  if (!can('member:read')) return <Notice>Your role cannot see the staff list.</Notice>;

  return (
    <div className="flex flex-col gap-5">
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[#FBF9F4] text-left text-[11px] font-bold tracking-[.06em] text-ink-2"><tr><th className="px-4 py-2.5">NAME</th><th className="px-4">ROLE</th><th className="px-4">BRANCHES</th><th className="px-4">STATUS</th></tr></thead>
          <tbody>
            {members.data?.map((m) => (
              <tr key={m.id} className="border-t border-line-2">
                <td className="px-4 py-3"><b>{m.fullName}</b><div className="text-ink-2">{m.email ?? m.phone}</div></td>
                <td className="px-4">{m.roleName}</td>
                <td className="px-4">{m.branchIds.length ? m.branchIds.map(branchName).join(', ') : 'All'}</td>
                <td className="px-4"><Pill tone={m.status === 'active' ? 'ok' : m.status === 'invited' ? 'warn' : 'n'}>{m.status}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {can('member:manage') ? (
        <Card className="p-5">
          <h3 className="font-display text-base font-bold">Invite a staff member</h3>
          <p className="mt-0.5 text-[13px] text-ink-2">They sign in with the mobile number or email you enter here. Invitation messages are sent once SMS and WhatsApp are connected; until then, tell them yourself.</p>
          <form className="mt-4 flex flex-col gap-4" onSubmit={(e) => {
            e.preventDefault(); setDone(null);
            invite.mutate(undefined, { onSuccess: () => { setDone(`${form.fullName} can now sign in.`); setForm({ fullName: '', phone: '', email: '', roleId: form.roleId, branchIds: [] }); } });
          }}>
            {invite.error ? <Notice>{errorText(invite.error)}</Notice> : done ? <Notice kind="ok">{done}</Notice> : null}
            <div className="grid grid-cols-3 gap-4">
              <Field label="Full name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
              <Field label="Mobile number" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <Field label="Email (optional)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <Select label="Role" value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
              <option value="">Choose a role</option>
              {roles.data?.filter((r) => r.key !== 'owner').map((r) => <option key={r.id} value={r.id}>{r.name}{r.requiresMfa ? ' (needs authenticator app)' : ''}</option>)}
            </Select>
            <fieldset>
              <legend className="mb-2 text-[13px] font-semibold">Branches (none ticked = all branches)</legend>
              <div className="flex flex-wrap gap-4">
                {branches.data?.map((b) => (
                  <label key={b.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="accent-teal" checked={form.branchIds.includes(b.id)} onChange={(e) => setForm({ ...form, branchIds: e.target.checked ? [...form.branchIds, b.id] : form.branchIds.filter((x) => x !== b.id) })} />{b.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <Button variant="primary" type="submit" className="self-end" loading={invite.isPending} disabled={!form.roleId || form.fullName.trim().length < 2 || (!form.phone && !form.email)}>Invite</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

const SCOPE_LABEL: Record<string, string> = { org: 'whole clinic', branch: 'own branches', own: 'own records', limit: 'with a limit' };

/** Settings › Roles and permissions (built-in roles, read only for now). */
export function Roles() {
  const { can, orgId } = useClinic();
  const roles = useQuery({ queryKey: ['roles', orgId], queryFn: () => api<{ items: RoleInfo[] }>('/roles').then((r) => r.items), enabled: can('role:read') });
  if (!can('role:read')) return <Notice>Your role cannot see roles.</Notice>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {roles.data?.map((r) => (
        <Card key={r.id} className="p-5">
          <div className="flex items-center gap-2"><h3 className="font-display text-base font-bold">{r.name}</h3>{r.requiresMfa ? <Pill tone="teal">Authenticator app</Pill> : null}</div>
          <ul className="mt-3 flex flex-col gap-1 text-[13px]">
            {r.permissions.map((p) => <li key={p.key}><span className="font-mono">{p.key}</span> <span className="text-ink-2">· {SCOPE_LABEL[p.scope] ?? p.scope}</span></li>)}
          </ul>
        </Card>
      ))}
    </div>
  );
}

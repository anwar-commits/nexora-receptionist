import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Field, Notice, Pill, Toggle } from '../../components/ui';
import { api } from '../../lib/api';
import { errorText, useClinic, useClinicData, useSave, type Branch, type Hours } from '../../lib/clinic';
import { DAYS } from '../../lib/format';

const DEFAULT_PERIOD: [string, string] = ['10:00', '19:00'];

/** Weekly opening hours: each day closed or a list of [open, close] periods. */
export function OpeningHoursEditor({ value, onChange, disabled }: { value: Hours; onChange: (v: Hours) => void; disabled?: boolean }) {
  const set = (day: keyof Hours, periods: [string, string][] | undefined) => {
    const next = { ...value };
    if (periods && periods.length) next[day] = periods; else delete next[day];
    onChange(next);
  };
  const copyMonday = () => {
    const mon = value.mon;
    if (!mon) return;
    const next: Hours = { ...value };
    for (const d of ['tue', 'wed', 'thu', 'fri', 'sat'] as const) next[d] = mon.map((p) => [...p] as [string, string]);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      {DAYS.map((d) => {
        const periods = value[d.key];
        const open = !!periods?.length;
        return (
          <div key={d.key} className="flex flex-wrap items-center gap-3 border-b border-line-2 py-2 last:border-0">
            <div className="w-32"><Toggle label={d.long} checked={open} disabled={disabled} onChange={(on) => set(d.key, on ? [DEFAULT_PERIOD] : undefined)} /></div>
            {open ? (
              <div className="flex flex-wrap items-center gap-2">
                {periods!.map((p, i) => (
                  <span key={i} className="flex items-center gap-1.5">
                    <input type="time" aria-label={`${d.long} opens`} value={p[0]} disabled={disabled} onChange={(e) => set(d.key, periods!.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm" />
                    <span className="text-ink-2">–</span>
                    <input type="time" aria-label={`${d.long} closes`} value={p[1]} disabled={disabled} onChange={(e) => set(d.key, periods!.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm" />
                    {periods!.length > 1 ? <button type="button" disabled={disabled} onClick={() => set(d.key, periods!.filter((_, j) => j !== i))} className="px-1 text-ink-2 hover:text-ink" aria-label={`Remove ${d.long} period`}>✕</button> : null}
                  </span>
                ))}
                {periods!.length < 3 ? <button type="button" disabled={disabled} onClick={() => set(d.key, [...periods!, ['17:00', '20:00']])} className="text-[13px] font-semibold text-teal">+ Split shift</button> : null}
              </div>
            ) : <span className="text-sm text-ink-2">Closed</span>}
          </div>
        );
      })}
      {!disabled && value.mon ? <button type="button" onClick={copyMonday} className="self-start text-[13px] font-semibold text-teal">Copy Monday to Tuesday–Saturday</button> : null}
    </div>
  );
}

function BranchCard({ branch }: { branch: Branch }) {
  const { can } = useClinic();
  const editable = can('branch:manage');
  const [form, setForm] = useState(branch);
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(branch), [branch]);
  const dirty = JSON.stringify(form) !== JSON.stringify(branch);

  const save = useSave(() => api(`/branches/${branch.id}`, {
    method: 'PATCH',
    body: { name: form.name, addressLine: form.addressLine, city: form.city, state: form.state, pincode: form.pincode || null, phone: form.phone || null, openingHours: form.openingHours, isActive: form.isActive },
  }), ['branches']);
  const submit = (e: FormEvent) => { e.preventDefault(); setSaved(false); save.mutate(undefined, { onSuccess: () => setSaved(true) }); };

  return (
    <Card className="p-5">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-lg font-bold">{branch.name}</h2>
          {branch.isActive ? <Pill tone="ok">Open</Pill> : <Pill>Closed</Pill>}
          {Object.keys(branch.openingHours).length === 0 ? <Pill tone="warn">Hours not set</Pill> : null}
        </div>
        {save.error ? <Notice>{errorText(save.error)}</Notice> : saved && !dirty ? <Notice kind="ok">Saved.</Notice> : null}
        <fieldset disabled={!editable || save.isPending} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Branch name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Field label="Phone patients call" type="tel" value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <Field label="Address" value={form.addressLine} onChange={(e) => setForm({ ...form, addressLine: e.target.value })} />
          <div className="grid grid-cols-3 gap-4">
            <Field label="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            <Field label="State" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
            <Field label="Pincode" inputMode="numeric" maxLength={6} value={form.pincode ?? ''} onChange={(e) => setForm({ ...form, pincode: e.target.value })} />
          </div>
          <div>
            <div className="mb-1 text-[13px] font-semibold">Opening hours</div>
            <p className="mb-2 text-[13px] text-ink-2">The AI tells callers these hours. Doctor sessions outside them are flagged.</p>
            <OpeningHoursEditor value={form.openingHours} onChange={(h) => setForm({ ...form, openingHours: h })} disabled={!editable} />
          </div>
          <Toggle label="Branch is open" description="A closed branch takes no new sessions or bookings." checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} />
        </fieldset>
        {editable ? <div className="flex"><Button variant="primary" type="submit" loading={save.isPending} disabled={!dirty} className="ml-auto">Save branch</Button></div> : null}
      </form>
    </Card>
  );
}

function AddBranch({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ name: '', addressLine: '', city: '', state: 'Bihar', pincode: '', phone: '' });
  const save = useSave(() => api('/branches', {
    method: 'POST',
    body: { ...form, pincode: form.pincode || null, phone: form.phone || null, openingHours: { mon: [DEFAULT_PERIOD], tue: [DEFAULT_PERIOD], wed: [DEFAULT_PERIOD], thu: [DEFAULT_PERIOD], fri: [DEFAULT_PERIOD], sat: [DEFAULT_PERIOD] } },
  }), ['branches']);
  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); }} className="flex flex-col gap-4">
        <h2 className="font-display text-lg font-bold">New branch</h2>
        {save.error ? <Notice>{errorText(save.error)}</Notice> : null}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Branch name" placeholder="e.g. Kankarbagh" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Field label="Phone patients call" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <Field label="Address" value={form.addressLine} onChange={(e) => setForm({ ...form, addressLine: e.target.value })} />
        <div className="grid grid-cols-3 gap-4">
          <Field label="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          <Field label="State" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
          <Field label="Pincode" inputMode="numeric" maxLength={6} value={form.pincode} onChange={(e) => setForm({ ...form, pincode: e.target.value })} />
        </div>
        <p className="text-[13px] text-ink-2">Starts with Monday–Saturday 10:00–19:00. Change the hours after adding it.</p>
        <div className="flex gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" loading={save.isPending} className="ml-auto">Add branch</Button></div>
      </form>
    </Card>
  );
}

/** Step 2 / Settings › Branches and hours. */
export function Branches() {
  const { can, current } = useClinic();
  const { branches } = useClinicData();
  const [adding, setAdding] = useState(false);
  const orgWide = can('branch:manage') && current.data?.you.roleKey === 'owner';
  if (branches.isPending) return <p className="text-ink-2">Loading…</p>;
  return (
    <div className="flex flex-col gap-5">
      {branches.data?.map((b) => <BranchCard key={b.id} branch={b} />)}
      {adding ? <AddBranch onClose={() => setAdding(false)} /> : orgWide ? <Button onClick={() => setAdding(true)} className="self-start">+ Add a branch</Button> : null}
    </div>
  );
}

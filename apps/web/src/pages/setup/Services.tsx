import type { ConsultMode } from '@dr/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, ChipGroup, ChoiceCards, Empty, Field, Notice, Pill, Select, TextArea, Toggle } from '../../components/ui';
import { api } from '../../lib/api';
import { errorText, useClinic, useClinicData, useSave, type Service, type Settings } from '../../lib/clinic';
import { MODE_LABEL, minutesLabel, parseRupees, rupees } from '../../lib/format';

const MODE_OPTIONS = (['clinic', 'video', 'phone'] as const).map((m) => ({ value: m, label: MODE_LABEL[m] }));

type Form = { name: string; departmentId: string; durationMinutes: string; fee: string; aiMayQuoteFee: boolean; modes: ConsultMode[]; isActive: boolean };
const blank: Form = { name: '', departmentId: '', durationMinutes: '20', fee: '', aiMayQuoteFee: false, modes: ['clinic'], isActive: true };
const toForm = (s: Service): Form => ({
  name: s.name, departmentId: s.departmentId ?? '', durationMinutes: String(s.durationMinutes),
  fee: s.feePaise === null ? '' : String(s.feePaise / 100), aiMayQuoteFee: s.aiMayQuoteFee, modes: s.modes, isActive: s.isActive,
});

function ServiceEditor({ service, onClose }: { service: Service | null; onClose: () => void }) {
  const { departments } = useClinicData();
  const [f, setF] = useState<Form>(service ? toForm(service) : blank);
  const fee = parseRupees(f.fee);
  const feeInvalid = Number.isNaN(fee);
  const save = useSave(() => {
    const body = {
      name: f.name, departmentId: f.departmentId || null, durationMinutes: Number(f.durationMinutes),
      feePaise: fee, aiMayQuoteFee: fee === null ? false : f.aiMayQuoteFee, modes: f.modes,
    };
    return service
      ? api(`/services/${service.id}`, { method: 'PATCH', body: { ...body, isActive: f.isActive } })
      : api('/services', { method: 'POST', body });
  }, ['services', 'doctors', 'doctor']);
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(undefined, { onSuccess: onClose }); };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-xl border border-teal bg-surface p-4 ring-1 ring-teal">
      {save.error ? <Notice>{errorText(save.error)}</Notice> : null}
      <div className="grid grid-cols-2 gap-4">
        <Field label="Service name" placeholder="New consultation" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Select label="Department" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}>
          <option value="">None</option>
          {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
        <Field label="Duration (minutes)" inputMode="numeric" value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: e.target.value })} />
        <Field label="Fee (₹)" placeholder="Leave blank for “after assessment”" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })}
          error={feeInvalid ? 'Enter an amount like 500 or 1,500' : undefined} hint={fee === 0 ? 'Free' : fee === null ? 'The AI tells callers the doctor confirms the fee after assessment.' : undefined} />
      </div>
      <ChipGroup label="How it can be booked" options={MODE_OPTIONS} value={f.modes} onChange={(v) => setF({ ...f, modes: v })} />
      <Toggle label="The AI may say this fee on calls" checked={fee !== null && !feeInvalid && f.aiMayQuoteFee} disabled={fee === null || feeInvalid}
        onChange={(v) => setF({ ...f, aiMayQuoteFee: v })}
        description={fee === null ? 'Only possible when a fee is set.' : 'If off, the AI says the clinic will confirm the fee.'} />
      {service ? <Toggle label="Offered" description="Retired services disappear from booking and from every doctor." checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} /> : null}
      <div className="flex gap-2">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" loading={save.isPending} disabled={feeInvalid || f.modes.length === 0 || f.name.trim().length < 2} className="ml-auto">{service ? 'Save service' : 'Add service'}</Button>
      </div>
    </form>
  );
}

function PaymentPolicy({ settings }: { settings: Settings }) {
  const { can } = useClinic();
  const [prepay, setPrepay] = useState(settings.prepayPolicy);
  const [hours, setHours] = useState(String(settings.freeCancellationHours));
  const [text, setText] = useState(settings.cancellationPolicyText ?? '');
  const [saved, setSaved] = useState(false);
  useEffect(() => { setPrepay(settings.prepayPolicy); setHours(String(settings.freeCancellationHours)); setText(settings.cancellationPolicyText ?? ''); }, [settings]);
  const save = useSave(() => api('/settings', { method: 'PATCH', body: { prepayPolicy: prepay, freeCancellationHours: Number(hours), cancellationPolicyText: text.trim() || null } }), ['settings']);
  const editable = can('org:update');
  return (
    <Card className="p-5">
      <h3 className="font-display text-base font-bold">Payment at booking and cancellation</h3>
      <p className="mt-0.5 text-[13px] text-ink-2">Online payment links switch on with payments. Until then this is saved and the AI explains it to callers.</p>
      <div className="mt-4 flex flex-col gap-4">
        {save.error ? <Notice>{errorText(save.error)}</Notice> : saved ? <Notice kind="ok">Saved.</Notice> : null}
        <fieldset disabled={!editable} className="flex flex-col gap-4">
          <ChoiceCards name="Payment at booking" value={prepay} onChange={setPrepay} options={[
            { value: 'video_only', title: 'Video consults pay when booking', body: 'Clinic visits pay at the front desk.', badge: 'Common' },
            { value: 'always', title: 'Everyone pays when booking', body: 'Fewer no-shows; some callers drop off.' },
            { value: 'never', title: 'Pay at the clinic', body: 'No payment when booking.' },
          ]} />
          <Field label="Free cancellation up to (hours before)" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} className="w-40" />
          <TextArea label="Cancellation policy the AI reads out" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)}
            placeholder={`Free cancellation up to ${hours || 4} hours before the appointment. Later cancellations of paid video consults are not refunded.`} />
        </fieldset>
        {editable ? <Button variant="primary" className="self-end" loading={save.isPending} onClick={() => { setSaved(false); save.mutate(undefined, { onSuccess: () => setSaved(true) }); }}>Save policy</Button> : null}
      </div>
    </Card>
  );
}

/** Step 4 / Settings › Services and fees. */
export function Services() {
  const { can } = useClinic();
  const { services, departments, settings } = useClinicData();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const editable = can('service:manage');
  const rows = (services.data ?? []).filter((s) => showRetired || s.isActive);
  const dept = (id: string | null) => departments.data?.find((d) => d.id === id)?.name ?? '—';
  if (services.isPending) return <p className="text-ink-2">Loading…</p>;

  return (
    <div className="flex flex-col gap-5">
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[#FBF9F4] text-left text-[11px] font-bold tracking-[.06em] text-ink-2">
            <tr><th className="px-4 py-2.5">SERVICE</th><th className="px-4">DEPARTMENT</th><th className="px-4">DURATION</th><th className="px-4">FEE</th><th className="px-4">BOOKED AS</th><th className="px-4">ON CALLS</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((s) => editing === s.id ? (
              <tr key={s.id}><td colSpan={7} className="p-3"><ServiceEditor service={s} onClose={() => setEditing(null)} /></td></tr>
            ) : (
              <tr key={s.id} className={`border-t border-line-2 ${s.isActive ? '' : 'text-ink-2'}`}>
                <td className="px-4 py-3 font-semibold">{s.name}{!s.isActive ? <span className="ml-2"><Pill>Retired</Pill></span> : null}</td>
                <td className="px-4">{dept(s.departmentId)}</td>
                <td className="px-4">{minutesLabel(s.durationMinutes)}</td>
                <td className="px-4 font-mono">{rupees(s.feePaise)}</td>
                <td className="px-4">{s.modes.map((m) => MODE_LABEL[m]).join(', ')}</td>
                <td className="px-4">{s.aiMayQuoteFee ? <Pill tone="ai">AI says price</Pill> : <Pill>Clinic confirms</Pill>}</td>
                <td className="px-4 text-right">{editable ? <button type="button" onClick={() => setEditing(s.id)} className="text-[13px] font-semibold text-teal">Edit</button> : null}</td>
              </tr>
            ))}
            {editing === 'new' ? <tr><td colSpan={7} className="p-3"><ServiceEditor service={null} onClose={() => setEditing(null)} /></td></tr> : null}
          </tbody>
        </table>
        {rows.length === 0 && editing !== 'new' ? <div className="p-4"><Empty>No services yet. Add your consultation first.</Empty></div> : null}
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        {editable && editing !== 'new' ? <Button onClick={() => setEditing('new')}>+ Add service</Button> : null}
        {services.data?.some((s) => !s.isActive) ? (
          <label className="ml-auto flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} className="accent-teal" />Show retired services</label>
        ) : null}
      </div>
      <Notice kind="ai">The AI only says a price when you allow it for that service. Otherwise it says the clinic will confirm the fee. It never discounts or negotiates.</Notice>
      {settings.data ? <PaymentPolicy settings={settings.data} /> : null}
    </div>
  );
}

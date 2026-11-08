import { LANGUAGES } from '@dr/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, ChipGroup, Field, Notice } from '../../components/ui';
import { api } from '../../lib/api';
import { errorText, useClinic, useClinicData, useSave, type Branch } from '../../lib/clinic';

const SPECIALITIES = ['Hair restoration', 'Dermatology', 'Trichology', 'Cosmetology', 'Physiotherapy', 'Dental', 'General medicine', 'Gynaecology', 'Orthopaedics', 'Paediatrics'];
const LANGUAGE_OPTIONS = Object.entries(LANGUAGES).map(([value, label]) => ({ value, label }));

/** Step 1 / Settings › Organization: what the AI says about the clinic, and how patients reach it. */
export function ClinicDetails({ submitLabel = 'Save', onDone }: { submitLabel?: string; onDone?: () => void }) {
  const { current, can } = useClinic();
  const { branches } = useClinicData();
  const main: Branch | undefined = branches.data?.[0];
  const editable = can('org:update');

  const [name, setName] = useState('');
  const [specialities, setSpecialities] = useState<string[]>([]);
  const [other, setOther] = useState('');
  const [languages, setLanguages] = useState<string[]>([]);
  const [legalName, setLegalName] = useState('');
  const [gstin, setGstin] = useState('');
  const [address, setAddress] = useState({ addressLine: '', city: '', state: '', pincode: '', phone: '' });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const c = current.data;
    if (!c) return;
    setName(c.name); setSpecialities(c.specialities); setLanguages(c.languages); setLegalName(c.legalName ?? ''); setGstin(c.gstin ?? '');
  }, [current.data]);
  useEffect(() => {
    if (main) setAddress({ addressLine: main.addressLine, city: main.city, state: main.state, pincode: main.pincode ?? '', phone: main.phone ?? '' });
  }, [main]);

  const save = useSave(async () => {
    await api('/organizations/current', {
      method: 'PATCH',
      body: { name, specialities, languages, legalName: legalName.trim() || null, gstin: gstin.trim().toUpperCase() || null },
    });
    if (main && can('branch:manage')) {
      await api(`/branches/${main.id}`, {
        method: 'PATCH',
        body: { addressLine: address.addressLine, city: address.city, state: address.state, pincode: address.pincode || null, phone: address.phone || null },
      });
    }
  }, ['org', 'branches']);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    save.mutate(undefined, { onSuccess: () => { setSaved(true); onDone?.(); } });
  };

  const specialityOptions = [...new Set([...SPECIALITIES, ...specialities])].map((s) => ({ value: s, label: s }));
  const addOther = () => {
    const v = other.trim();
    if (v.length >= 2 && !specialities.includes(v)) setSpecialities([...specialities, v]);
    setOther('');
  };

  if (current.isPending) return <p className="text-ink-2">Loading…</p>;

  return (
    <div className="flex flex-wrap gap-6">
      <form onSubmit={onSubmit} className="flex min-w-0 flex-[1_1_520px] flex-col gap-5">
        {save.error ? <Notice>{errorText(save.error)}</Notice> : saved && !onDone ? <Notice kind="ok">Saved.</Notice> : null}
        {!editable ? <Notice>Only the clinic owner can change these details.</Notice> : null}
        <fieldset disabled={!editable || save.isPending} className="flex flex-col gap-5">
          <Field label="Clinic name (as patients know it)" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
          <ChipGroup label="Specialities" options={specialityOptions} value={specialities} onChange={setSpecialities} />
          <div className="flex items-end gap-2">
            <Field label="Other speciality" value={other} onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOther(); } }} className="w-64" />
            <Button type="button" onClick={addOther} disabled={other.trim().length < 2}>Add</Button>
          </div>
          <ChipGroup label="Languages your patients speak" options={LANGUAGE_OPTIONS} value={languages} onChange={setLanguages} />
          {main ? (
            <>
              <Field label="Address" value={address.addressLine} onChange={(e) => setAddress({ ...address, addressLine: e.target.value })} disabled={!can('branch:manage')} />
              <div className="grid grid-cols-3 gap-4">
                <Field label="City" value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} disabled={!can('branch:manage')} />
                <Field label="State" value={address.state} onChange={(e) => setAddress({ ...address, state: e.target.value })} disabled={!can('branch:manage')} />
                <Field label="Pincode" inputMode="numeric" maxLength={6} value={address.pincode} onChange={(e) => setAddress({ ...address, pincode: e.target.value })} disabled={!can('branch:manage')} />
              </div>
              <Field label="Clinic phone patients call" type="tel" placeholder="98765 43210" value={address.phone} onChange={(e) => setAddress({ ...address, phone: e.target.value })} disabled={!can('branch:manage')}
                hint={`For ${main.name}. Other branches have their own number under Branches.`} />
            </>
          ) : null}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Legal name (optional)" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
            <Field label="GSTIN (optional)" value={gstin} maxLength={15} onChange={(e) => setGstin(e.target.value)} hint="15 characters, used on receipts" />
          </div>
        </fieldset>
        {editable ? (
          <div className="flex gap-2.5">
            <Button variant="primary" type="submit" loading={save.isPending} disabled={languages.length === 0} className="ml-auto">{submitLabel}</Button>
          </div>
        ) : null}
      </form>

      <Card className="h-fit flex-[0_1_320px] p-5">
        <div className="text-[11px] font-bold tracking-[.08em] text-ai-ink">EXAMPLE · HOW A CALL COULD START</div>
        <p className="mt-3 text-[15px] leading-relaxed">
          “Namaste! <b>{name || 'Your clinic'}</b> mein aapka swagat hai. Main clinic ki virtual receptionist hoon…”
        </p>
        <p className="mt-3 text-xs text-ink-2">An example only. The greeting, voice and name are set up with the AI receptionist, which connects in a later release.</p>
      </Card>
    </div>
  );
}

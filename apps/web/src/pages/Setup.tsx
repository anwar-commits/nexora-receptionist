import type { OnboardingStepKey } from '@dr/contracts';
import type { ReactNode } from 'react';
import { Link, NavLink, Navigate, useNavigate, useParams } from 'react-router';
import { Button, Card, Notice, SectionTitle } from '../components/ui';
import { api } from '../lib/api';
import { errorText, useClinic, useClinicData, useSave } from '../lib/clinic';
import { Branches } from './setup/Branches';
import { ClinicDetails } from './setup/ClinicDetails';
import { Doctors } from './setup/Doctors';
import { CallsAndRecording, Departments, Holidays, PhoneAndAi, Roles, Staff } from './setup/More';
import { Services } from './setup/Services';

const STEPS: { key: OnboardingStepKey; title: string; subtitle: string }[] = [
  { key: 'clinic', title: 'Clinic details', subtitle: 'What callers hear about your clinic, and the number they call.' },
  { key: 'branches', title: 'Branches and hours', subtitle: 'Where you see patients and when you are open. The AI never offers a time you are closed.' },
  { key: 'doctors', title: 'Doctors and hours', subtitle: 'Who patients can book, and when. Video and phone sessions can sit beside clinic sessions.' },
  { key: 'services', title: 'Services and fees', subtitle: 'What the AI may book, how long it takes, and whether it may say the price.' },
  { key: 'phone', title: 'Phone and AI receptionist', subtitle: 'How calls will reach the AI, and when it should answer.' },
  { key: 'review', title: 'Review and finish', subtitle: 'Check everything is in place.' },
];

function Review() {
  const navigate = useNavigate();
  const { onboarding } = useClinicData();
  const finish = useSave(() => api('/onboarding/complete', { method: 'POST' }), []);
  const ob = onboarding.data;
  if (!ob) return <p className="text-ink-2">Loading…</p>;
  return (
    <div className="flex flex-col gap-4">
      {finish.error ? <Notice>{errorText(finish.error)}</Notice> : null}
      <Card className="divide-y divide-line-2">
        {ob.steps.filter((s) => s.key !== 'review').map((s) => (
          <div key={s.key} className="flex items-start gap-3 px-5 py-3.5">
            <span className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold ${s.done ? 'bg-teal text-white' : 'bg-warn-tint text-warn-ink'}`}>{s.done ? '✓' : '!'}</span>
            <div className="min-w-0 flex-1 text-sm">
              <b>{s.title}</b>
              {s.missing.length ? <ul className="mt-1 text-warn-ink">{s.missing.map((m) => <li key={m}>{m}</li>)}</ul> : <div className="text-ink-2">Done</div>}
            </div>
            <Link to={`/setup/${s.key}`} className="text-[13px] font-semibold text-teal">{s.done ? 'Edit' : 'Fix'}</Link>
          </div>
        ))}
      </Card>
      {ob.completedAt ? (
        <Notice kind="ok">Setup finished on {new Date(ob.completedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}. You can change anything later in Settings.</Notice>
      ) : (
        <>
          <Notice kind="ai">Finishing setup does not switch on the AI receptionist. It answers calls only after your phone line is connected and you have heard a test call.</Notice>
          <Button variant="primary" className="self-end" disabled={!ob.canComplete} loading={finish.isPending} onClick={() => finish.mutate(undefined, { onSuccess: () => navigate('/') })}>Finish setup</Button>
        </>
      )}
    </div>
  );
}

/** Six-step clinic setup. Each step saves on its own, so the owner can leave and come back. */
export function SetupPage() {
  const { step = 'clinic' } = useParams();
  const navigate = useNavigate();
  const { can } = useClinic();
  const { onboarding } = useClinicData();
  const i = STEPS.findIndex((s) => s.key === step);
  if (i < 0) return <Navigate to="/setup/clinic" replace />;
  if (!can('org:update')) return <Notice>Only the clinic owner can run setup.</Notice>;
  const s = STEPS[i]!;
  const next = STEPS[i + 1];
  const go = () => navigate(next ? `/setup/${next.key}` : '/');
  const done = (key: OnboardingStepKey) => onboarding.data?.steps.find((x) => x.key === key)?.done;

  let body: ReactNode;
  if (s.key === 'clinic') body = <ClinicDetails submitLabel="Save and continue" onDone={go} />;
  else if (s.key === 'branches') body = <Branches />;
  else if (s.key === 'doctors') body = <Doctors />;
  else if (s.key === 'services') body = <Services />;
  else if (s.key === 'phone') body = <PhoneAndAi submitLabel="Save and continue" onDone={go} />;
  else body = <Review />;

  return (
    <div className="flex flex-col gap-6">
      <ol className="flex flex-wrap gap-2" aria-label="Setup steps">
        {STEPS.map((x, j) => (
          <li key={x.key}>
            <NavLink to={`/setup/${x.key}`} className={({ isActive }) => `flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-semibold ${isActive ? 'border-teal bg-teal-tint text-[#0B5E57]' : 'border-line bg-surface text-ink-2 hover:text-ink'}`}>
              <span className={`grid size-5 place-items-center rounded-full text-[11px] ${done(x.key) ? 'bg-teal text-white' : 'bg-line-2 text-ink-2'}`}>{done(x.key) ? '✓' : j + 1}</span>
              {x.title}
            </NavLink>
          </li>
        ))}
      </ol>
      <SectionTitle title={`${i + 1}. ${s.title}`} subtitle={s.subtitle} action={<Link to="/" className="inline-flex h-10 items-center text-[13px] font-semibold text-ink-2 hover:text-ink">Save and exit</Link>} />
      {body}
      {s.key !== 'review' ? (
        <div className="flex border-t border-line pt-4">
          {i > 0 ? <Button onClick={() => navigate(`/setup/${STEPS[i - 1]!.key}`)}>Back</Button> : null}
          {s.key !== 'clinic' && s.key !== 'phone' ? <Button variant="primary" className="ml-auto" onClick={go}>Continue</Button> : null}
        </div>
      ) : null}
    </div>
  );
}

const SECTIONS: { key: string; label: string; title: string; subtitle?: string; el?: () => ReactNode }[] = [
  { key: 'organization', label: 'Organization', title: 'Organization', el: () => <ClinicDetails /> },
  { key: 'branches', label: 'Branches and hours', title: 'Branches and hours', el: () => <Branches /> },
  { key: 'holidays', label: 'Holidays', title: 'Holidays', subtitle: 'Days the clinic is closed.', el: () => <Holidays /> },
  { key: 'departments', label: 'Departments', title: 'Departments', el: () => <Departments /> },
  { key: 'doctors', label: 'Doctors and hours', title: 'Doctors and hours', el: () => <Doctors /> },
  { key: 'services', label: 'Services and fees', title: 'Services and fees', el: () => <Services /> },
  { key: 'staff', label: 'Staff', title: 'Staff', el: () => <Staff /> },
  { key: 'roles', label: 'Roles and permissions', title: 'Roles and permissions', subtitle: 'Built-in roles. Custom roles arrive later.', el: () => <Roles /> },
  { key: 'phone', label: 'AI phone line', title: 'AI phone line', el: () => <PhoneAndAi /> },
  { key: 'calls', label: 'Calls and recording', title: 'Calls and recording', el: () => <CallsAndRecording /> },
  { key: 'channels', label: 'Channels', title: 'Channels' },
  { key: 'integrations', label: 'Integrations', title: 'Integrations' },
  { key: 'billing', label: 'Plan and billing', title: 'Plan and billing' },
];

export function SettingsPage() {
  const { section = 'organization' } = useParams();
  const s = SECTIONS.find((x) => x.key === section && x.el);
  if (!s) return <Navigate to="/settings/organization" replace />;
  return (
    <div className="flex flex-wrap items-start gap-7">
      <nav aria-label="Settings" className="flex flex-[0_0_210px] flex-col gap-0.5">
          {SECTIONS.map((x) => x.el ? (
            <NavLink key={x.key} to={`/settings/${x.key}`} className={({ isActive }) => `rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-ink-2 hover:text-ink'}`}>{x.label}</NavLink>
          ) : (
            <span key={x.key} className="flex rounded-lg px-3 py-2 text-sm text-ink-2/60" title="Arrives in a later release">{x.label}<span className="ml-auto text-[10px]">soon</span></span>
          ))}
      </nav>
      <div className="flex min-w-0 flex-[1_1_640px] flex-col gap-5">
        <SectionTitle title={s.title} subtitle={s.subtitle} />
        {s.el!()}
      </div>
    </div>
  );
}

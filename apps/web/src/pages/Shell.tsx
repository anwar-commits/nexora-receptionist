import type { MeResponse } from '@dr/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { Button, Card, Logo, Notice, Pill } from '../components/ui';
import { ApiRequestError, api, auth, session } from '../lib/api';
import { useClinic, useClinicData } from '../lib/clinic';

const NAV: { label: string; to?: string }[] = [
  { label: 'Home', to: '/' }, { label: 'Reception' }, { label: 'Inbox' }, { label: 'Calendar' }, { label: 'Patients' },
  { label: 'CRM pipeline' }, { label: 'AI Receptionist' }, { label: 'Referrals' }, { label: 'Payments' }, { label: 'Analytics' },
  { label: 'Settings', to: '/settings' },
];

/** Signed-in layout: picks the clinic, then shows the sidebar, header and the page. */
export function ShellPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  // Re-render when the selected clinic changes (it lives outside React, in localStorage).
  const selectedOrg = useSyncExternalStore(session.subscribe, () => session.orgId);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<MeResponse & { session: { mfaVerified: boolean } }>('/me', { org: false }) });

  const memberships = me.data?.memberships.filter((m) => m.status === 'active') ?? [];
  const orgId = selectedOrg && (me.isFetching || memberships.some((m) => m.organizationId === selectedOrg)) ? selectedOrg : memberships[0]?.organizationId;
  // Only fall back to another clinic once /me is fresh, so a just-created clinic is not overridden.
  useEffect(() => { if (!me.isFetching && orgId && orgId !== selectedOrg) session.setOrg(orgId); }, [orgId, selectedOrg, me.isFetching]);
  const { current } = useClinic();

  if (me.isLoading) return <div className="grid h-full place-items-center text-ink-2">Loading…</div>;
  if (me.error) return <Navigate to="/login" replace />;
  if (memberships.length === 0) return <Navigate to="/clinics/new" replace />;
  if (current.error instanceof ApiRequestError && current.error.error.code === 'mfa_enrollment_required') return <Navigate to="/setup-mfa" replace />;

  const switchTo = async (id: string) => { session.setOrg(id); await qc.invalidateQueries(); navigate('/'); };
  const signOut = async () => { try { await auth.logout(); } finally { session.clear(); qc.clear(); navigate('/login', { replace: true }); } };
  const active = memberships.find((m) => m.organizationId === orgId);
  const page = location.pathname.startsWith('/settings') ? 'Settings' : location.pathname.startsWith('/setup') ? 'Setup' : 'Home';

  return (
    <div className="flex min-h-full flex-wrap">
      <aside className="flex flex-[0_0_248px] flex-col gap-1 bg-navy px-3.5 py-5">
        <div className="px-2 pb-5"><Logo light /></div>
        <label className="mb-3.5 flex flex-col gap-1 rounded-[10px] border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-medium text-[#98A2BF]">
          Clinic
          <select value={orgId} onChange={(e) => void switchTo(e.target.value)} className="bg-transparent text-[13px] font-semibold text-white outline-none" aria-label="Switch clinic">
            {memberships.map((m) => <option key={m.organizationId} value={m.organizationId} className="text-ink">{m.organizationName}</option>)}
          </select>
        </label>
        {NAV.map((n) => n.to ? (
          <NavLink key={n.label} to={n.to} end={n.to === '/'}
            className={({ isActive }) => `flex h-[38px] items-center rounded-[10px] px-3 text-sm font-medium ${isActive || (n.to === '/' && page === 'Setup') ? 'bg-[rgba(44,194,181,.16)] text-white' : 'text-[#C9D1E6] hover:bg-white/5'}`}>
            {n.label}
          </NavLink>
        ) : (
          <span key={n.label} className="flex h-[38px] cursor-default items-center rounded-[10px] px-3 text-sm font-medium text-[#C9D1E6]/50" title="Arrives in a later release">
            {n.label}<span className="ml-auto text-[10px] text-[#98A2BF]">soon</span>
          </span>
        ))}
        <button onClick={() => void navigate('/clinics/new')} className="mt-auto h-9 rounded-[10px] border border-white/10 text-[13px] font-semibold text-[#E8ECF6]">+ Add a clinic</button>
      </aside>

      <main className="flex min-w-0 flex-[999_1_560px] flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-surface/70 px-8 py-3.5">
          <div className="text-[13px] text-ink-2">{active?.organizationName} <span className="mx-1.5">/</span> <span className="font-semibold text-ink">{page}</span></div>
          <div className="ml-auto flex items-center gap-3">
            {current.data?.status === 'trial' ? <Pill tone="warn">Trial{current.data.trialEndsAt ? ` until ${new Date(current.data.trialEndsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}</Pill> : null}
            <span className="text-[13px] text-ink-2">{me.data?.user.fullName}</span>
            <Button onClick={() => void signOut()} className="h-9">Sign out</Button>
          </div>
        </header>
        <div className="flex flex-col gap-5 px-8 py-7">
          {current.error && !(current.error instanceof ApiRequestError && current.error.error.code === 'mfa_enrollment_required') ? <Notice>{current.error.message}</Notice> : null}
          {current.data ? <Outlet /> : current.isPending ? <p className="text-ink-2">Loading…</p> : null}
        </div>
      </main>
    </div>
  );
}

/** Home: setup progress until the clinic is set up, then a summary. */
export function HomePage() {
  const { current, can } = useClinic();
  const { onboarding, doctors, services, branches } = useClinicData();
  const ob = onboarding.data;
  const next = ob?.steps.find((s) => !s.done);
  const doneCount = ob?.steps.filter((s) => s.done).length ?? 0;

  return (
    <>
      <div>
        <h1 className="font-display text-[28px] font-bold">{current.data?.name}</h1>
        <p className="mt-1 text-ink-2">Signed in as <b className="text-ink">{current.data?.you.roleKey.replace('_', ' ')}</b>.</p>
      </div>
      {ob && !ob.completedAt ? (
        <Card className="flex flex-wrap items-center gap-5 p-5">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-bold tracking-[.08em] text-teal">SET UP YOUR CLINIC · {doneCount} OF {ob.steps.length} DONE</div>
            <h2 className="mt-1 font-display text-xl font-bold">{next ? `Next: ${next.title}` : 'Ready to finish'}</h2>
            {next?.missing.length ? <p className="mt-1 text-sm text-ink-2">{next.missing.slice(0, 2).join(' · ')}</p> : null}
            <div className="mt-3 flex gap-1.5">{ob.steps.map((s) => <span key={s.key} className={`h-1.5 flex-1 rounded-full ${s.done ? 'bg-teal' : 'bg-line'}`} />)}</div>
          </div>
          {can('org:update') ? <Link to={`/setup/${next?.key ?? 'review'}`} className="inline-flex h-11 items-center rounded-[10px] bg-teal px-5 text-[15px] font-semibold text-white hover:bg-teal-dark">Continue setup</Link> : <span className="text-sm text-ink-2">The clinic owner is finishing setup.</span>}
        </Card>
      ) : ob ? <Notice kind="ok">Setup is complete. The AI receptionist starts answering once your phone line is connected in the telephony release.</Notice> : null}

      <div className="grid gap-5 md:grid-cols-3">
        <Card className="p-5">
          <h2 className="font-display text-lg font-bold">Doctors</h2>
          <p className="mt-1 text-3xl font-bold">{doctors.data?.filter((d) => d.isActive).length ?? '—'}</p>
          <p className="text-sm text-ink-2">{doctors.data?.filter((d) => d.isActive && d.weeklyHours.length === 0).length ? `${doctors.data.filter((d) => d.isActive && d.weeklyHours.length === 0).length} without hours` : 'all with weekly hours'}</p>
          <Link to="/settings/doctors" className="mt-3 inline-block text-[13px] font-semibold text-teal">Doctors and hours →</Link>
        </Card>
        <Card className="p-5">
          <h2 className="font-display text-lg font-bold">Services</h2>
          <p className="mt-1 text-3xl font-bold">{services.data?.filter((s) => s.isActive).length ?? '—'}</p>
          <p className="text-sm text-ink-2">{services.data?.filter((s) => s.isActive && s.aiMayQuoteFee).length ?? 0} with a price the AI may say</p>
          <Link to="/settings/services" className="mt-3 inline-block text-[13px] font-semibold text-teal">Services and fees →</Link>
        </Card>
        <Card className="p-5">
          <h2 className="font-display text-lg font-bold">Branches</h2>
          <p className="mt-1 text-3xl font-bold">{branches.data?.filter((b) => b.isActive).length ?? '—'}</p>
          <p className="text-sm text-ink-2">{branches.data?.map((b) => b.name).join(', ')}</p>
          <Link to="/settings/branches" className="mt-3 inline-block text-[13px] font-semibold text-teal">Branches and hours →</Link>
        </Card>
      </div>
      <Notice kind="ai">Reception, calendar, patients and the AI receptionist arrive in the next releases. This release covers clinic setup.</Notice>
    </>
  );
}

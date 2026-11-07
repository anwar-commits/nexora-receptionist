import type { MeResponse } from '@dr/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { Button, Card, Logo, Notice, Pill } from '../components/ui';
import { ApiRequestError, api, auth, session } from '../lib/api';

interface Current { id: string; name: string; status: string; trialEndsAt: string | null; you: { roleKey: string; permissions: string[] } }
interface Branch { id: string; name: string; city: string; addressLine: string; isActive: boolean }
interface Member { id: string; fullName: string; email: string | null; phone: string | null; roleName: string; status: string }

const NAV = ['Home', 'Reception', 'Inbox', 'Calendar', 'Patients', 'CRM pipeline', 'AI Receptionist', 'Referrals', 'Payments', 'Analytics', 'Settings'];

/** Signed-in layout: sidebar from the design, clinic switcher, and the Phase 3 home. */
export function ShellPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Re-render when the selected clinic changes (it lives outside React, in localStorage).
  const selectedOrg = useSyncExternalStore(session.subscribe, () => session.orgId);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<MeResponse & { session: { mfaVerified: boolean } }>('/me', { org: false }) });

  const memberships = me.data?.memberships.filter((m) => m.status === 'active') ?? [];
  const orgId = selectedOrg && (me.isFetching || memberships.some((m) => m.organizationId === selectedOrg)) ? selectedOrg : memberships[0]?.organizationId;
  // Only fall back to another clinic once /me is fresh, so a just-created clinic is not overridden.
  useEffect(() => { if (!me.isFetching && orgId && orgId !== selectedOrg) session.setOrg(orgId); }, [orgId, selectedOrg, me.isFetching]);

  const current = useQuery({
    queryKey: ['org', orgId],
    queryFn: () => api<Current>('/organizations/current'),
    enabled: !!orgId && selectedOrg === orgId,
    retry: false,
  });
  const can = (p: string) => current.data?.you.permissions.includes(p) ?? false;
  const branches = useQuery({ queryKey: ['branches', orgId], queryFn: () => api<{ items: Branch[] }>('/branches'), enabled: can('branch:read') });
  const members = useQuery({ queryKey: ['members', orgId], queryFn: () => api<{ items: Member[] }>('/members'), enabled: can('member:read') });

  if (me.isLoading) return <div className="grid h-full place-items-center text-ink-2">Loading…</div>;
  if (me.error) return <Navigate to="/login" replace />;
  if (memberships.length === 0) return <Navigate to="/clinics/new" replace />;
  if (current.error instanceof ApiRequestError && current.error.error.code === 'mfa_enrollment_required') return <Navigate to="/setup-mfa" replace />;

  const switchTo = async (id: string) => { session.setOrg(id); await qc.invalidateQueries(); };
  const signOut = async () => { try { await auth.logout(); } finally { session.clear(); qc.clear(); navigate('/login', { replace: true }); } };
  const active = memberships.find((m) => m.organizationId === orgId);

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
        {NAV.map((n, i) => (
          <a key={n} href="#" aria-current={i === 0 ? 'page' : undefined}
            className={`flex h-[38px] items-center rounded-[10px] px-3 text-sm font-medium ${i === 0 ? 'bg-[rgba(44,194,181,.16)] text-white' : 'text-[#C9D1E6]/60'}`}
            title={i === 0 ? undefined : 'Arrives in a later phase'}>
            {n}{i === 0 ? null : <span className="ml-auto text-[10px] text-[#98A2BF]">soon</span>}
          </a>
        ))}
        <button onClick={() => void navigate('/clinics/new')} className="mt-auto h-9 rounded-[10px] border border-white/10 text-[13px] font-semibold text-[#E8ECF6]">+ Add a clinic</button>
      </aside>

      <main className="flex min-w-0 flex-[999_1_560px] flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-surface/70 px-8 py-3.5">
          <div className="text-[13px] text-ink-2">{active?.organizationName} <span className="mx-1.5">/</span> <span className="font-semibold text-ink">Home</span></div>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-[13px] text-ink-2">{me.data?.user.fullName}</span>
            <Button onClick={() => void signOut()} className="h-9">Sign out</Button>
          </div>
        </header>

        <div className="flex flex-col gap-5 px-8 py-7">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <h1 className="font-display text-[28px] font-bold">{current.data?.name ?? active?.organizationName}</h1>
              <p className="mt-1 text-ink-2">You are signed in as <b className="text-ink">{active?.roleName}</b>{me.data?.session.mfaVerified ? ' with two-step verification' : ''}.</p>
            </div>
            <div className="ml-auto flex gap-2">
              {current.data?.status === 'trial' ? <Pill tone="warn">Trial{current.data.trialEndsAt ? ` until ${new Date(current.data.trialEndsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}</Pill> : null}
              {me.data?.user.mfaEnrolled ? <Pill tone="ok">Two-step on</Pill> : <Pill>Two-step off</Pill>}
            </div>
          </div>

          {current.error && !(current.error instanceof ApiRequestError && current.error.error.code === 'mfa_enrollment_required') ? <Notice>{current.error.message}</Notice> : null}

          <div className="flex flex-wrap gap-5">
            <Card className="min-w-0 flex-[1_1_320px] p-5">
              <h2 className="font-display text-lg font-bold">Branches</h2>
              {current.isPending ? <p className="mt-2 text-sm text-ink-2">Loading…</p> : !can('branch:read') ? <p className="mt-2 text-sm text-ink-2">Your role cannot see branches.</p> : (
                <ul className="mt-3 flex flex-col gap-2">
                  {branches.data?.items.map((b) => (
                    <li key={b.id} className="flex items-center gap-3 rounded-[10px] border border-line-2 px-3 py-2.5 text-sm">
                      <div><b>{b.name}</b><div className="text-ink-2">{b.addressLine}, {b.city}</div></div>
                      <span className="ml-auto">{b.isActive ? <Pill tone="ok">Open</Pill> : <Pill>Closed</Pill>}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card className="min-w-0 flex-[1_1_320px] p-5">
              <h2 className="font-display text-lg font-bold">Team</h2>
              {current.isPending ? <p className="mt-2 text-sm text-ink-2">Loading…</p> : !can('member:read') ? <p className="mt-2 text-sm text-ink-2">Your role cannot see the team list.</p> : (
                <ul className="mt-3 flex flex-col gap-2">
                  {members.data?.items.map((m) => (
                    <li key={m.id} className="flex items-center gap-3 rounded-[10px] border border-line-2 px-3 py-2.5 text-sm">
                      <div className="min-w-0"><b>{m.fullName}</b><div className="truncate text-ink-2">{m.email ?? m.phone}</div></div>
                      <span className="ml-auto flex gap-1.5"><Pill tone="teal">{m.roleName}</Pill>{m.status === 'invited' ? <Pill tone="warn">Invited</Pill> : null}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card className="min-w-0 flex-[1_1_320px] p-5">
              <h2 className="font-display text-lg font-bold">What your role can do</h2>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {current.data?.you.permissions.map((p) => <span key={p} className="rounded-md bg-line-2 px-2 py-1 font-mono text-[11px]">{p}</span>)}
              </div>
            </Card>
          </div>
          <Notice kind="ai">Phase 3 delivers sign-in, clinics, branches, staff and roles. Reception, calendar, patients and the AI receptionist arrive in Phases 4–9.</Notice>
        </div>
      </main>
    </div>
  );
}

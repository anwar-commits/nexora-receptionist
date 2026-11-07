import { createOrganizationBody, registerBody } from '@dr/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import type { z } from 'zod';
import { Button, Field, Notice } from '../components/ui';
import { ApiRequestError, api, auth, session } from '../lib/api';
import { AuthLayout, useAfterFirstFactor } from './Login';

function apiMessage(e: unknown) {
  return e instanceof ApiRequestError ? e.message : 'Could not reach the server. Check your connection.';
}

export function RegisterPage() {
  const next = useAfterFirstFactor();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.input<typeof registerBody>, unknown, z.output<typeof registerBody>>({ resolver: zodResolver(registerBody) });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (body) => {
    setError(null);
    try { next(await auth.register(body)); } catch (e) { setError(apiMessage(e)); }
  });

  return (
    <AuthLayout>
      <form onSubmit={onSubmit} noValidate className="flex w-full max-w-[400px] flex-col gap-4">
        <div>
          <h2 className="font-display text-[28px] font-bold">Create your account</h2>
          <p className="mt-1.5 text-ink-2">Then set up your clinic. Takes about 15 minutes.</p>
        </div>
        {error ? <Notice>{error}</Notice> : null}
        <Field label="Your name" autoComplete="name" error={errors.fullName?.message} {...form.register('fullName')} />
        <Field label="Work email" type="email" autoComplete="email" error={errors.email?.message} {...form.register('email')} />
        <Field label="Mobile number" type="tel" autoComplete="tel" placeholder="98765 43210" error={errors.phone?.message} {...form.register('phone')} />
        <Field label="Password" type="password" autoComplete="new-password" hint="At least 10 characters, letters and numbers" error={errors.password?.message} {...form.register('password')} />
        <Button variant="primary" type="submit" loading={isSubmitting} className="h-12 text-[15px]">Create account</Button>
        <p className="text-center text-sm text-ink-2">Already have an account? <Link to="/login" className="font-semibold text-teal">Sign in</Link></p>
      </form>
    </AuthLayout>
  );
}

const STEPS = ['Clinic details', 'Branches', 'Doctors and hours', 'Services and fees', 'Phone and AI receptionist', 'Review and go live'];

export function CreateClinicPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.input<typeof createOrganizationBody>, unknown, z.output<typeof createOrganizationBody>>({
    resolver: zodResolver(createOrganizationBody),
    defaultValues: { state: 'Bihar', languages: ['en', 'hi'], specialities: [] },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (body) => {
    setError(null);
    try {
      const r = await api<{ organization: { id: string }; mfaRequiredForRole: boolean }>('/organizations', { method: 'POST', body, org: false });
      session.setOrg(r.organization.id);
      await qc.refetchQueries({ queryKey: ['me'] });
      await qc.invalidateQueries();
      navigate(r.mfaRequiredForRole ? '/setup-mfa' : '/', { replace: true });
    } catch (e) { setError(apiMessage(e)); }
  });

  return (
    <div className="flex min-h-full flex-wrap">
      <aside className="flex flex-[0_0_280px] flex-col gap-7 border-r border-line bg-[#FBF9F4] p-8">
        <div className="text-xs font-bold tracking-[.08em] text-ink-2">SET UP YOUR CLINIC</div>
        <ol className="flex flex-col">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === 0 ? 'step' : undefined} className={`flex items-center gap-3 py-2.5 text-sm ${i === 0 ? 'font-semibold text-ink' : 'text-ink-2'}`}>
              <span className={`grid size-7 place-items-center rounded-full text-[13px] ${i === 0 ? 'border-2 border-teal font-bold text-teal' : 'border border-[#DCD5C8]'}`}>{i + 1}</span>
              {s}
              {i > 0 ? <span className="ml-auto text-[11px] font-medium">Phase 4</span> : null}
            </li>
          ))}
        </ol>
        <p className="mt-auto text-xs text-ink-2">Steps 2–6 are built in Phase 4. Your clinic is created now with its first branch.</p>
      </aside>
      <main className="flex-[999_1_560px] px-12 py-10">
        <form onSubmit={onSubmit} noValidate className="flex max-w-[640px] flex-col gap-5">
          <div>
            <div className="text-[13px] text-ink-2">Step 1 of 6</div>
            <h1 className="mt-1 font-display text-[28px] font-bold">Tell us about your clinic</h1>
            <p className="mt-1.5 text-ink-2">The AI receptionist uses this to introduce your clinic.</p>
          </div>
          {error ? <Notice>{error}</Notice> : null}
          <Field label="Clinic name (as patients know it)" error={errors.name?.message} {...form.register('name')} />
          <Field label="Address" error={errors.addressLine?.message} {...form.register('addressLine')} />
          <div className="grid grid-cols-3 gap-4">
            <Field label="City" error={errors.city?.message} {...form.register('city')} />
            <Field label="State" error={errors.state?.message} {...form.register('state')} />
            <Field label="Pincode" inputMode="numeric" maxLength={6} error={errors.pincode ? 'Enter a 6-digit pincode' : undefined} {...form.register('pincode', { setValueAs: (v) => (v ? v : undefined) })} />
          </div>
          <div className="flex gap-2.5">
            <Button type="button" onClick={() => navigate('/')}>Cancel</Button>
            <Button variant="primary" type="submit" loading={isSubmitting} className="ml-auto">Create clinic</Button>
          </div>
        </form>
      </main>
    </div>
  );
}

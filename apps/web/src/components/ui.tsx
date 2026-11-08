import type React from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

export function Logo({ light = false }: { light?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-8 place-items-center rounded-[9px] bg-teal">
        <svg viewBox="0 0 24 24" className="size-[18px] fill-none stroke-white" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-6l-4 3v-3H6a2 2 0 0 1-2-2z" /><path d="M12 7.5v6M9 10.5h6" />
        </svg>
      </div>
      <span className={`font-display text-base font-bold ${light ? 'text-white' : 'text-ink'}`}>DocReceptionist</span>
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost'; loading?: boolean };
export function Button({ variant = 'secondary', loading, className = '', children, disabled, ...rest }: BtnProps) {
  const styles = {
    primary: 'bg-teal text-white border-teal hover:bg-teal-dark',
    secondary: 'bg-surface text-ink border-line hover:shadow-sm',
    ghost: 'bg-transparent text-teal border-transparent hover:bg-teal-tint',
  }[variant];
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex h-11 items-center justify-center gap-2 rounded-[10px] border px-4 text-sm font-semibold transition active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    >
      {loading ? <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: ReactNode };
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ label, error, hint, id, className = '', ...rest }, ref) {
  const fid = id ?? rest.name;
  return (
    <label htmlFor={fid} className="flex flex-col gap-1.5 text-[13px] font-semibold">
      {label}
      <input
        ref={ref}
        id={fid}
        aria-invalid={!!error}
        aria-describedby={error ? `${fid}-err` : undefined}
        className={`h-11 rounded-[10px] border bg-surface px-3.5 text-[15px] font-normal text-ink outline-none transition focus:border-teal ${error ? 'border-[#C97A06]' : 'border-line'} ${className}`}
        {...rest}
      />
      {error ? <span id={`${fid}-err`} className="font-medium text-warn-ink">{error}</span> : hint ? <span className="font-normal text-ink-2">{hint}</span> : null}
    </label>
  );
});

export function Notice({ kind = 'warn', children }: { kind?: 'warn' | 'ok' | 'ai'; children: ReactNode }) {
  const s = { warn: 'bg-warn-tint text-warn-ink border-[#F2D3A2]', ok: 'bg-ok-tint text-ok-ink border-[#B8E6D2]', ai: 'bg-ai-tint text-ai-ink border-[#E5E0FC]' }[kind];
  return <div role={kind === 'warn' ? 'alert' : 'status'} className={`rounded-xl border px-3.5 py-2.5 text-[13px] ${s}`}>{children}</div>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-[14px] border border-line bg-surface shadow-[0_1px_2px_rgba(11,21,48,.05),0_8px_24px_rgba(11,21,48,.05)] ${className}`}>{children}</section>;
}

export function Pill({ children, tone = 'n' }: { children: ReactNode; tone?: 'n' | 'ok' | 'ai' | 'teal' | 'warn' }) {
  const s = { n: 'bg-[#F2EEE6] text-[#4A5370]', ok: 'bg-ok-tint text-ok-ink', ai: 'bg-ai-tint text-ai-ink', teal: 'bg-teal-tint text-[#0B5E57]', warn: 'bg-warn-tint text-warn-ink' }[tone];
  return <span className={`inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold ${s}`}>{children}</span>;
}

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string; children: ReactNode };
export function Select({ label, error, id, className = '', children, ...rest }: SelectProps) {
  const fid = id ?? rest.name;
  return (
    <label htmlFor={fid} className="flex flex-col gap-1.5 text-[13px] font-semibold">
      {label}
      <select id={fid} aria-invalid={!!error} className={`h-11 rounded-[10px] border bg-surface px-3 text-[15px] font-normal text-ink outline-none focus:border-teal ${error ? 'border-[#C97A06]' : 'border-line'} ${className}`} {...rest}>
        {children}
      </select>
      {error ? <span className="font-medium text-warn-ink">{error}</span> : null}
    </label>
  );
}

type TextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: ReactNode; error?: string };
export function TextArea({ label, hint, error, id, className = '', ...rest }: TextAreaProps) {
  const fid = id ?? rest.name;
  return (
    <label htmlFor={fid} className="flex flex-col gap-1.5 text-[13px] font-semibold">
      {label}
      <textarea id={fid} className={`min-h-24 rounded-[10px] border border-line bg-surface px-3.5 py-2.5 text-[15px] font-normal text-ink outline-none focus:border-teal ${className}`} {...rest} />
      {error ? <span className="font-medium text-warn-ink">{error}</span> : hint ? <span className="font-normal text-ink-2">{hint}</span> : null}
    </label>
  );
}

/** Accessible on/off switch. */
export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode; disabled?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition disabled:opacity-50 ${checked ? 'bg-teal' : 'bg-[#D9D3C7]'}`}>
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
      <div className="text-sm"><div className="font-semibold">{label}</div>{description ? <div className="text-ink-2">{description}</div> : null}</div>
    </div>
  );
}

/** Multi-select as a row of chips. */
export function ChipGroup<T extends string>({ label, options, value, onChange }: { label: string; options: readonly { value: T; label: string }[]; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-[13px] font-semibold">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = value.includes(o.value);
          return (
            <button key={o.value} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
              className={`h-9 rounded-full border px-3.5 text-[13px] font-semibold transition ${on ? 'border-teal bg-teal-tint text-[#0B5E57]' : 'border-line bg-surface text-ink-2 hover:text-ink'}`}>
              {on ? <span aria-hidden="true">✓ </span> : null}{o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** One choice among a few, shown as cards (used for policies and pickup modes). */
export function ChoiceCards<T extends string>({ name, options, value, onChange }: { name: string; options: { value: T; title: string; body: ReactNode; badge?: string }[]; value: T | null; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={name} className="flex flex-col gap-2.5">
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition ${on ? 'border-teal bg-teal-tint/60 ring-1 ring-teal' : 'border-line bg-surface hover:shadow-sm'}`}>
            <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 ${on ? 'border-teal' : 'border-[#CFC8BA]'}`}>{on ? <span className="size-2.5 rounded-full bg-teal" /> : null}</span>
            <span className="text-sm"><span className="flex items-center gap-2 font-semibold">{o.title}{o.badge ? <Pill tone="teal">{o.badge}</Pill> : null}</span><span className="mt-0.5 block text-ink-2">{o.body}</span></span>
          </button>
        );
      })}
    </div>
  );
}

export function SectionTitle({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-[26px] font-bold">{title}</h1>
        {subtitle ? <p className="mt-1 max-w-[680px] text-ink-2">{subtitle}</p> : null}
      </div>
      {action ? <div className="ml-auto flex gap-2">{action}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-ink-2">{children}</div>;
}

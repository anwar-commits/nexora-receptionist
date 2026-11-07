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

import clsx from 'clsx';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { SpinnerIcon } from './Icons.js';

/* ------------------------------------------------------------------ surfaces */

export function Card({
  title,
  subtitle,
  action,
  children,
  className,
  dense,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  return (
    <section
      className={clsx(
        'rounded-2xl border border-surface-border bg-surface-raised shadow-sm shadow-black/20',
        className,
      )}
    >
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-surface-border px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="truncate text-sm font-semibold text-content-primary">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-content-secondary">{subtitle}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={dense ? 'p-3' : 'p-4'}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------- buttons */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warm';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface-overlay text-content-primary hover:bg-surface-hover border-surface-border',
  ghost: 'bg-transparent text-content-secondary hover:bg-surface-hover border-transparent',
  danger: 'bg-transparent text-state-error hover:bg-state-error/10 border-state-error/50',
  warm: 'bg-warm text-black hover:bg-warm-hover border-transparent',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm',
        VARIANTS[variant],
        className,
      )}
    >
      {loading ? <SpinnerIcon size={16} /> : icon}
      {children}
    </button>
  );
}

/* --------------------------------------------------------------------- misc */

export function Badge({
  tone = 'neutral',
  children,
  className,
  title,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'error' | 'info' | 'accent';
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-surface-hover text-content-secondary border-surface-border',
    ok: 'bg-state-ok/15 text-state-ok border-state-ok/40',
    warn: 'bg-state-warn/15 text-state-warn border-state-warn/40',
    error: 'bg-state-error/15 text-state-error border-state-error/40',
    info: 'bg-state-info/15 text-state-info border-state-info/40',
    accent: 'bg-accent/15 text-accent border-accent/40',
  };
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'ok' | 'warn' | 'error';
}) {
  return (
    <div className="rounded-xl border border-surface-border bg-surface-overlay/60 p-3">
      <p className="text-xs uppercase tracking-wide text-content-muted">{label}</p>
      <p
        className={clsx(
          'mt-1 truncate text-lg font-semibold',
          tone === 'ok' ? 'text-state-ok' : tone === 'warn' ? 'text-state-warn' : tone === 'error' ? 'text-state-error' : 'text-content-primary',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-content-muted">{hint}</p>}
    </div>
  );
}

export function ProgressBar({ value, tone = 'accent' }: { value: number | null; tone?: 'accent' | 'ok' | 'warn' }) {
  const pct = value === null || Number.isNaN(value) ? null : Math.min(100, Math.max(0, value));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-hover">
      <div
        className={clsx(
          'h-full rounded-full transition-[width] duration-300',
          tone === 'ok' ? 'bg-state-ok' : tone === 'warn' ? 'bg-state-warn' : 'bg-accent',
        )}
        style={{ width: pct === null ? '0%' : `${pct}%` }}
      />
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label className={clsx('flex items-start justify-between gap-4 py-2', disabled && 'opacity-60')}>
      <span className="min-w-0">
        <span className="block text-sm text-content-primary">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-content-secondary">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors',
          checked ? 'border-accent bg-accent' : 'border-surface-border bg-surface-hover',
        )}
      >
        <span
          className={clsx(
            'block h-5 w-5 rounded-full bg-white transition-transform',
            checked ? 'translate-x-[22px]' : 'translate-x-0.5',
          )}
        />
      </button>
    </label>
  );
}

export function Field({
  label,
  hint,
  children,
  error,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  error?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-content-muted">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-state-error">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-content-muted">{hint}</span>
      ) : null}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 text-sm text-content-primary placeholder:text-content-muted focus:border-accent focus:outline-none';

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(inputClass, props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx(inputClass, 'pr-8', props.className)} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-surface-border px-6 py-10 text-center">
      {icon && <div className="mb-3 text-content-muted">{icon}</div>}
      <h3 className="text-sm font-semibold text-content-primary">{title}</h3>
      {description && <p className="mt-1 max-w-md text-xs text-content-secondary">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error?: { message: string; remediation?: string; details?: string } | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="rounded-xl border border-state-error/40 bg-state-error/10 p-3">
      <p className="text-sm font-medium text-state-error">{error.message}</p>
      {error.remediation && <p className="mt-1 text-xs text-content-secondary">{error.remediation}</p>}
      {error.details && <p className="mt-1 font-mono text-[11px] text-content-muted">{error.details}</p>}
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-lg bg-surface-hover', className ?? 'h-4 w-24')} />;
}

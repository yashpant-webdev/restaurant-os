'use client';

import { ReactNode, useCallback, useEffect, useState } from 'react';

export function Card({ title, sub, children, right }: { title?: ReactNode; sub?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="min-w-0 rounded-[var(--radius-card)] bg-panel p-5">
      {(title || right) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-base font-bold">{title}</h2>}
            {sub && <p className="text-xs text-muted mt-0.5">{sub}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'bad' | 'warn' }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-panel p-5">
      <div className="text-xs font-semibold text-muted">{label}</div>
      <div className="num display mt-1 text-3xl font-bold">{value}</div>
      {hint && <div className={`mt-1 text-xs ${tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-muted'}`}>{hint}</div>}
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: 'good' | 'bad' | 'warn' | 'accent' }) {
  const c = tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'accent' ? 'text-accent' : 'text-ink';
  return <span className={`inline-flex items-center gap-1 rounded-full bg-chip px-2.5 py-0.5 text-[11px] font-bold ${c}`}>{children}</span>;
}

export function Button({ children, onClick, variant = 'primary', disabled, type = 'button', small }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; type?: 'button' | 'submit'; small?: boolean }) {
  const v =
    variant === 'primary' ? 'bg-accent text-accent-ink' : variant === 'danger' ? 'border-[1.5px] border-bad/60 text-bad' : 'border-[1.5px] border-ink text-ink';
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`${v} ${small ? 'px-3 py-1 text-xs' : 'px-5 py-2.5 text-sm'} rounded-full font-bold disabled:opacity-40 cursor-pointer`}>
      {children}
    </button>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  const { label, className, ...rest } = props;
  return (
    <label className="grid min-w-0 gap-1 text-xs font-semibold text-muted">
      {label}
      <input {...rest} className={`w-full min-w-0 rounded-[var(--radius-inner)] border-[1.5px] border-transparent bg-panel-2 px-3 py-2.5 text-sm text-ink outline-none focus:border-ink ${className ?? ''}`} />
    </label>
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  const { label, children, ...rest } = props;
  return (
    <label className="grid min-w-0 gap-1 text-xs font-semibold text-muted">
      {label}
      <select {...rest} className="w-full min-w-0 rounded-[var(--radius-inner)] border-[1.5px] border-transparent bg-panel-2 px-3 py-2.5 text-sm text-ink outline-none focus:border-ink">
        {children}
      </select>
    </label>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="num w-full border-collapse text-sm">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className="border-b-[1.5px] border-ink/70 px-2 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:border-b [&_td]:border-line [&_td]:px-2 [&_td]:py-2">{children}</tbody>
      </table>
    </div>
  );
}

/** One-series horizontal bars: label, bar, value. */
export function Bars({ rows }: { rows: { label: string; value: number; display: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="grid grid-cols-[minmax(90px,150px)_1fr_auto] items-center gap-x-3 gap-y-1.5 text-sm">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <span className="truncate" title={r.label}>{r.label}</span>
          <span className="h-3.5" title={`${r.label}: ${r.display}`}>
            <span className="block h-full rounded-full bg-series" style={{ width: `${(r.value / max) * 100}%`, minWidth: 2 }} />
          </span>
          <span className="num text-right text-muted">{r.display}</span>
        </div>
      ))}
    </div>
  );
}

export function PageHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-3xl font-bold">{title}</h1>
        {sub && <p className="text-sm text-muted">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

/** Loads data with loading and error states; `reload` re-runs it. */
export function useData<T>(load: () => Promise<T>, deps: unknown[] = [], refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(() => load().then((d) => (setData(d), setError(null))).catch((e) => setError(e.message)), deps);
  useEffect(() => {
    reload();
    if (!refreshMs) return;
    const t = setInterval(reload, refreshMs);
    return () => clearInterval(t);
  }, [reload, refreshMs]);
  return { data, error, reload };
}

export function Loading({ error }: { error?: string | null }) {
  return <div className="rounded-[var(--radius-card)] bg-panel p-8 text-center text-sm text-muted">{error ? <span className="text-bad">{error}</span> : 'Loading…'}</div>;
}

export function useToast() {
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);
  const node = msg && (
    <div className={`fixed bottom-5 left-1/2 z-50 max-w-[calc(100%-32px)] -translate-x-1/2 rounded-full px-5 py-3 text-sm font-semibold ${msg.bad ? 'bg-bad text-white' : 'bg-accent text-accent-ink'}`}>{msg.text}</div>
  );
  return { toast: (text: string, bad = false) => setMsg({ text, bad }), node };
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, useEffect, useState } from 'react';
import { config } from '@/lib/api';

const NAV: { group: string; items: { href: string; label: string; planned?: boolean }[] }[] = [
  { group: 'Operations', items: [{ href: '/', label: 'Live overview' }, { href: '/menu', label: 'Menu' }, { href: '/tables', label: 'Tables & floor' }, { href: '/staff', label: 'Staff & captains' }] },
  {
    group: 'Reports',
    items: [
      { href: '/reports/sales', label: 'Sales' },
      { href: '/reports/menu', label: 'Menu engineering' },
      { href: '/reports/finance', label: 'Finance & GST' },
      { href: '/reports/customers', label: 'Customers (CRM)' },
      { href: '/reports/alerts', label: 'Alerts' },
    ],
  },
  {
    group: 'Coming next',
    items: [
      { href: '/inventory', label: 'Inventory & recipes', planned: true },
      { href: '/central-kitchen', label: 'Central kitchen', planned: true },
      { href: '/online', label: 'Online orders', planned: true },
    ],
  },
];

/** Sidebar navigation (desktop) / top menu (phone), like a merchant portal. */
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [outlet, setOutlet] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    config()
      .then((c) => setOutlet(c.outletName))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => setOpen(false), [path]);

  const nav = (
    <nav className="grid gap-5 text-sm">
      {NAV.map((g) => (
        <div key={g.group}>
          <div className="mb-1.5 px-3.5 text-[11px] font-bold uppercase tracking-wide text-muted">{g.group}</div>
          {g.items.map((i) => (
            <Link
              key={i.href}
              href={i.href}
              className={`flex items-center justify-between rounded-full px-3.5 py-2 font-semibold ${path === i.href ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'}`}
            >
              {i.label}
              {i.planned && <span className="text-[10px] uppercase">soon</span>}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[230px_1fr]">
      <aside className="hidden p-4 md:block">
        <div className="mb-6 px-3.5">
          <div className="display text-xl font-bold">Restaurant OS</div>
          <div className="text-xs text-muted">{outlet || 'Central dashboard'}</div>
        </div>
        {nav}
      </aside>
      <div className="min-w-0">
        <header className="flex items-center justify-between px-4 py-3 md:hidden">
          <div>
            <div className="display text-lg font-bold">Restaurant OS</div>
            <div className="text-xs text-muted">{outlet}</div>
          </div>
          <button className="rounded-full border-[1.5px] border-ink px-4 py-1.5 text-sm font-bold" onClick={() => setOpen(!open)} aria-expanded={open}>
            Menu
          </button>
        </header>
        {open && <div className="mx-4 rounded-[var(--radius-card)] bg-panel p-4 md:hidden">{nav}</div>}
        {error && <div className="m-4 rounded-[var(--radius-card)] bg-panel p-4 text-sm font-semibold text-bad">{error}</div>}
        <main className="mx-auto max-w-[1400px] p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

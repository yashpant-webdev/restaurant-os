'use client';

import { useState } from 'react';
import { istDay } from '@/lib/api';

/** Period chips shared by the report pages. */
export function useRange(initial = 30) {
  const [days, setDays] = useState(initial);
  const from = istDay(-(days - 1));
  const to = istDay(0);
  const chips = (
    <div className="flex gap-1.5">
      {[7, 30, 60].map((d) => (
        <button key={d} onClick={() => setDays(d)} className={`cursor-pointer rounded-full px-4 py-1.5 text-sm font-bold ${days === d ? 'bg-accent text-accent-ink' : 'border-[1.5px] border-ink/30 text-muted'}`} aria-pressed={days === d}>
          {d} days
        </button>
      ))}
    </div>
  );
  return { days, from, to, chips, q: (outletId: string) => `outletId=${outletId}&from=${from}&to=${to}` };
}

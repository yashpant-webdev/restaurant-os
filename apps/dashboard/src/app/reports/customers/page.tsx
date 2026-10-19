'use client';

import { api, config, inr0 } from '@/lib/api';
import { useRange } from '@/components/Range';
import { Badge, Card, Kpi, Loading, PageHeader, Table, useData } from '@/components/ui';

interface Crm {
  summary: { customers: number; consented: number; newInRange: number; identifiedBillPct: number; repeatBillPct: number };
  segments: { segment: string; customers: number; spend: number }[];
  top: { name: string; phone: string; visits: number; spend: number; segment: string; days_since: number }[];
  winBack: { name: string; phone: string; visits: number; spend: number; segment: string; days_since: number }[];
}
const SEG: Record<string, string> = { CHAMPION: 'Champions', LOYAL: 'Loyal', NEW: 'New', OCCASIONAL: 'Occasional', AT_RISK: 'At risk', LOST: 'Lost' };

export default function Customers() {
  const r = useRange(30);
  const { data, error } = useData(async () => api<Crm>('analytics', `/analytics/customers?${r.q((await config()).outletId)}`), [r.from]);
  if (!data) return <Loading error={error} />;
  const s = data.summary;
  const list = (rows: Crm['top']) => (
    <Table head={['Guest', 'Mobile', 'Segment', 'Visits', 'Lifetime', 'Last visit']}>
      {rows.map((c) => <tr key={c.phone + c.name}><td>{c.name}</td><td className="font-mono">{c.phone}</td><td><Badge>{SEG[c.segment]}</Badge></td><td>{c.visits}</td><td>{inr0(c.spend)}</td><td>{c.days_since} days ago</td></tr>)}
    </Table>
  );
  return (
    <>
      <PageHeader title="Customers (CRM)" sub="Guests identified by mobile number on the bill" right={r.chips} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Known guests" value={s.customers.toLocaleString('en-IN')} hint={`${s.consented} agreed to offers`} />
        <Kpi label="New guests" value={s.newInRange} hint={`in the last ${r.days} days`} />
        <Kpi label="Bills with a phone" value={`${s.identifiedBillPct}%`} />
        <Kpi label="Repeat bills" value={`${s.repeatBillPct}%`} hint="of identified bills" />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Object.entries(SEG).map(([k, label]) => {
          const x = data.segments.find((g) => g.segment === k);
          return <Kpi key={k} label={label} value={x?.customers ?? 0} hint={inr0(x?.spend ?? 0)} />;
        })}
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Win-back list" sub="Lapsed regulars who agreed to offers">{list(data.winBack)}</Card>
        <Card title="Top guests" sub="Phone numbers masked">{list(data.top)}</Card>
      </div>
    </>
  );
}

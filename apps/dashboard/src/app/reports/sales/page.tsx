'use client';

import { api, config, inr0, lakh } from '@/lib/api';
import { useRange } from '@/components/Range';
import { Bars, Card, Kpi, Loading, PageHeader, Table, useData } from '@/components/ui';

interface Overview {
  kpis: { netSalesPaise: number; grossSalesPaise: number; bills: number; avgBillPaise: number; guests: number; perCoverPaise: number; avgTableMinutes: number | null; taxPaise: number; refundsPaise: number };
  previous: { netSalesPaise: number; bills: number; avgBillPaise: number };
  daily: { day: string; net: number; bills: number }[];
  paymentMix: { method: string; net: number; count: number }[];
  topItems: { name: string; quantity: number; net: number }[];
  captains: { name: string; bills: number; net: number; guests: number; avgBill: number; avgTableMin: number | null }[];
}

const delta = (a: number, b: number) => (b ? `${a >= b ? '▲' : '▼'} ${Math.abs(((a - b) / b) * 100).toFixed(1)}% vs previous period` : 'no earlier data');

export default function SalesReport() {
  const r = useRange(30);
  const { data, error } = useData(async () => api<Overview>('analytics', `/analytics/overview?${r.q((await config()).outletId)}`), [r.from]);
  if (!data) return <Loading error={error} />;
  const k = data.kpis, p = data.previous;
  return (
    <>
      <PageHeader title="Sales" sub={`${r.from} to ${r.to} · paid bills`} right={r.chips} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Net sales (ex-GST)" value={lakh(k.netSalesPaise)} hint={delta(k.netSalesPaise, p.netSalesPaise)} tone={k.netSalesPaise >= p.netSalesPaise ? 'good' : 'bad'} />
        <Kpi label="Bills" value={k.bills.toLocaleString('en-IN')} hint={delta(k.bills, p.bills)} />
        <Kpi label="Average ticket" value={inr0(k.avgBillPaise)} hint={delta(k.avgBillPaise, p.avgBillPaise)} />
        <Kpi label="Guests" value={k.guests.toLocaleString('en-IN')} hint={`${inr0(k.perCoverPaise)} per guest`} />
        <Kpi label="Avg table time" value={k.avgTableMinutes == null ? '–' : `${k.avgTableMinutes} min`} />
        <Kpi label="GST collected" value={lakh(k.taxPaise)} hint={`refunds ${inr0(k.refundsPaise)}`} />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Net sales per day">
          <Bars rows={data.daily.map((d) => ({ label: new Date(d.day + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }), value: d.net, display: `${inr0(d.net)} · ${d.bills}` }))} />
        </Card>
        <div className="grid gap-4">
          <Card title="Payment mix"><Bars rows={data.paymentMix.map((m) => ({ label: m.method, value: m.net, display: lakh(m.net) }))} /></Card>
          <Card title="Top dishes"><Bars rows={data.topItems.map((i) => ({ label: i.name, value: i.net, display: `${lakh(i.net)} · ${i.quantity}` }))} /></Card>
          <Card title="Captain performance">
            <Table head={['Captain', 'Bills', 'Net sales', 'Guests', 'Avg bill', 'Table time']}>
              {data.captains.map((c) => (
                <tr key={c.name}><td>{c.name}</td><td>{c.bills}</td><td>{lakh(c.net)}</td><td>{c.guests}</td><td>{inr0(c.avgBill)}</td><td>{c.avgTableMin ?? '–'} min</td></tr>
              ))}
            </Table>
          </Card>
        </div>
      </div>
    </>
  );
}

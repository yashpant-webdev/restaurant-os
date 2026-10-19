'use client';

import { api, config, inr0, lakh } from '@/lib/api';
import { useRange } from '@/components/Range';
import { Card, Kpi, Loading, PageHeader, Table, useData } from '@/components/ui';

interface Pnl {
  statement: { netSalesPaise: number; refundsNetPaise: number; roundOffPaise: number; revenuePaise: number; cogsPaise: number; grossProfitPaise: number; paymentFeesPaise: number; expenses: { category: string; amount: number }[]; operatingProfitPaise: number };
  ratios: { foodCostPct: number | null; primeCostPct: number | null; operatingMarginPct: number | null };
  gst: { outputCgstPaise: number; outputSgstPaise: number; byRate: { rateBp: number; taxablePaise: number; taxPaise: number }[]; invoices: number };
  collections: { method: string; netPaise: number; feePaise: number }[];
  monthly: { month: string; net: number; cogs: number; expenses: number; profit: number }[];
}
const pct = (v: number | null) => (v == null ? '–' : `${v.toFixed(1)}%`);

export default function Finance() {
  const r = useRange(30);
  const { data, error } = useData(async () => api<Pnl>('analytics', `/analytics/pnl?${r.q((await config()).outletId)}`), [r.from]);
  if (!data) return <Loading error={error} />;
  const s = data.statement, net = s.netSalesPaise || 1;
  const row = (l: string, v: number, strong = false) => (
    <tr key={l} className={strong ? 'font-bold' : ''}><td>{l}</td><td className="text-right">{inr0(v)}</td><td className="text-right text-muted">{((v / net) * 100).toFixed(1)}%</td></tr>
  );
  return (
    <>
      <PageHeader title="Finance & GST" sub="Built automatically from every bill, refund and expense" right={r.chips} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Operating profit" value={lakh(s.operatingProfitPaise)} hint={`${pct(data.ratios.operatingMarginPct)} margin`} tone={s.operatingProfitPaise >= 0 ? 'good' : 'bad'} />
        <Kpi label="Food cost" value={pct(data.ratios.foodCostPct)} hint="target 28–35%" />
        <Kpi label="Prime cost" value={pct(data.ratios.primeCostPct)} hint="food + salaries · target < 65%" />
        <Kpi label="GST output" value={lakh(data.gst.outputCgstPaise + data.gst.outputSgstPaise)} hint={`${data.gst.invoices} invoices`} />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Profit & loss">
          <Table head={['Line', 'Amount', '% of sales']}>
            {row('Net sales (ex-GST)', s.netSalesPaise)}
            {row('Less: refunds', -s.refundsNetPaise)}
            {row('Round-off', s.roundOffPaise)}
            {row('Revenue', s.revenuePaise, true)}
            {row('Less: food cost', -s.cogsPaise)}
            {row('Gross profit', s.grossProfitPaise, true)}
            {row('Gateway fees (est.)', -s.paymentFeesPaise)}
            {s.expenses.map((e) => row(`Less: ${e.category.toLowerCase()}`, -e.amount))}
            {row('Operating profit', s.operatingProfitPaise, true)}
          </Table>
        </Card>
        <div className="grid gap-4">
          <Card title="GST summary">
            <Table head={['Rate', 'Taxable value', 'GST']}>
              {data.gst.byRate.map((g) => <tr key={g.rateBp}><td>{g.rateBp / 100}%</td><td>{inr0(g.taxablePaise)}</td><td>{inr0(g.taxPaise)}</td></tr>)}
              <tr className="font-bold"><td>CGST / SGST</td><td /><td>{inr0(data.gst.outputCgstPaise)} / {inr0(data.gst.outputSgstPaise)}</td></tr>
            </Table>
          </Card>
          <Card title="Collections">
            <Table head={['Method', 'Collected', 'Fee (est.)']}>
              {data.collections.map((c) => <tr key={c.method}><td>{c.method}</td><td>{inr0(c.netPaise)}</td><td>{inr0(c.feePaise)}</td></tr>)}
            </Table>
          </Card>
          <Card title="Month by month">
            <Table head={['Month', 'Net sales', 'Food cost', 'Expenses', 'Profit']}>
              {data.monthly.map((m) => <tr key={m.month}><td>{m.month}</td><td>{lakh(m.net)}</td><td>{lakh(m.cogs)}</td><td>{lakh(m.expenses)}</td><td className={m.profit >= 0 ? 'text-good' : 'text-bad'}>{lakh(m.profit)}</td></tr>)}
            </Table>
          </Card>
        </div>
      </div>
    </>
  );
}

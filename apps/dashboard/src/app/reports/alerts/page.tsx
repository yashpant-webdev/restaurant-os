'use client';

import { api, config, inr0 } from '@/lib/api';
import { useRange } from '@/components/Range';
import { Badge, Card, Kpi, Loading, PageHeader, Table, useData } from '@/components/ui';

interface Alerts { refundRatePct: number; bySeverity: { severity: string; count: number; amount: number }[]; items: { kind: string; severity: string; message: string; created_at: string }[] }
const TONE = { critical: 'bad', serious: 'bad', warning: 'warn', info: undefined } as const;

export default function AlertsPage() {
  const r = useRange(30);
  const { data, error } = useData(async () => api<Alerts>('analytics', `/analytics/alerts?${r.q((await config()).outletId)}`), [r.from]);
  if (!data) return <Loading error={error} />;
  const by = (s: string) => data.bySeverity.find((b) => b.severity === s);
  return (
    <>
      <PageHeader title="Alerts" sub="Unusual sales days, refunds, overpayments, late payments" right={r.chips} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {(['critical', 'serious', 'warning', 'info'] as const).map((s) => <Kpi key={s} label={s[0].toUpperCase() + s.slice(1)} value={by(s)?.count ?? 0} hint={`${inr0(by(s)?.amount ?? 0)} involved`} tone={TONE[s]} />)}
        <Kpi label="Refund rate" value={`${data.refundRatePct.toFixed(2)}%`} hint="watch if above 1%" />
      </div>
      <div className="mt-4">
        <Card title="What needs your attention">
          <Table head={['Severity', 'What happened', 'Type', 'When']}>
            {data.items.map((a, i) => (
              <tr key={i}>
                <td><Badge tone={TONE[a.severity as keyof typeof TONE]}>{a.severity}</Badge></td>
                <td>{a.message}</td><td className="text-xs text-muted">{a.kind}</td>
                <td className="whitespace-nowrap">{new Date(a.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}

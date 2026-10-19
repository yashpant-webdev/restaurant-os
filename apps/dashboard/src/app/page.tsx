'use client';

import { api, config, inr, inr0, istDay } from '@/lib/api';
import { Badge, Card, Kpi, Loading, PageHeader, useData } from '@/components/ui';

interface Floor {
  tables: { label: string; seats: number; status: string; order: { id: string; totalPaise: number; guests: number | null; openedAt: string; kotCount: number; captain: { name: string } | null } | null }[];
  summary: { free: number; occupied: number; billRequested: number; runningPaise: number; settledTodayCount: number; settledTodayPaise: number };
}
interface Activity { activityId: string; kind: string; message: string; at: string }
interface Staff { id: string; name: string; role: string; openTables: number; runningPaise: number; tables: string[] }

const STATUS: Record<string, { label: string; cls: string }> = {
  FREE: { label: 'Free', cls: 'border-transparent bg-panel-2 text-muted' },
  OCCUPIED: { label: 'Running', cls: 'border-ink bg-panel-2' },
  BILL_REQUESTED: { label: 'Bill asked', cls: 'border-ink bg-accent text-accent-ink' },
  PAYING: { label: 'Paying', cls: 'border-dashed border-ink bg-panel-2' },
};

/** The control room: what's happening right now, refreshed every few seconds. */
export default function LiveOverview() {
  const { data, error } = useData(async () => {
    const c = await config();
    const today = istDay(0);
    const [floor, activity, staff, sales] = await Promise.all([
      api<Floor>('order', `/floor?outletId=${c.outletId}`),
      api<Activity[]>('order', `/activity?outletId=${c.outletId}`),
      api<Staff[]>('order', `/staff?outletId=${c.outletId}`),
      api<{ kpis: { grossSalesPaise: number; bills: number; avgBillPaise: number; guests: number; refundsPaise: number } }>('analytics', `/analytics/overview?outletId=${c.outletId}&from=${today}&to=${today}`),
    ]);
    return { floor, activity, staff, sales };
  }, [], 5000);

  if (!data) return <Loading error={error} />;
  const { floor, activity, staff, sales } = data;
  const s = floor.summary;
  const cancelled = activity.filter((a) => a.kind === 'ORDER_CANCELLED').length;

  return (
    <>
      <PageHeader title="Live overview" sub="Updates every 5 seconds" right={<Badge tone="good">● live</Badge>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Gross sales today (paid)" value={inr0(sales.kpis.grossSalesPaise)} hint={`${s.settledTodayCount} bills settled`} />
        <Kpi label="Orders today" value={sales.kpis.bills} hint={`${sales.kpis.guests} guests`} />
        <Kpi label="Average ticket" value={inr0(sales.kpis.avgBillPaise)} />
        <Kpi label="Live tables" value={`${s.occupied} / ${s.occupied + s.free}`} hint={`${s.billRequested} waiting for the bill`} tone={s.billRequested ? 'warn' : undefined} />
        <Kpi label="Running (not yet paid)" value={inr0(s.runningPaise)} />
        <Kpi label="Cancellations today" value={cancelled} hint={`refunds ${inr0(sales.kpis.refundsPaise)}`} tone={cancelled ? 'bad' : undefined} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card title="Floor" sub="Each table with its status, bill and captain">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
            {floor.tables.map((t) => {
              const st = STATUS[t.status] ?? STATUS.FREE;
              return (
                <div key={t.label} className={`rounded-[var(--radius-inner)] border-[1.5px] p-3 text-sm ${st.cls}`}>
                  <div className="flex justify-between font-bold">
                    <span className="display text-base">{t.label}</span>
                    <span className="text-[11px] font-semibold">{st.label}</span>
                  </div>
                  {t.order ? (
                    <>
                      <div className="num display mt-1 text-lg font-bold">{inr(t.order.totalPaise)}</div>
                      <div className="text-xs opacity-75">
                        {t.order.guests ?? '–'} guests · {Math.round((Date.now() - +new Date(t.order.openedAt)) / 60000)} min · {t.order.kotCount} KOT
                      </div>
                      <div className="text-xs">Captain: {t.order.captain?.name ?? '—'}</div>
                    </>
                  ) : (
                    <div className="mt-1 text-xs text-muted">{t.seats} seats</div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        <div className="grid gap-4">
          <Card title="Captains on duty">
            {staff.filter((x) => x.role === 'CAPTAIN').map((c) => (
              <div key={c.id} className="flex justify-between border-b border-line py-1.5 text-sm last:border-0">
                <span>{c.name}</span>
                <span className="num text-muted">{c.openTables ? `${c.tables.join(', ')} · ${inr0(c.runningPaise)}` : 'no open tables'}</span>
              </div>
            ))}
          </Card>
          <Card title="Activity" sub="Every action from cashier, captain and kitchen">
            <div className="max-h-[360px] overflow-auto text-sm">
              {activity.length === 0 && <div className="text-muted">Nothing yet today.</div>}
              {activity.map((a) => (
                <div key={a.activityId} className="border-b border-line py-1.5 last:border-0">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-accent">{a.kind.replaceAll('_', ' ')}</span>{' '}
                  <span className="text-xs text-muted">{new Date(a.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                  <div>{a.message}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

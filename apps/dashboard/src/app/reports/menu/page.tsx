'use client';

import { api, config, inr } from '@/lib/api';
import { useRange } from '@/components/Range';
import { Badge, Card, Kpi, Loading, PageHeader, Table, useData } from '@/components/ui';

interface Menu {
  thresholds: { popularityMixPct: number; avgCmPerUnitPaise: number };
  items: { name: string; quantity: number; netPaise: number; avgPricePaise: number; cmPerUnitPaise: number | null; foodCostPct: number | null; mixPct: number; class: string }[];
}
const CLASS: Record<string, [string, string, 'good' | 'warn' | 'accent' | 'bad' | undefined]> = {
  STAR: ['Star', 'Popular and profitable: keep quality, give it prime placement.', 'good'],
  PLOWHORSE: ['Plowhorse', 'Popular, low margin: re-engineer the recipe cost or nudge the price.', 'warn'],
  PUZZLE: ['Puzzle', 'Profitable but rarely ordered: promote it.', 'accent'],
  DOG: ['Dog', 'Neither popular nor profitable: rework or remove.', 'bad'],
  NO_COST: ['No cost', 'Add a food cost to classify.', undefined],
};

export default function MenuEngineering() {
  const r = useRange(30);
  const { data, error } = useData(async () => api<Menu>('analytics', `/analytics/menu?${r.q((await config()).outletId)}`), [r.from]);
  if (!data) return <Loading error={error} />;
  const count = (c: string) => data.items.filter((i) => i.class === c).length;
  return (
    <>
      <PageHeader title="Menu engineering" sub="Popularity × profit per plate (Kasavana–Smith)" right={r.chips} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {['STAR', 'PLOWHORSE', 'PUZZLE', 'DOG'].map((c) => <Kpi key={c} label={CLASS[c][0] + 's'} value={count(c)} hint={CLASS[c][1]} />)}
      </div>
      <div className="mt-4">
        <Card title="Dishes" sub={`Popular = at least ${data.thresholds.popularityMixPct}% of items sold · profitable = at least ${inr(data.thresholds.avgCmPerUnitPaise)} per plate`}>
          <Table head={['Dish', 'Class', 'Sold', 'Share', 'Net sales', 'Avg price', 'Food cost', 'Profit / plate']}>
            {data.items.map((i) => (
              <tr key={i.name}>
                <td>{i.name}</td>
                <td><Badge tone={CLASS[i.class][2]}>{CLASS[i.class][0]}</Badge></td>
                <td>{i.quantity}</td><td>{i.mixPct}%</td><td>{inr(i.netPaise)}</td><td>{inr(i.avgPricePaise)}</td>
                <td>{i.foodCostPct == null ? '–' : `${i.foodCostPct}%`}</td><td>{i.cmPerUnitPaise == null ? '–' : inr(i.cmPerUnitPaise)}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}

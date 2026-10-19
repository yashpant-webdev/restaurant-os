'use client';

import { FormEvent } from 'react';
import { api, config, inr } from '@/lib/api';
import { Badge, Button, Card, Input, Loading, PageHeader, Table, useData, useToast } from '@/components/ui';

interface Floor { tables: { label: string; seats: number; status: string; order: { totalPaise: number; captain: { name: string } | null } | null }[] }

export default function TablesPage() {
  const { toast, node } = useToast();
  const { data, error, reload } = useData(async () => api<Floor>('order', `/floor?outletId=${(await config()).outletId}`), [], 10000);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const c = await config();
      await api('order', '/tables', { method: 'POST', body: { outletId: c.outletId, label: String(f.get('label')).trim(), seats: Number(f.get('seats')), sortOrder: data?.tables.length ?? 0 } });
      toast(`Table ${f.get('label')} added: it appears on every cashier and captain app`);
      (e.target as HTMLFormElement).reset();
      reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  }

  if (!data) return <Loading error={error} />;
  return (
    <>
      <PageHeader title="Tables & floor" sub={`${data.tables.length} tables · ${data.tables.reduce((s, t) => s + t.seats, 0)} seats`} />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card title="Tables">
          <Table head={['Table', 'Seats', 'Now', 'Bill', 'Captain']}>
            {data.tables.map((t) => (
              <tr key={t.label}>
                <td className="font-semibold">{t.label}</td>
                <td>{t.seats}</td>
                <td>{t.status === 'FREE' ? <Badge>Free</Badge> : <Badge tone="accent">{t.status.replace('_', ' ').toLowerCase()}</Badge>}</td>
                <td>{t.order ? inr(t.order.totalPaise) : '—'}</td>
                <td>{t.order?.captain?.name ?? '—'}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Add table" sub="Areas (AC hall, terrace) and a drag-and-drop floor plan come next.">
          <form onSubmit={add} className="grid gap-3">
            <Input name="label" label="Table name" placeholder="T11" required maxLength={20} />
            <Input name="seats" label="Seats" type="number" min={1} max={30} defaultValue={4} required />
            <Button type="submit">Add table</Button>
          </form>
        </Card>
      </div>
      {node}
    </>
  );
}

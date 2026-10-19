'use client';

import { FormEvent, useState } from 'react';
import { api, config, inr } from '@/lib/api';
import { Badge, Button, Card, Input, Loading, PageHeader, Select, Table, useData, useToast } from '@/components/ui';

interface Item {
  id: string;
  name: string;
  category: string | null;
  shortCode: string | null;
  foodType: 'VEG' | 'NON_VEG' | 'EGG';
  pricePaise: number;
  gstRateBp: number;
  costPaise: number | null;
  isAvailable: boolean;
  isActive: boolean;
}

const FOOD = { VEG: ['Veg', 'good'], NON_VEG: ['Non-veg', 'bad'], EGG: ['Egg', 'warn'] } as const;
const paise = (rupees: string) => Math.round(Number(rupees) * 100);

/** Central menu: add, edit, switch items on/off. Changes reach every cashier and captain app on their next sync. */
export default function MenuPage() {
  const { toast, node } = useToast();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Item | null>(null);
  const { data: items, error, reload } = useData(async () => {
    const c = await config();
    return api<Item[]>('order', `/menu-items?outletId=${c.outletId}&includeInactive=true`);
  });

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      name: String(f.get('name')),
      category: String(f.get('category') || '') || undefined,
      shortCode: String(f.get('shortCode') || '') || undefined,
      foodType: String(f.get('foodType')),
      pricePaise: paise(String(f.get('price'))),
      gstRateBp: Number(f.get('gst')),
      costPaise: f.get('cost') ? paise(String(f.get('cost'))) : undefined,
    };
    try {
      if (editing) {
        await api('order', `/menu-items/${editing.id}`, { method: 'PATCH', body: { ...body, category: body.category ?? null, shortCode: body.shortCode ?? null, costPaise: body.costPaise ?? null } });
        toast(`${body.name} updated`);
      } else {
        const c = await config();
        await api('order', '/menu-items', { method: 'POST', body: { ...body, outletId: c.outletId } });
        toast(`${body.name} added`);
      }
      setEditing(null);
      (e.target as HTMLFormElement).reset();
      reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  }

  async function toggle(i: Item) {
    try {
      await api('order', `/menu-items/${i.id}/availability`, { method: 'POST', body: { isAvailable: !i.isAvailable } });
      toast(`${i.name} ${i.isAvailable ? 'marked sold out' : 'back in stock'}`);
      reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  }

  async function archive(i: Item) {
    if (!confirm(`Remove ${i.name} from the menu? Past bills keep it.`)) return;
    await api('order', `/menu-items/${i.id}`, { method: 'PATCH', body: { isActive: false } }).then(reload, (e) => toast(e.message, true));
  }

  if (!items) return <Loading error={error} />;
  const shown = items.filter((i) => i.isActive && (!q || `${i.name} ${i.shortCode ?? ''} ${i.category ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const cats = [...new Set(items.map((i) => i.category).filter(Boolean))] as string[];

  return (
    <>
      <PageHeader title="Menu" sub={`${shown.length} items · ${items.filter((i) => i.isActive && !i.isAvailable).length} sold out`} />
      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <Card title="Items" right={<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, category" className="rounded-full border-[1.5px] border-transparent bg-panel-2 px-4 py-2 text-sm outline-none focus:border-ink" />}>
          <Table head={['Item', 'Code', 'Category', 'Price', 'GST', 'Food cost', 'Status', '']}>
            {shown.map((i) => (
              <tr key={i.id}>
                <td>
                  <div className="flex items-center gap-2">
                    <Badge tone={FOOD[i.foodType][1]}>{FOOD[i.foodType][0]}</Badge>
                    {i.name}
                  </div>
                </td>
                <td className="font-mono text-xs">{i.shortCode ?? '—'}</td>
                <td>{i.category ?? '—'}</td>
                <td>{inr(i.pricePaise)}</td>
                <td>{i.gstRateBp / 100}%</td>
                <td>{i.costPaise == null ? '—' : `${inr(i.costPaise)} (${Math.round((i.costPaise / i.pricePaise) * 100)}%)`}</td>
                <td>
                  <button onClick={() => toggle(i)} className="cursor-pointer" title="Switch on/off everywhere">
                    {i.isAvailable ? <Badge tone="good">On</Badge> : <Badge tone="bad">Sold out</Badge>}
                  </button>
                </td>
                <td className="whitespace-nowrap text-right">
                  <Button small variant="ghost" onClick={() => setEditing(i)}>Edit</Button>{' '}
                  <Button small variant="danger" onClick={() => archive(i)}>Remove</Button>
                </td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title={editing ? `Edit ${editing.name}` : 'Add item'} sub="Prices include no tax; GST is added on the bill.">
          <form key={editing?.id ?? 'new'} onSubmit={save} className="grid gap-3">
            <Input name="name" label="Name" required defaultValue={editing?.name} maxLength={120} />
            <div className="grid grid-cols-2 gap-3">
              <Input name="shortCode" label="Short code" defaultValue={editing?.shortCode ?? ''} placeholder="CB" maxLength={8} className="uppercase" />
              <Input name="category" label="Category" list="cats" defaultValue={editing?.category ?? ''} placeholder="Mains" />
              <datalist id="cats">{cats.map((c) => <option key={c} value={c} />)}</datalist>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input name="price" label="Price (₹)" type="number" step="0.01" min="0" required defaultValue={editing ? editing.pricePaise / 100 : ''} />
              <Input name="cost" label="Food cost (₹)" type="number" step="0.01" min="0" defaultValue={editing?.costPaise != null ? editing.costPaise / 100 : ''} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Select name="gst" label="GST" defaultValue={editing?.gstRateBp ?? 500}>
                {[0, 500, 1200, 1800, 2800].map((g) => <option key={g} value={g}>{g / 100}%</option>)}
              </Select>
              <Select name="foodType" label="Type" defaultValue={editing?.foodType ?? 'VEG'}>
                <option value="VEG">Veg</option>
                <option value="NON_VEG">Non-veg</option>
                <option value="EGG">Egg</option>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button type="submit">{editing ? 'Save changes' : 'Add item'}</Button>
              {editing && <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>}
            </div>
            <p className="text-xs text-muted">Old bills keep the name and price they were billed with. Variants, add-ons and per-area prices come with the catalog upgrade.</p>
          </form>
        </Card>
      </div>
      {node}
    </>
  );
}

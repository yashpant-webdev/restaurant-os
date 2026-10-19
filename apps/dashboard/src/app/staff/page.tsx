'use client';

import { FormEvent } from 'react';
import { api, config, inr0 } from '@/lib/api';
import { Badge, Button, Card, Input, Loading, PageHeader, Select, Table, useData, useToast } from '@/components/ui';

interface Staff { id: string; name: string; role: string; isActive: boolean; openTables: number; runningPaise: number; tables: string[] }

/** Staff and roles. What each role may do (discount limits, voids…) is enforced by the backend. */
export default function StaffPage() {
  const { toast, node } = useToast();
  const { data, error, reload } = useData(async () => api<Staff[]>('order', `/staff?outletId=${(await config()).outletId}&includeInactive=true`), [], 10000);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const c = await config();
      await api('order', '/staff', { method: 'POST', body: { outletId: c.outletId, name: String(f.get('name')).trim(), role: String(f.get('role')) } });
      toast(`${f.get('name')} added`);
      (e.target as HTMLFormElement).reset();
      reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  }

  async function remove(s: Staff) {
    if (!confirm(`Remove ${s.name}? Their app sign-in stops working immediately.`)) return;
    try {
      await api('order', `/staff/${s.id}`, { method: 'DELETE' });
      toast(`${s.name} removed`);
      reload();
    } catch (err) {
      const e = err as Error & { details?: { tables?: string[] } };
      toast(e.details?.tables ? `${e.message} (${e.details.tables.join(', ')})` : e.message, true);
    }
  }

  if (!data) return <Loading error={error} />;
  const active = data.filter((s) => s.isActive);
  return (
    <>
      <PageHeader title="Staff & captains" sub={`${active.length} active`} />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card title="People">
          <Table head={['Name', 'Role', 'Open tables', 'Running', 'Status', '']}>
            {data.map((s) => (
              <tr key={s.id} className={s.isActive ? '' : 'opacity-50'}>
                <td className="font-semibold">{s.name}</td>
                <td>{s.role[0] + s.role.slice(1).toLowerCase()}</td>
                <td>{s.openTables ? s.tables.join(', ') : '—'}</td>
                <td>{s.openTables ? inr0(s.runningPaise) : '—'}</td>
                <td>{s.isActive ? <Badge tone="good">Active</Badge> : <Badge>Removed</Badge>}</td>
                <td className="text-right">{s.isActive && <Button small variant="danger" onClick={() => remove(s)}>Remove</Button>}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Add staff" sub="They sign in to the cashier or captain app with their name and PIN.">
          <form onSubmit={add} className="grid gap-3">
            <Input name="name" label="Name" required maxLength={60} />
            <Select name="role" label="Role" defaultValue="CAPTAIN">
              <option value="CAPTAIN">Captain (takes orders)</option>
              <option value="CASHIER">Cashier (bills and payments)</option>
              <option value="MANAGER">Manager (approvals, reports)</option>
            </Select>
            <Button type="submit">Add</Button>
            <p className="text-xs text-muted">Per-person permissions (discount limit, voids, complimentary bills, after-settlement edits) and PINs come with the identity service.</p>
          </form>
        </Card>
      </div>
      {node}
    </>
  );
}

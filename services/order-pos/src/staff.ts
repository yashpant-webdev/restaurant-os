import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { EventPayload, Topics } from '@ros/contracts';
import {
  assertOutletAccess,
  assertRole,
  ConflictError,
  Database,
  enqueueEvent,
  ForbiddenError,
  newId,
  NotFoundError,
  OutboxRelay,
  Principal,
  Tx,
} from '@ros/common';

export const STAFF_DB = Symbol('STAFF_DB');
export const STAFF_RELAY = Symbol('STAFF_RELAY');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CreateStaffInput = z
  .object({
    outletId: z.string().uuid(),
    name: z.string().trim().min(1).max(60),
    role: z.enum(['CAPTAIN', 'CASHIER', 'MANAGER']).default('CAPTAIN'),
    phone: z.string().regex(/^[6-9][0-9]{9}$/, 'must be a 10-digit Indian mobile number').optional(),
  })
  .strict();

export interface StaffRow {
  id: string;
  outlet_id: string;
  name: string;
  role: 'CAPTAIN' | 'CASHIER' | 'MANAGER';
  phone: string | null;
  is_active: boolean;
}

export interface Actor {
  id: string;
  name: string;
  /** Set when the person acting is a captain: orders they open belong to them. */
  captain: { id: string; name: string } | null;
}

/**
 * Who is acting. A staff member's token subject is their staff id. A captain
 * whose account was removed is refused here even if their token has not expired
 * yet, so removing a captain takes effect immediately on every phone.
 */
export async function resolveActor(tx: Tx, p: Principal): Promise<Actor> {
  const staff = UUID_RE.test(p.userId)
    ? (await tx.query<StaffRow>('SELECT * FROM staff WHERE id = $1', [p.userId])).rows[0]
    : undefined;
  if (p.roles.includes('captain') && !p.roles.some((r) => r === 'owner' || r === 'manager' || r === 'cashier')) {
    if (!staff || staff.role !== 'CAPTAIN') throw new ForbiddenError('Not a registered captain at this outlet');
    if (!staff.is_active) throw new ForbiddenError('This captain account has been removed');
    return { id: staff.id, name: staff.name, captain: { id: staff.id, name: staff.name } };
  }
  if (staff && !staff.is_active) throw new ForbiddenError('This staff account has been removed');
  return { id: p.userId, name: staff?.name ?? p.userId, captain: null };
}

/** An active captain at the outlet (used when a cashier assigns or transfers a table). */
export async function activeCaptain(tx: Tx, outletId: string, captainId: string): Promise<{ id: string; name: string }> {
  const { rows } = await tx.query<StaffRow>(
    `SELECT * FROM staff WHERE id = $1 AND outlet_id = $2 AND role = 'CAPTAIN' AND is_active`,
    [captainId, outletId],
  );
  if (!rows[0]) throw new NotFoundError('Active captain');
  return { id: rows[0].id, name: rows[0].name };
}

type ActivityKind = EventPayload<typeof Topics.ActivityRecorded>['kind'];

/**
 * Appends to the activity log and publishes it (same transaction, via the
 * outbox). Screens subscribed to the outlet get it pushed within moments;
 * if a screen was offline it reloads the log when it reconnects.
 */
export async function recordActivity(
  tx: Tx,
  tenantId: string,
  a: { outletId: string; kind: ActivityKind; actor: Actor; message: string; orderId?: string | null; tableRef?: string | null; captainId?: string | null },
): Promise<void> {
  const id = newId();
  const at = new Date().toISOString();
  await tx.query(
    `INSERT INTO activity (id, tenant_id, outlet_id, kind, order_id, table_ref, captain_id, actor_id, actor_name, message, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, tenantId, a.outletId, a.kind, a.orderId ?? null, a.tableRef ?? null, a.captainId ?? null, a.actor.id, a.actor.name, a.message, at],
  );
  await enqueueEvent(tx, Topics.ActivityRecorded, tenantId, a.outletId, {
    activityId: id,
    outletId: a.outletId,
    kind: a.kind,
    orderId: a.orderId ?? null,
    tableRef: a.tableRef ?? null,
    captainId: a.captainId ?? null,
    actorId: a.actor.id,
    actorName: a.actor.name,
    message: a.message,
    at,
  });
}

@Injectable()
export class StaffService {
  constructor(
    @Inject(STAFF_DB) private readonly db: Database,
    @Inject(STAFF_RELAY) private readonly relay: OutboxRelay,
  ) {}

  /** Staff with their live load: open tables and running bill amount. */
  async list(p: Principal, outletId: string, includeInactive = false) {
    assertOutletAccess(p, outletId);
    return this.db.tx(
      async (tx) =>
        (
          await tx.query(
            `SELECT s.id, s.name, s.role, s.is_active AS "isActive", s.created_at AS "createdAt",
                    COUNT(o.id)::int AS "openTables", COALESCE(SUM(o.total_paise), 0)::bigint AS "runningPaise",
                    COALESCE(array_agg(o.table_ref ORDER BY o.table_ref) FILTER (WHERE o.id IS NOT NULL), '{}') AS tables
               FROM staff s LEFT JOIN orders o ON o.captain_id = s.id AND o.status = 'OPEN'
              WHERE s.outlet_id = $1 AND ($2 OR s.is_active)
              GROUP BY s.id ORDER BY s.is_active DESC, s.role, s.name`,
            [outletId, includeInactive],
          )
        ).rows,
      { tenantId: p.tenantId },
    );
  }

  /** Cashiers may add captains; only managers and owners may add cashiers or managers. */
  async create(p: Principal, input: z.infer<typeof CreateStaffInput>) {
    assertOutletAccess(p, input.outletId);
    if (input.role !== 'CAPTAIN') assertRole(p, 'owner', 'manager');
    const id = newId();
    try {
      await this.db.tx(
        async (tx) => {
          const actor = await resolveActor(tx, p);
          await tx.query(`INSERT INTO staff (id, tenant_id, outlet_id, name, role, phone, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
            id, p.tenantId, input.outletId, input.name, input.role, input.phone ?? null, actor.id,
          ]);
          await recordActivity(tx, p.tenantId, { outletId: input.outletId, kind: 'STAFF_ADDED', actor, message: `${actor.name} added ${input.role.toLowerCase()} ${input.name}` });
        },
        { tenantId: p.tenantId },
      );
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'staff_active_name_uq') throw new ConflictError('STAFF_NAME_TAKEN', `${input.name} already works here`);
      throw err;
    }
    this.relay.nudge();
    return { id, ...input, isActive: true };
  }

  /**
   * Removes (deactivates) a staff member. History keeps their name on past
   * orders. A captain who still has open tables can't be removed until those
   * tables are moved to someone else, so no table is left without an owner.
   */
  async remove(p: Principal, staffId: string) {
    const result = await this.db.tx(
      async (tx) => {
        const { rows } = await tx.query<StaffRow>('SELECT * FROM staff WHERE id = $1 FOR UPDATE', [staffId]);
        const s = rows[0];
        if (!s) throw new NotFoundError('Staff member');
        assertOutletAccess(p, s.outlet_id);
        if (s.role !== 'CAPTAIN') assertRole(p, 'owner', 'manager');
        if (!s.is_active) return s;
        if (s.id === p.userId) throw new ConflictError('CANNOT_REMOVE_SELF', 'You cannot remove your own account');
        const { rows: open } = await tx.query<{ table_ref: string }>(`SELECT table_ref FROM orders WHERE captain_id = $1 AND status = 'OPEN' ORDER BY table_ref`, [staffId]);
        if (open.length) {
          throw new ConflictError('CAPTAIN_HAS_OPEN_TABLES', `${s.name} still has open tables: move them to another captain first`, { tables: open.map((o) => o.table_ref) });
        }
        const actor = await resolveActor(tx, p);
        await tx.query('UPDATE staff SET is_active = false, deactivated_at = now(), deactivated_by = $2 WHERE id = $1', [staffId, actor.id]);
        // captainId names who was removed, so their phone can sign out the moment this arrives.
        await recordActivity(tx, p.tenantId, { outletId: s.outlet_id, kind: 'STAFF_REMOVED', actor, captainId: s.id, message: `${actor.name} removed ${s.role.toLowerCase()} ${s.name}` });
        return { ...s, is_active: false };
      },
      { tenantId: p.tenantId },
    );
    this.relay.nudge();
    return { id: result.id, name: result.name, role: result.role, isActive: false };
  }

  async activity(p: Principal, outletId: string) {
    assertOutletAccess(p, outletId);
    return this.db.tx(
      async (tx) =>
        (
          await tx.query(
            `SELECT id AS "activityId", outlet_id AS "outletId", kind, order_id AS "orderId", table_ref AS "tableRef", captain_id AS "captainId",
                    actor_id AS "actorId", actor_name AS "actorName", message, created_at AS at
               FROM activity WHERE outlet_id = $1 ORDER BY created_at DESC LIMIT 50`,
            [outletId],
          )
        ).rows,
      { tenantId: p.tenantId },
    );
  }
}

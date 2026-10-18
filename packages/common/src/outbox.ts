import { v7 as uuidv7 } from 'uuid';
import { EventEnvelope, EventPayload, EventSchemas, Topic } from '@ros/contracts';
import type { EventBus } from './bus';
import { Database, sleep, Tx } from './db';
import type { Logger } from './logger';

export const newId = (): string => uuidv7();

/**
 * Transactional outbox. Call inside the SAME transaction that changes business
 * data: either both the state change and the event are committed, or neither.
 * This removes the classic "DB updated but event lost" (or vice versa) bug.
 */
export async function enqueueEvent<T extends Topic>(
  tx: Tx,
  topic: T,
  tenantId: string,
  key: string,
  payload: EventPayload<T>,
): Promise<string> {
  const valid = EventSchemas[topic].parse(payload); // never emit an event that breaks the contract
  const envelope: EventEnvelope = {
    eventId: newId(),
    type: topic,
    version: 1,
    occurredAt: new Date().toISOString(),
    tenantId,
    key,
    payload: valid,
  };
  await tx.query(
    `INSERT INTO outbox (event_id, topic, key, tenant_id, envelope) VALUES ($1, $2, $3, $4, $5)`,
    [envelope.eventId, topic, key, tenantId, JSON.stringify(envelope)],
  );
  return envelope.eventId;
}

/**
 * Publishes committed outbox rows to the bus. Safe to run in every replica:
 * `FOR UPDATE SKIP LOCKED` hands each row to exactly one relay at a time.
 * A failed publish stops the batch (preserving order) and backs off; nothing
 * is ever dropped. The loop catches everything, so a broker outage degrades
 * to "events delayed" and never crashes the service.
 */
export class OutboxRelay {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly opts: { batchSize?: number; idleMs?: number } = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Ask the relay to poll now (called after a commit, to cut latency). */
  nudge(): void {
    this.wake?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    let errorBackoff = 100;
    while (this.running) {
      try {
        const published = await this.pollOnce();
        errorBackoff = 100;
        if (published === 0) await this.idle(this.opts.idleMs ?? 500);
      } catch (err) {
        this.log.error({ err }, 'outbox relay poll failed');
        await this.idle(errorBackoff);
        errorBackoff = Math.min(errorBackoff * 2, 30_000);
      }
    }
  }

  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = done;
    });
  }

  async pollOnce(): Promise<number> {
    return this.db.tx(async (tx) => {
      const { rows } = await tx.query<{ id: string; topic: string; envelope: EventEnvelope; attempts: number }>(
        `SELECT id, topic, envelope, attempts FROM outbox
          WHERE published_at IS NULL AND next_attempt_at <= now()
          ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [this.opts.batchSize ?? 100],
      );
      let published = 0;
      for (const row of rows) {
        try {
          await this.bus.publish(row.topic, row.envelope);
          await tx.query('UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE id = $1', [row.id]);
          published++;
        } catch (err) {
          const delayMs = Math.min(1000 * 2 ** row.attempts, 5 * 60_000);
          await tx.query(
            `UPDATE outbox SET attempts = attempts + 1, last_error = $2,
               next_attempt_at = now() + ($3 || ' milliseconds')::interval WHERE id = $1`,
            [row.id, String((err as Error).message).slice(0, 500), String(delayMs)],
          );
          this.log.warn({ err, outboxId: row.id, attempts: row.attempts + 1 }, 'event publish failed; will retry');
          break;
        }
      }
      return published;
    });
  }
}

export { sleep };

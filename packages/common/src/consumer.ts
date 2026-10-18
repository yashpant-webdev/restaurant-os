import { EventEnvelope, EventPayload, EventSchemas, Topic } from '@ros/contracts';
import type { EventBus } from './bus';
import { Database, sleep, Tx } from './db';
import type { Logger } from './logger';

export interface ConsumerOptions {
  /** Attempts before the message is parked in dead_letters. */
  maxAttempts?: number;
}

/**
 * Registers an exactly-once-effect consumer:
 * 1. The envelope and payload are validated. Invalid ("poison") messages go
 *    straight to dead_letters instead of blocking the partition forever.
 * 2. The event id is inserted into `inbox` in the same transaction as the
 *    handler's writes. A redelivered event hits the primary key and is skipped.
 * 3. Transient failures are retried with backoff; after `maxAttempts` the
 *    message is dead-lettered and an error is logged for alerting, so one bad
 *    event cannot stop all payments behind it.
 */
export async function registerConsumer<T extends Topic>(
  bus: EventBus,
  db: Database,
  log: Logger,
  consumer: string,
  topic: T,
  handler: (tx: Tx, payload: EventPayload<T>, envelope: EventEnvelope) => Promise<void>,
  opts: ConsumerOptions = {},
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 5;

  await bus.subscribe(topic, consumer, async (raw) => {
    const envelope = EventEnvelope.safeParse(raw);
    const payload = envelope.success ? EventSchemas[topic].safeParse(envelope.data.payload) : undefined;
    if (!envelope.success || !payload?.success) {
      await deadLetter(db, consumer, topic, raw, 'schema validation failed', 0);
      log.error({ consumer, topic }, 'invalid event dead-lettered');
      return;
    }
    const env = envelope.data;

    for (let attempt = 1; ; attempt++) {
      try {
        await db.tx(
          async (tx) => {
            const { rowCount } = await tx.query(
              'INSERT INTO inbox (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [consumer, env.eventId],
            );
            if (rowCount === 0) return; // duplicate delivery: already applied
            await handler(tx, payload.data as EventPayload<T>, env);
          },
          { tenantId: env.tenantId },
        );
        return;
      } catch (err) {
        if (attempt >= maxAttempts) {
          await deadLetter(db, consumer, topic, env, String((err as Error).message), attempt);
          log.error({ err, consumer, eventId: env.eventId }, 'event dead-lettered after retries');
          return;
        }
        log.warn({ err, consumer, eventId: env.eventId, attempt }, 'event handler failed; retrying');
        await sleep(Math.min(100 * 2 ** attempt, 5_000));
      }
    }
  });
}

async function deadLetter(db: Database, consumer: string, topic: string, envelope: unknown, error: string, attempts: number) {
  const eventId = (envelope as { eventId?: unknown })?.eventId;
  await db.query(
    `INSERT INTO dead_letters (consumer, topic, event_id, envelope, error, attempts) VALUES ($1, $2, $3, $4, $5, $6)`,
    [consumer, topic, typeof eventId === 'string' ? eventId : null, JSON.stringify(envelope ?? null), error.slice(0, 1000), attempts],
  );
}

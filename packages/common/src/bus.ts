import { Kafka, logLevel, Producer, Consumer } from 'kafkajs';
import type { EventEnvelope } from '@ros/contracts';
import type { Logger } from './logger';
import { sleep } from './db';

export type EventHandler = (envelope: EventEnvelope) => Promise<void>;

/**
 * Transport for domain events. Production uses Kafka/Redpanda; development and
 * tests use an in-process bus with the same at-least-once semantics.
 * Services never publish directly: they write to their outbox, and the
 * relay calls `publish`. Handlers must be idempotent (see consumer.ts).
 */
export interface EventBus {
  publish(topic: string, envelope: EventEnvelope): Promise<void>;
  subscribe(topic: string, group: string, handler: EventHandler): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * In-process bus. Each (topic, group) subscription has its own queue that is
 * drained sequentially, preserving order the way a single Kafka partition does.
 * A handler that throws gets the message redelivered (the consumer wrapper
 * bounds retries and dead-letters poison messages).
 */
export class InMemoryEventBus implements EventBus {
  private readonly subs = new Map<string, { group: string; handler: EventHandler; queue: EventEnvelope[]; running: boolean }[]>();
  private readonly idleWaiters: (() => void)[] = [];
  private stopped = false;

  constructor(private readonly log: Logger) {}

  async publish(topic: string, envelope: EventEnvelope): Promise<void> {
    if (this.stopped) throw new Error('bus stopped');
    const copy = JSON.parse(JSON.stringify(envelope)) as EventEnvelope; // like a real broker: no shared references
    for (const sub of this.subs.get(topic) ?? []) {
      sub.queue.push(copy);
      void this.drain(sub);
    }
  }

  async subscribe(topic: string, group: string, handler: EventHandler): Promise<void> {
    const list = this.subs.get(topic) ?? [];
    list.push({ group, handler, queue: [], running: false });
    this.subs.set(topic, list);
  }

  private async drain(sub: { handler: EventHandler; queue: EventEnvelope[]; running: boolean; group: string }) {
    if (sub.running) return;
    sub.running = true;
    try {
      while (sub.queue.length && !this.stopped) {
        const msg = sub.queue[0]!;
        try {
          await sub.handler(msg);
          sub.queue.shift();
        } catch (err) {
          this.log.warn({ err, group: sub.group, eventId: msg.eventId }, 'handler failed; redelivering');
          await sleep(50);
        }
      }
    } finally {
      sub.running = false;
      if (this.isIdle()) this.idleWaiters.splice(0).forEach((r) => r());
    }
  }

  private isIdle(): boolean {
    for (const list of this.subs.values()) for (const s of list) if (s.running || s.queue.length) return false;
    return true;
  }

  /** Test helper: resolves when every queue is empty. */
  async waitForIdle(): Promise<void> {
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async start(): Promise<void> {
    this.stopped = false;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

/**
 * Kafka / Redpanda bus. The producer is idempotent with acks=all, so broker
 * retries never create duplicates and a publish only succeeds once replicated.
 * Offsets are committed only after the handler resolves (at-least-once).
 */
export class KafkaEventBus implements EventBus {
  private readonly kafka: Kafka;
  private producer?: Producer;
  private readonly consumers: Consumer[] = [];
  private readonly pending: { topic: string; group: string; handler: EventHandler }[] = [];

  constructor(brokers: string[], clientId: string, private readonly log: Logger) {
    this.kafka = new Kafka({ clientId, brokers, logLevel: logLevel.WARN, retry: { retries: 8 } });
  }

  async publish(topic: string, envelope: EventEnvelope): Promise<void> {
    if (!this.producer) throw new Error('kafka producer not started');
    await this.producer.send({
      topic,
      acks: -1,
      messages: [
        {
          key: envelope.key,
          value: JSON.stringify(envelope),
          headers: { 'event-id': envelope.eventId, 'event-type': envelope.type, 'tenant-id': envelope.tenantId },
        },
      ],
    });
  }

  async subscribe(topic: string, group: string, handler: EventHandler): Promise<void> {
    this.pending.push({ topic, group, handler });
  }

  async start(): Promise<void> {
    this.producer = this.kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    await this.producer.connect();
    for (const { topic, group, handler } of this.pending) {
      const consumer = this.kafka.consumer({ groupId: group, sessionTimeout: 30_000 });
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });
      await consumer.run({
        autoCommit: true,
        eachMessage: async ({ message }) => {
          if (!message.value) return;
          let envelope: EventEnvelope;
          try {
            envelope = JSON.parse(message.value.toString()) as EventEnvelope;
          } catch (err) {
            this.log.error({ err, topic }, 'unparseable kafka message skipped');
            return;
          }
          await handler(envelope); // throwing makes kafkajs retry the message
        },
      });
      this.consumers.push(consumer);
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.consumers.map((c) => c.disconnect()));
    await this.producer?.disconnect();
  }
}

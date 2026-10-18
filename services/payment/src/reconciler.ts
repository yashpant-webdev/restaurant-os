import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Database, Logger, LOGGER } from '@ros/common';
import { PaymentsService, WORKER_DB } from './payments.service';
import { WebhooksService } from './webhooks.service';

export const RECONCILER_OPTS = Symbol('RECONCILER_OPTS');
export interface ReconcilerOptions {
  intervalMs: number;
  /** Pending payments older than this with no capture at the gateway are marked FAILED (EXPIRED). */
  pendingTimeoutMs: number;
}

/**
 * Safety net for everything the happy path can miss: lost webhooks, timeouts
 * while creating gateway orders, refunds with unknown outcome. It asks the
 * gateway for the truth and applies it through the same idempotent functions.
 * Runs in every replica; all operations are idempotent and row-locked.
 * Errors are logged per item, so one bad payment can't stop the rest.
 */
@Injectable()
export class Reconciler implements OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    @Inject(WORKER_DB) private readonly db: Database,
    private readonly payments: PaymentsService,
    private readonly webhooks: WebhooksService,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(RECONCILER_OPTS) private readonly opts: ReconcilerOptions,
  ) {}

  start(): void {
    if (this.opts.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      if (!this.running) this.running = this.runOnce().finally(() => (this.running = undefined));
    }, this.opts.intervalMs);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  async runOnce(): Promise<void> {
    const actor = 'reconciler';
    await this.webhooks.retryUnprocessed().catch((err) => this.log.error({ err }, 'webhook retry pass failed'));

    const expireBefore = new Date(Date.now() - this.opts.pendingTimeoutMs);
    const pending = await this.db.query<{ id: string }>(
      `SELECT id FROM payments WHERE status = 'PENDING' AND gateway <> 'cash'
        AND updated_at < now() - interval '60 seconds' ORDER BY created_at LIMIT 100`,
    );
    for (const p of pending) {
      try {
        await this.payments.syncFromGateway(p.id, actor, { expireBefore });
      } catch (err) {
        this.log.warn({ err, paymentId: p.id }, 'reconcile payment failed');
      }
    }

    const refunds = await this.db.query<{ id: string }>(
      `SELECT id FROM refunds WHERE status = 'PENDING' AND created_at < now() - interval '2 minutes' ORDER BY created_at LIMIT 100`,
    );
    for (const r of refunds) {
      try {
        await this.payments.syncRefund(r.id, actor);
      } catch (err) {
        this.log.warn({ err, refundId: r.id }, 'reconcile refund failed');
      }
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { Database, Logger, LOGGER, ValidationError } from '@ros/common';
import { GATEWAY, PaymentsService, WORKER_DB } from './payments.service';
import { PaymentGateway } from './gateway/gateway';

const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Webhook intake: verify signature → store durably (dedup by event id) →
 * process. If processing fails we still answer 200 because the event is safely
 * stored; the retry loop and reconciler finish the job. This keeps the
 * gateway from hammering us with retries during an incident.
 */
@Injectable()
export class WebhooksService {
  constructor(
    @Inject(WORKER_DB) private readonly db: Database,
    @Inject(GATEWAY) private readonly gateway: PaymentGateway,
    private readonly payments: PaymentsService,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  async receive(rawBody: Buffer | undefined, signature: string | undefined, eventId: string | undefined): Promise<{ status: string }> {
    if (!rawBody || !signature || !this.gateway.verifyWebhookSignature(rawBody, signature)) {
      this.log.warn({ eventId }, 'webhook rejected: bad signature');
      throw new ValidationError('Invalid signature');
    }
    if (!eventId || !EVENT_ID_RE.test(eventId)) throw new ValidationError('Missing event id');
    let body: { event?: unknown };
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new ValidationError('Malformed body');
    }
    const inserted = await this.db.query(
      `INSERT INTO webhook_events (event_id, gateway, event_type, payload) VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [eventId, this.gateway.name, String(body.event ?? 'unknown').slice(0, 100), rawBody.toString('utf8')],
    );
    if (!inserted.length) {
      const [prev] = await this.db.query<{ processed_at: Date | null }>('SELECT processed_at FROM webhook_events WHERE event_id = $1', [eventId]);
      if (prev?.processed_at) return { status: 'duplicate' };
    }
    await this.process(eventId);
    return { status: 'accepted' };
  }

  /** Processes one stored event. Never throws: failures are recorded for the retry loop. */
  async process(eventId: string): Promise<boolean> {
    const [row] = await this.db.query<{ payload: unknown; attempts: number }>(
      'UPDATE webhook_events SET attempts = attempts + 1 WHERE event_id = $1 AND processed_at IS NULL RETURNING payload, attempts',
      [eventId],
    );
    if (!row) return true;
    try {
      const evt = this.gateway.parseWebhook(row.payload);
      switch (evt.kind) {
        case 'payment.captured':
          await this.payments.applyCapture(evt, `webhook:${this.gateway.name}`);
          break;
        case 'payment.failed':
          // A failed ATTEMPT. The customer can retry on the same gateway order, so we
          // don't fail the payment here; expiry is decided by the reconciler.
          this.log.info({ gatewayOrderId: evt.gatewayOrderId, reason: evt.reason }, 'payment attempt failed');
          break;
        case 'refund.processed':
        case 'refund.failed': {
          const refund = await this.payments.findRefundByGatewayOrOurId(evt.gatewayRefundId, evt.refundId);
          if (!refund) throw new Error(`unknown refund ${evt.gatewayRefundId}`);
          await this.payments.completeRefund(refund.id, evt.kind === 'refund.processed' ? 'SUCCEEDED' : 'FAILED', `webhook:${this.gateway.name}`, {
            gatewayRefundId: evt.gatewayRefundId,
            reason: evt.kind === 'refund.failed' ? 'gateway failed' : undefined,
          });
          break;
        }
        case 'ignored':
          break;
      }
      await this.db.query('UPDATE webhook_events SET processed_at = now(), last_error = NULL WHERE event_id = $1', [eventId]);
      return true;
    } catch (err) {
      this.log.warn({ err, eventId, attempts: row.attempts }, 'webhook processing failed; will retry');
      await this.db.query('UPDATE webhook_events SET last_error = $2 WHERE event_id = $1', [eventId, String((err as Error).message).slice(0, 500)]);
      return false;
    }
  }

  async retryUnprocessed(limit = 50): Promise<void> {
    const rows = await this.db.query<{ event_id: string }>(
      `SELECT event_id FROM webhook_events WHERE processed_at IS NULL AND attempts < 20
        AND received_at < now() - interval '5 seconds' ORDER BY received_at LIMIT $1`,
      [limit],
    );
    for (const r of rows) await this.process(r.event_id);
  }
}

import { Controller, Get, Inject, Injectable, OnApplicationShutdown, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { EventEnvelope, EventPayload, Topics } from '@ros/contracts';
import { assertOutletAccess, CurrentPrincipal, EventBus, Logger, LOGGER, Principal, Roles, UpstreamError } from '@ros/common';

type Activity = EventPayload<typeof Topics.ActivityRecorded>;
const MAX_STREAMS_PER_OUTLET = 50;

/**
 * Pushes floor activity to connected staff screens over Server-Sent Events.
 *
 * Pipeline: an action (KOT, bill request…) writes an activity row and an
 * outbox event in one transaction → the relay publishes `pos.activity.recorded`
 * → every service replica receives it (its own consumer group) → the hub
 * writes it to the open streams of that tenant + outlet. Delivery to screens
 * is best-effort; on reconnect a screen reloads GET /activity, so nothing is lost.
 */
@Injectable()
export class LiveHub implements OnApplicationShutdown {
  private readonly streams = new Map<string, Set<Response>>();
  private heartbeat?: NodeJS.Timeout;

  constructor(@Inject(LOGGER) private readonly log: Logger) {
    // Comment lines keep proxies and load balancers from closing idle streams.
    this.heartbeat = setInterval(() => this.broadcastRaw(': keep-alive\n\n'), 25_000);
    this.heartbeat.unref();
  }

  async subscribeTo(bus: EventBus, instanceId: string): Promise<void> {
    // A unique group per replica: every replica must see every event to reach its own connected screens.
    await bus.subscribe(Topics.ActivityRecorded, `order-live-${instanceId}`, async (env: EventEnvelope) => {
      try {
        this.publish(env.tenantId, env.payload as Activity);
      } catch (err) {
        this.log.warn({ err }, 'live push failed'); // never block the bus for a screen
      }
    });
  }

  attach(tenantId: string, outletId: string, res: Response): void {
    const key = `${tenantId}:${outletId}`;
    const set = this.streams.get(key) ?? new Set<Response>();
    if (set.size >= MAX_STREAMS_PER_OUTLET) throw new UpstreamError('Too many live screens for this outlet');
    set.add(res);
    this.streams.set(key, set);
    res.on('close', () => {
      set.delete(res);
      if (!set.size) this.streams.delete(key);
    });
  }

  publish(tenantId: string, activity: Activity): void {
    const set = this.streams.get(`${tenantId}:${activity.outletId}`);
    if (!set) return;
    const frame = `id: ${activity.activityId}\nevent: activity\ndata: ${JSON.stringify(activity)}\n\n`;
    for (const res of set) res.write(frame);
  }

  private broadcastRaw(frame: string) {
    for (const set of this.streams.values()) for (const res of set) res.write(frame);
  }

  onApplicationShutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const set of this.streams.values()) for (const res of set) res.end();
    this.streams.clear();
  }
}

@Controller()
export class LiveController {
  constructor(private readonly hub: LiveHub) {}

  /** Live floor activity for one outlet. Authenticated like every other route (Authorization header). */
  @Get('stream')
  @Roles('owner', 'manager', 'cashier', 'captain')
  stream(@CurrentPrincipal() p: Principal, @Query('outletId', new ParseUUIDPipe()) outletId: string, @Res() res: Response) {
    assertOutletAccess(p, outletId);
    this.hub.attach(p.tenantId, outletId, res);
    res.status(200).set({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
  }
}

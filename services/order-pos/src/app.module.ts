import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Topics } from '@ros/contracts';
import { AuthGuard, Database, EventBus, JWT_VERIFIER, JwtVerifier, Logger, LOGGER, OutboxRelay, registerConsumer } from '@ros/common';
import { HealthController, OrdersController, StaffController } from './orders.controller';
import { LiveController, LiveHub } from './live';
import { StaffService, STAFF_DB, STAFF_RELAY } from './staff';
import { APP_DB, OrdersService, PAYMENTS, RELAY } from './orders.service';
import { PaymentClient } from './payment-client';

export interface OrderDeps {
  log: Logger;
  appDb: Database;
  relay: OutboxRelay;
  payments: PaymentClient;
  verifier: JwtVerifier;
  rateLimitPerMinute: number;
}

@Module({})
export class OrderModule {
  static register(deps: OrderDeps): DynamicModule {
    return {
      module: OrderModule,
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: deps.rateLimitPerMinute }])],
      controllers: [OrdersController, StaffController, LiveController, HealthController],
      providers: [
        { provide: LOGGER, useValue: deps.log },
        { provide: APP_DB, useValue: deps.appDb },
        { provide: RELAY, useValue: deps.relay },
        { provide: PAYMENTS, useValue: deps.payments },
        { provide: JWT_VERIFIER, useValue: deps.verifier },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: STAFF_DB, useValue: deps.appDb },
        { provide: STAFF_RELAY, useValue: deps.relay },
        OrdersService,
        StaffService,
        LiveHub,
      ],
    };
  }
}

/** Subscribes the order service to every payment event that changes money on an order. */
export async function registerPaymentConsumers(bus: EventBus, db: Database, log: Logger, orders: OrdersService): Promise<void> {
  for (const topic of [Topics.PaymentCaptured, Topics.PaymentFailed, Topics.PaymentCancelled, Topics.PaymentRefunded] as const) {
    await registerConsumer(bus, db, log, 'order-pos', topic, (tx, payload, env) => orders.applyPaymentSnapshot(tx, env.tenantId, payload));
  }
}

/** Connects this replica's live hub to the event bus (activity → open staff screens). */
export async function registerLiveFeed(bus: EventBus, hub: LiveHub, instanceId: string): Promise<void> {
  await hub.subscribeTo(bus, instanceId);
}

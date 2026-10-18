import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard, Database, JWT_VERIFIER, JwtVerifier, Logger, LOGGER, OutboxRelay } from '@ros/common';
import { PaymentGateway } from './gateway/gateway';
import { HealthController, PaymentsController, WebhooksController } from './payments.controller';
import { APP_DB, GATEWAY, PaymentsService, RELAY, WORKER_DB } from './payments.service';
import { Reconciler, RECONCILER_OPTS, ReconcilerOptions } from './reconciler';
import { WebhooksService } from './webhooks.service';

export interface PaymentDeps {
  log: Logger;
  appDb: Database;
  workerDb: Database;
  gateway: PaymentGateway;
  relay: OutboxRelay;
  verifier: JwtVerifier;
  reconciler: ReconcilerOptions;
  rateLimitPerMinute: number;
}

/** Dependencies are built in main.ts (or the test harness) and injected, so tests use the same wiring as production. */
@Module({})
export class PaymentModule {
  static register(deps: PaymentDeps): DynamicModule {
    return {
      module: PaymentModule,
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: deps.rateLimitPerMinute }])],
      controllers: [PaymentsController, WebhooksController, HealthController],
      providers: [
        { provide: LOGGER, useValue: deps.log },
        { provide: APP_DB, useValue: deps.appDb },
        { provide: WORKER_DB, useValue: deps.workerDb },
        { provide: GATEWAY, useValue: deps.gateway },
        { provide: RELAY, useValue: deps.relay },
        { provide: JWT_VERIFIER, useValue: deps.verifier },
        { provide: RECONCILER_OPTS, useValue: deps.reconciler },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        PaymentsService,
        WebhooksService,
        Reconciler,
      ],
    };
  }
}

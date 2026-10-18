import { Body, Controller, DynamicModule, Get, Inject, Module, Post, Query } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard, CurrentPrincipal, Database, JWT_VERIFIER, JwtVerifier, Logger, LOGGER, Principal, Public, Roles, ZodPipe } from '@ros/common';
import { APP_DB, ExpenseInput, RangeQuery, ReportsService } from './reports.service';

/** Owner and manager dashboards. Cashiers and captains have no access to financials. */
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('overview')
  @Roles('owner', 'manager')
  overview(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(RangeQuery)) q: RangeQuery) {
    return this.reports.overview(p, q);
  }

  @Get('menu')
  @Roles('owner', 'manager')
  menu(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(RangeQuery)) q: RangeQuery) {
    return this.reports.menu(p, q);
  }

  @Get('pnl')
  @Roles('owner')
  pnl(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(RangeQuery)) q: RangeQuery) {
    return this.reports.pnl(p, q);
  }

  @Get('customers')
  @Roles('owner', 'manager')
  customers(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(RangeQuery)) q: RangeQuery) {
    return this.reports.customers(p, q);
  }

  @Get('alerts')
  @Roles('owner', 'manager')
  alerts(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(RangeQuery)) q: RangeQuery) {
    return this.reports.alerts(p, q);
  }
}

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @Roles('owner', 'manager')
  add(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(ExpenseInput)) body: typeof ExpenseInput._type) {
    return this.reports.addExpense(p, body);
  }

  @Get()
  @Roles('owner', 'manager')
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(RangeQuery)) q: RangeQuery) {
    return this.reports.listExpenses(p, q);
  }
}

@Controller('health')
export class HealthController {
  constructor(@Inject(APP_DB) private readonly db: Database) {}
  @Get('live')
  @Public()
  live() {
    return { status: 'ok' };
  }
  @Get('ready')
  @Public()
  async ready() {
    await this.db.ping();
    return { status: 'ready' };
  }
}

export interface AnalyticsDeps {
  log: Logger;
  appDb: Database;
  verifier: JwtVerifier;
  rateLimitPerMinute: number;
}

@Module({})
export class AnalyticsModule {
  static register(deps: AnalyticsDeps): DynamicModule {
    return {
      module: AnalyticsModule,
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: deps.rateLimitPerMinute }])],
      controllers: [AnalyticsController, ExpensesController, HealthController],
      providers: [
        { provide: LOGGER, useValue: deps.log },
        { provide: APP_DB, useValue: deps.appDb },
        { provide: JWT_VERIFIER, useValue: deps.verifier },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        ReportsService,
      ],
    };
  }
}

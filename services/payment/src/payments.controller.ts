import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentPrincipal, Database, Principal, Public, Roles, ZodPipe } from '@ros/common';
import { APP_DB, CreatePaymentInput, PaymentsService, RefundInput, VerifyInput } from './payments.service';
import { WebhooksService } from './webhooks.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Called by the order service (service token) with a client-generated id: safe to retry. */
  @Post()
  @Roles('service')
  async create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(CreatePaymentInput)) body: CreatePaymentInput, @Res({ passthrough: true }) res: Response) {
    const { created, payment } = await this.payments.create(p, body);
    res.status(created ? 201 : 200);
    return payment;
  }

  @Get(':id')
  @Roles('owner', 'manager', 'cashier', 'captain', 'service')
  get(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.payments.get(p, id);
  }

  @Post(':id/verify')
  @HttpCode(200)
  @Roles('owner', 'manager', 'cashier', 'service')
  verify(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(VerifyInput)) body: typeof VerifyInput._type) {
    return this.payments.verify(p, id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles('owner', 'manager', 'cashier', 'service')
  cancel(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.payments.cancel(p, id);
  }

  /** Refunds need a manager and an Idempotency-Key, so a double-click can't refund twice. */
  @Post(':id/refunds')
  @Roles('owner', 'manager')
  refund(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(RefundInput)) body: typeof RefundInput._type,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.payments.refund(p, id, body, key ?? '');
  }
}

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('razorpay')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
  ) {
    return this.webhooks.receive(req.rawBody, signature, eventId);
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

  /** Readiness: Kubernetes stops routing traffic here if the database is unreachable. */
  @Get('ready')
  @Public()
  async ready() {
    await this.db.ping();
    return { status: 'ready' };
  }
}

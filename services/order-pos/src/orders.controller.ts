import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentPrincipal, Database, Principal, Public, Roles, ZodPipe } from '@ros/common';
import { APP_DB, CheckoutInput, CreateMenuItemInput, CreateOrderInput, OrdersService } from './orders.service';

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('menu-items')
  @Roles('owner', 'manager')
  createMenuItem(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(CreateMenuItemInput)) body: typeof CreateMenuItemInput._type) {
    return this.orders.createMenuItem(p, body);
  }

  @Post('orders')
  @Roles('owner', 'manager', 'cashier', 'captain')
  async createOrder(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(CreateOrderInput)) body: typeof CreateOrderInput._type, @Res({ passthrough: true }) res: Response) {
    const { created, order } = await this.orders.createOrder(p, body);
    res.status(created ? 201 : 200);
    return order;
  }

  @Get('orders/:id')
  @Roles('owner', 'manager', 'cashier', 'captain')
  getOrder(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.orders.getOrder(p, id);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  @Roles('owner', 'manager')
  cancelOrder(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.orders.cancelOrder(p, id);
  }

  @Post('orders/:id/payments')
  @Roles('owner', 'manager', 'cashier')
  checkout(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(CheckoutInput)) body: typeof CheckoutInput._type,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.orders.checkout(p, id, body, key ?? '');
  }

  @Post('orders/:id/payments/:paymentId/cancel')
  @HttpCode(200)
  @Roles('owner', 'manager', 'cashier')
  cancelPayment(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string, @Param('paymentId', new ParseUUIDPipe()) paymentId: string) {
    return this.orders.cancelPayment(p, id, paymentId);
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

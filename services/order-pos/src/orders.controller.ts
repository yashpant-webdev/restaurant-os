import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentPrincipal, Database, Principal, Public, Roles, ZodPipe } from '@ros/common';
import { CreateStaffInput, StaffService } from './staff';
import { AddItemsInput, AssignCaptainInput, AvailabilityInput, UpdateMenuItemInput, AttachCustomerInput, APP_DB, CheckoutInput, CreateMenuItemInput, CreateOrderInput, CreateTableInput, OrdersService } from './orders.service';

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('menu-items')
  @Roles('owner', 'manager')
  createMenuItem(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(CreateMenuItemInput)) body: typeof CreateMenuItemInput._type) {
    return this.orders.createMenuItem(p, body);
  }

  @Get('menu-items')
  @Roles('owner', 'manager', 'cashier', 'captain')
  listMenu(@CurrentPrincipal() p: Principal, @Query('outletId', new ParseUUIDPipe()) outletId: string, @Query('includeInactive') inactive?: string) {
    return this.orders.listMenu(p, outletId, inactive === 'true' && p.roles.some((r) => r === 'owner' || r === 'manager'));
  }

  @Patch('menu-items/:id')
  @Roles('owner', 'manager')
  updateMenuItem(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(UpdateMenuItemInput)) body: typeof UpdateMenuItemInput._type) {
    return this.orders.updateMenuItem(p, id, body);
  }

  @Post('menu-items/:id/availability')
  @HttpCode(200)
  @Roles('owner', 'manager', 'cashier')
  setAvailability(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(AvailabilityInput)) body: typeof AvailabilityInput._type) {
    return this.orders.setAvailability(p, id, body.isAvailable);
  }

  @Post('tables')
  @Roles('owner', 'manager')
  createTable(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(CreateTableInput)) body: typeof CreateTableInput._type) {
    return this.orders.createTable(p, body);
  }

  /** Floor plan with live status of every table (captain and cashier screens). */
  @Get('floor')
  @Roles('owner', 'manager', 'cashier', 'captain')
  floor(@CurrentPrincipal() p: Principal, @Query('outletId', new ParseUUIDPipe()) outletId: string) {
    return this.orders.getFloor(p, outletId);
  }

  /** Kitchen display: latest kitchen order tickets. */
  @Get('kots')
  @Roles('owner', 'manager', 'cashier', 'captain')
  kots(@CurrentPrincipal() p: Principal, @Query('outletId', new ParseUUIDPipe()) outletId: string) {
    return this.orders.listKots(p, outletId);
  }

  @Post('orders/:id/items')
  @HttpCode(200)
  @Roles('owner', 'manager', 'cashier', 'captain')
  addItems(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(AddItemsInput)) body: typeof AddItemsInput._type) {
    return this.orders.addItems(p, id, body);
  }

  @Post('orders/:id/customer')
  @HttpCode(200)
  @Roles('owner', 'manager', 'cashier', 'captain')
  attachCustomer(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(AttachCustomerInput)) body: typeof AttachCustomerInput._type) {
    return this.orders.attachCustomer(p, id, body);
  }

  @Post('orders/:id/captain')
  @HttpCode(200)
  @Roles('owner', 'manager', 'cashier')
  assignCaptain(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(AssignCaptainInput)) body: typeof AssignCaptainInput._type) {
    return this.orders.assignCaptain(p, id, body);
  }

  @Post('orders/:id/request-bill')
  @HttpCode(200)
  @Roles('owner', 'manager', 'cashier', 'captain')
  requestBill(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.orders.requestBill(p, id);
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

@Controller()
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  /** Captains see the list too (to know who is on the floor); only cashiers and above can change it. */
  @Get('staff')
  @Roles('owner', 'manager', 'cashier', 'captain')
  list(@CurrentPrincipal() p: Principal, @Query('outletId', new ParseUUIDPipe()) outletId: string, @Query('includeInactive') inactive?: string) {
    return this.staff.list(p, outletId, inactive === 'true');
  }

  @Post('staff')
  @Roles('owner', 'manager', 'cashier')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(CreateStaffInput)) body: typeof CreateStaffInput._type) {
    return this.staff.create(p, body);
  }

  @Delete('staff/:id')
  @Roles('owner', 'manager', 'cashier')
  remove(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.staff.remove(p, id);
  }

  @Get('activity')
  @Roles('owner', 'manager', 'cashier', 'captain')
  activity(@CurrentPrincipal() p: Principal, @Query('outletId', new ParseUUIDPipe()) outletId: string) {
    return this.staff.activity(p, outletId);
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

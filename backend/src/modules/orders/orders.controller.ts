import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  ParseUUIDPipe,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { OrderCompensationService } from './order-compensation.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { PaymentMethod } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly compensation: OrderCompensationService,
  ) { }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createOrder(
    @Body() createOrderDto: CreateOrderDto,
    @CurrentUser() user: { id: string },
  ) {
    const order = await this.ordersService.create(createOrderDto, user.id);
    return {
      message: 'Tạo đơn hàng thành công',
      data: order,
    };
  }

  @Get('pending-checkout')
  async getPendingCheckout(@CurrentUser() user: { id: string }) {
    return { data: await this.ordersService.findPendingCheckout(user.id) };
  }

  @Get('me')
  async getMyOrders(@CurrentUser() user: { id: string }) {
    const orders = await this.ordersService.findAllByUser(user.id);
    return { data: orders };
  }

  @Get('notifications')
  async getNotifications(@CurrentUser() user: { id: string }) {
    return { data: await this.ordersService.getNotifications(user.id) };
  }

  @Patch('notifications/:id/read')
  async readNotification(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }) {
    await this.ordersService.readNotification(id, user.id);
  }

  @Patch('notifications/read-all')
  async readAllNotifications(@CurrentUser() user: { id: string }) {
    await this.ordersService.readNotification(undefined, user.id);
  }

  @Get(':id/replacement')
  async getReplacement(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }) {
    return { data: await this.compensation.get(id, user.id) };
  }

  @Post(':id/replacement')
  async createReplacement(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Body() dto: CreateOrderDto,
  ) {
    return { data: await this.compensation.create(id, user.id, dto.items) };
  }

  @Post(':id/replacement/payment')
  async createReplacementPayment(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }) {
    return { data: await this.compensation.createPayosLink(id, user.id) };
  }

  @Post(':id/replacement/cancel')
  async cancelPendingReplacement(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }) {
    return { data: await this.compensation.cancelPendingReplacement(id, user.id) };
  }

  @Post(':id/replacement/card')
  async payReplacementWithCard(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Body('method') method?: PaymentMethod,
  ) {
    return { data: await this.compensation.payWithCard(id, user.id, method ?? PaymentMethod.CARD) };
  }

  @Get(':id')
  async getOrderById(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    const order = await this.ordersService.findOne(id, user.id);
    return { data: order };
  }
}

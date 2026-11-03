import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) { }

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

  @Get('me')
  async getMyOrders(@CurrentUser() user: { id: string }) {
    const orders = await this.ordersService.findAllByUser(user.id);
    return { data: orders };
  }

  @Get(':id')
  async getOrderById(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    const order = await this.ordersService.findOne(id, user.id);
    return { data: order };
  }
}

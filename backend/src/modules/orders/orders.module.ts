import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { OrderCompensationService } from './order-compensation.service.js';
import { PromotionsModule } from '../promotions/promotions.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { RewardsModule } from '../rewards/rewards.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';

@Module({
  imports: [PromotionsModule, AuthModule, RewardsModule, InventoryModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderCompensationService],
  exports: [OrdersService, OrderCompensationService],
})
export class OrdersModule {}

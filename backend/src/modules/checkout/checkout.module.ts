import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { RewardsModule } from '../rewards/rewards.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { PaymentGatewayService } from './payment-gateway.service.js';
import { OrdersModule } from '../orders/orders.module.js';

@Module({
  imports: [PrismaModule, AuthModule, RewardsModule, InventoryModule, OrdersModule],
  controllers: [CheckoutController],
  providers: [CheckoutService, PaymentGatewayService],
  exports: [CheckoutService],
  
})
export class CheckoutModule {}

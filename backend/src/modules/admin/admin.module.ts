import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { RewardsModule } from '../rewards/rewards.module.js';

// PrismaModule là @Global nên không cần import lại.
// PassportModule thì phải import để JwtAuthGuard có AuthModuleOptions.
@Module({
    imports: [PassportModule.register({ defaultStrategy: 'jwt' }), InventoryModule, RewardsModule],
    controllers: [AdminController],
    providers: [AdminService],
})
export class AdminModule { }

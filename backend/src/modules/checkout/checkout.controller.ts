import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  BadRequestException,
  HttpCode,
  HttpStatus,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { CheckoutService } from './checkout.service.js';
import { CreateCheckoutDto } from './dto/create-checkout.dto.js';
import { ApplyVoucherDto } from './dto/apply-voucher.dto.js';
import { SepayWebhookDto } from './dto/sepay-webhook.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';

// Hai đường dẫn dùng chung một luồng thanh toán: /api/checkout và /api/payments
@Controller(['checkout', 'payments'])
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  // ----------------------------------------------------------
  // POST /api/checkout/apply-voucher
  // Áp dụng mã giảm giá cho đơn hàng (cho GUI gọi kiểm tra trước)
  // ----------------------------------------------------------
  @Post('apply-voucher')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async applyVoucher(@Body() dto: ApplyVoucherDto, @CurrentUser() user: { id: string }) {
    return this.checkoutService.applyVoucher(dto.orderId, dto.promoCode, user.id);
  }

  // ----------------------------------------------------------
  // POST /api/checkout
  // Xử lý thanh toán đơn hàng
  // ----------------------------------------------------------
  @Post()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async processCheckout(
    @Body() dto: CreateCheckoutDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @CurrentUser() user: { id: string },
  ) {
    // Bắt buộc phải có Idempotency-Key để chống thanh toán trùng lặp
    if (!idempotencyKey) {
      throw new BadRequestException(
        'Header "Idempotency-Key" là bắt buộc. ' +
        'Hãy gửi một UUID duy nhất cho mỗi lần bấm nút thanh toán.',
      );
    }

    return this.checkoutService.processCheckout(
      dto.orderId,
      dto.method,
      idempotencyKey,
      user.id,
      dto.promoCode,
    );
  }

  // ----------------------------------------------------------
  // GET /api/checkout/order/:orderId
  // Lấy lịch sử thanh toán của 1 đơn hàng
  // ----------------------------------------------------------
  @Get('order/:orderId')
  @UseGuards(JwtAuthGuard)
  async getCheckoutsByOrder(@Param('orderId') orderId: string, @CurrentUser() user: { id: string }) {
    return this.checkoutService.getCheckoutsByOrder(orderId, user.id);
  }

  // ----------------------------------------------------------
  // GET /api/checkout/status/:orderId
  // Lấy trạng thái đơn hàng & đếm ngược số giây còn lại trước khi hết hạn (cho GUI)
  // ----------------------------------------------------------
  @Get('status/:orderId')
  @UseGuards(JwtAuthGuard)
  async getOrderCheckoutStatus(@Param('orderId') orderId: string, @CurrentUser() user: { id: string }) {
    return this.checkoutService.getOrderCheckoutStatus(orderId, user.id);
  }

  // ----------------------------------------------------------
  // POST /api/checkout/sepay-webhook (và /api/payments/sepay-webhook)
  // Nhận thông báo biến động số dư từ cổng SePay (IPN / Webhook)
  // ----------------------------------------------------------
  @Post('sepay-webhook')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: false, forbidNonWhitelisted: false, transform: true }))
  async handleSepayWebhook(
    @Body() dto: SepayWebhookDto,
    @Headers('authorization') authHeader?: string,
  ) {
    return this.checkoutService.processSepayWebhook(dto, authHeader);
  }
}

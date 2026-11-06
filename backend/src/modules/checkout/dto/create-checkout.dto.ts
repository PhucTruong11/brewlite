import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaymentMethod } from '@prisma/client';

export class CreateCheckoutDto {
  @IsNotEmpty({ message: 'orderId là bắt buộc' })
  @IsUUID('4', { message: 'orderId phải là UUID hợp lệ' })
  orderId: string;

  @IsNotEmpty({ message: 'method là bắt buộc' })
  @IsEnum(PaymentMethod, {
    message: 'method phải là EWALLET (ví điện tử) hoặc CARD (thẻ)',
  })
  method: PaymentMethod;

  @IsOptional()
  @IsString({ message: 'promoCode phải là chuỗi ký tự' })
  promoCode?: string;
}

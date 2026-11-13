import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';

export class UpdatePromotionDto {
  @IsOptional()
  @IsString({ message: 'Mô tả phải là chuỗi ký tự' })
  description?: string | null;

  @IsOptional()
  @IsIn(['PERCENTAGE', 'FIXED_AMOUNT'], {
    message: 'Loại giảm giá chỉ được là PERCENTAGE hoặc FIXED_AMOUNT',
  })
  discountType?: 'PERCENTAGE' | 'FIXED_AMOUNT';

  @IsOptional()
  @IsNumber({}, { message: 'Giá trị giảm phải là số' })
  @Min(0, { message: 'Giá trị giảm không được âm' })
  discountValue?: number;

  @IsOptional()
  @IsNumber({}, { message: 'Đơn tối thiểu phải là số' })
  @Min(0, { message: 'Đơn tối thiểu không được âm' })
  minOrderValue?: number;

  @ValidateIf((_dto, value) => value !== undefined && value !== null)
  @IsNumber({}, { message: 'Giảm tối đa phải là số' })
  @Min(0, { message: 'Giảm tối đa không được âm' })
  maxDiscount?: number | null;

  @ValidateIf((_dto, value) => value !== undefined && value !== null)
  @IsDateString({}, { message: 'Ngày kết thúc phải đúng định dạng ngày (ISO 8601)' })
  endDate?: string | null;

  @IsOptional()
  @IsInt({ message: 'Điểm đổi phải là số nguyên' })
  @Min(1, { message: 'Điểm đổi phải lớn hơn 0' })
  pointsCost?: number;

  @IsOptional()
  @IsInt({ message: 'Giới hạn số lượng phải là số nguyên' })
  @Min(1, { message: 'Giới hạn số lượng phải lớn hơn 0' })
  redemptionLimit?: number;

  @IsOptional()
  @IsBoolean({ message: 'Trạng thái kích hoạt phải là true hoặc false' })
  isActive?: boolean;
}

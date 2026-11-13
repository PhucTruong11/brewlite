import {
    IsBoolean,
    IsDateString,
    IsDefined,
    IsIn,
    IsInt,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    Min,
    ValidateIf,
} from 'class-validator';

export class CreatePromotionDto {
    @IsNotEmpty({ message: 'Mã voucher không được để trống' })
    @IsString({ message: 'Mã voucher phải là chuỗi ký tự' })
    code: string;
    @IsOptional()
    @IsString({ message: 'Mô tả phải là chuỗi ký tự' })
    description?: string;
    @IsNotEmpty({ message: 'Loại giảm giá không được để trống' })
    @IsIn(['PERCENTAGE', 'FIXED_AMOUNT'], {
        message: 'Loại giảm giá chỉ được là PERCENTAGE hoặc FIXED_AMOUNT',
    })
    discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
    @IsNumber({}, { message: 'Giá trị giảm phải là số' })
    @Min(0, { message: 'Giá trị giảm không được âm' })
    discountValue: number;
    @IsOptional()
    @IsNumber({}, { message: 'Đơn tối thiểu phải là số' })
    @Min(0, { message: 'Đơn tối thiểu không được âm' })
    minOrderValue?: number;
    @IsOptional()
    @IsNumber({}, { message: 'Giảm tối đa phải là số' })
    @Min(0, { message: 'Giảm tối đa không được âm' })
    maxDiscount?: number;
    @IsOptional()
    @IsDateString({}, { message: 'Ngày kết thúc phải đúng định dạng ngày (ISO 8601)' })
    endDate?: string;
    @IsOptional()
    @IsBoolean({ message: 'Trạng thái kích hoạt phải là true hoặc false' })
    isActive?: boolean;
    @IsOptional()
    @IsBoolean({ message: 'Loại voucher phải là true hoặc false' })
    isRewardOnly?: boolean;
    @ValidateIf((dto: CreatePromotionDto) => dto.pointsCost !== undefined)
    @IsInt({ message: 'Điểm đổi phải là số nguyên' })
    @Min(1, { message: 'Điểm đổi phải lớn hơn 0' })
    pointsCost?: number;

    @ValidateIf((dto: CreatePromotionDto) => dto.pointsCost !== undefined)
    @IsDefined({ message: 'Voucher đổi thưởng cần giới hạn số lượng' })
    @IsInt({ message: 'Giới hạn số lượng phải là số nguyên' })
    @Min(1, { message: 'Giới hạn số lượng phải lớn hơn 0' })
    redemptionLimit?: number;
}
import {
    IsArray,
    IsIn,
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    Min,
    Max,
    Validate,
    ValidateNested,
    ArrayMinSize,
    IsNumber,
    IsUUID,
    ValidatorConstraint,
    ValidatorConstraintInterface,
} from 'class-validator';
import { Type } from 'class-transformer';

@ValidatorConstraint({
    name: 'isSafeInteger',
    async: false,
})
export class IsSafeIntegerConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        return typeof value === 'number' && Number.isSafeInteger(value);
    }

    defaultMessage(): string {
        return 'Số lượng phải là số nguyên an toàn';
    }
}

export class CreateOrderItemDto {
    @IsUUID('4', { message: 'productId không đúng định dạng UUID' })
    @IsNotEmpty({ message: 'productId không được để trống' })
    productId: string;

    @IsIn(['S', 'M', 'L'], {
        message: 'size phải là S, M hoặc L',
    })
    size: 'S' | 'M' | 'L';

    @IsInt({ message: 'Số lượng phải là số nguyên' })
    @Validate(IsSafeIntegerConstraint)
    @Min(1, { message: 'Số lượng phải ít nhất là 1' })
    @Max(100, { message: 'Số lượng không được vượt quá 100' })
    qty: number;

    @IsOptional()
    @IsArray()
    @IsString({ each: true, message: 'Topping phải là chuỗi' })
    toppings?: string[];

    @IsNumber(
        { allowNaN: false, allowInfinity: false },
        { message: 'lineTotal phải là số hợp lệ' },
    )
    @Min(0, { message: 'lineTotal không được âm' })
    lineTotal: number;
}

export class CreateOrderDto {
    @IsArray({ message: 'items phải là một danh sách' })
    @ArrayMinSize(1, {
        message: 'Giỏ hàng không được rỗng',
    })
    @ValidateNested({ each: true })
    @Type(() => CreateOrderItemDto)
    items: CreateOrderItemDto[];

    @IsOptional()
    @IsString({ message: 'promoCode phải là chuỗi' })
    promoCode?: string;
}

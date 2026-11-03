import {
    IsArray,
    IsIn,
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    Min,
    ValidateNested,
    ArrayMinSize,
    IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateOrderItemDto {
    @IsString()
    @IsNotEmpty({ message: 'productId không được để trống' })
    productId: string;

    @IsIn(['S', 'M', 'L'], { message: 'size phải là S, M hoặc L' })
    size: 'S' | 'M' | 'L';

    @IsInt({ message: 'Số lượng phải là số nguyên' })
    @Min(1, { message: 'Số lượng phải ít nhất là 1' })
    qty: number;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    toppings?: string[];

    @IsNumber()
    @Min(0)
    lineTotal: number;
}

export class CreateOrderDto {
    @IsArray()
    @ArrayMinSize(1, { message: 'Giỏ hàng không được rỗng' })
    @ValidateNested({ each: true })
    @Type(() => CreateOrderItemDto)
    items: CreateOrderItemDto[];

    @IsOptional()
    @IsString()
    promoCode?: string;
}

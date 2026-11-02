import { IsOptional } from 'class-validator';

export class SepayWebhookDto {
  @IsOptional()
  id?: number | string;

  @IsOptional()
  gateway?: string;

  @IsOptional()
  transactionDate?: string;

  @IsOptional()
  accountNumber?: string;

  @IsOptional()
  subAccount?: string | null;

  @IsOptional()
  code?: string | null;

  @IsOptional()
  content?: string;

  @IsOptional()
  transferType?: string;

  @IsOptional()
  description?: string;

  @IsOptional()
  transferAmount?: number;

  @IsOptional()
  referenceCode?: string;

  @IsOptional()
  accumulated?: number;
}

import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BalancesService } from './balances.service';

class AdjustBalanceDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  organizzeAccountId!: number;

  @Type(() => Number)
  @IsInt()
  amountCents!: number;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number | null;
}

class AdjustInvoiceDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  organizzeCreditCardId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  invoiceId!: number;

  @Type(() => Number)
  @IsInt()
  amountCents!: number;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number | null;
}

@Controller('balances')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  @Get('snapshot')
  getSnapshot() {
    return this.balances.getSnapshot();
  }

  @Post('adjust')
  adjust(@Body() body: AdjustBalanceDto) {
    return this.balances.createAdjustment(body);
  }

  @Post('adjust-invoice')
  adjustInvoice(@Body() body: AdjustInvoiceDto) {
    return this.balances.createInvoiceAdjustment(body);
  }
}

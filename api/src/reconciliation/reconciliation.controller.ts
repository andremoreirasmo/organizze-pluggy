import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ReconciliationService } from './reconciliation.service';

class DateRangeDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;
}

class LinkDto extends DateRangeDto {
  @Type(() => Number)
  @IsInt()
  organizzeTransactionId!: number;

  @IsOptional()
  @IsBoolean()
  syncDate?: boolean;

  @IsOptional()
  @IsBoolean()
  syncAmount?: boolean;

  /** Valor final no Organizze (centavos, com sinal). Tem prioridade sobre syncAmount. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  amountCents?: number;

  /** Conta Organizze onde o pagamento/recebimento deve ficar ao vincular. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  accountId?: number;
}

class ImportDto extends DateRangeDto {
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  accountId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  creditCardId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  creditCardInvoiceId?: number;

  @IsOptional()
  @IsBoolean()
  paid?: boolean;

  /** Valor no Organizze (centavos, com sinal). Padrão: valor convertido do Pluggy. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  amountCents?: number;

  /** Tag names to attach on create (Organizze creates missing ones). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];
}

class InvoicePaymentDto extends DateRangeDto {
  @Type(() => Number)
  @IsInt()
  creditCardId!: number;

  @Type(() => Number)
  @IsInt()
  invoiceId!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  accountId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number | null;
}

class IgnoreDto extends DateRangeDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

class TransferDto extends DateRangeDto {
  @Type(() => Number)
  @IsInt()
  otherAccountId!: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  counterpartPluggyId?: string;

  /** Valor da transferência em centavos (positivo). Padrão: |valor Pluggy|. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  amountCents?: number;
}

class CardLendPersonDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountCents!: number;
}

class CardLendDto extends DateRangeDto {
  @Type(() => Number)
  @IsInt()
  creditCardId!: number;

  @Type(() => Number)
  @IsInt()
  creditCardInvoiceId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  myAmountCents!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  myCategoryId?: number | null;

  @Type(() => Number)
  @IsInt()
  peopleCategoryId!: number;

  @Type(() => Number)
  @IsInt()
  receiveAccountId!: number;

  @Type(() => Number)
  @IsInt()
  receiveCategoryId!: number;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  receiveDate!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CardLendPersonDto)
  people!: CardLendPersonDto[];
}

@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get('queue')
  getQueue(@Query('from') from: string, @Query('to') to: string) {
    return this.reconciliation.getQueue(from, to);
  }

  @Get('ignored')
  listIgnored() {
    return this.reconciliation.listIgnored();
  }

  @Delete('ignored/:pluggyTxId')
  unignore(@Param('pluggyTxId') pluggyTxId: string) {
    return this.reconciliation.unignoreTransaction(pluggyTxId);
  }

  @Get('done')
  listDone(@Query('from') from: string, @Query('to') to: string) {
    return this.reconciliation.listDone(from, to);
  }

  @Delete('done/:pluggyTxId')
  undoDone(
    @Param('pluggyTxId') pluggyTxId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.reconciliation.undoDoneTransaction(pluggyTxId, { from, to });
  }

  @Post(':pluggyTxId/link')
  link(
    @Param('pluggyTxId') pluggyTxId: string,
    @Body() body: LinkDto,
  ) {
    return this.reconciliation.linkTransaction(pluggyTxId, body);
  }

  @Post(':pluggyTxId/import')
  import(
    @Param('pluggyTxId') pluggyTxId: string,
    @Body() body: ImportDto,
  ) {
    return this.reconciliation.importTransaction(pluggyTxId, body);
  }

  @Post(':pluggyTxId/transfer')
  transfer(
    @Param('pluggyTxId') pluggyTxId: string,
    @Body() body: TransferDto,
  ) {
    return this.reconciliation.createAccountTransfer(pluggyTxId, body);
  }

  @Post(':pluggyTxId/invoice-payment')
  invoicePayment(
    @Param('pluggyTxId') pluggyTxId: string,
    @Body() body: InvoicePaymentDto,
  ) {
    return this.reconciliation.createInvoicePayment(pluggyTxId, body);
  }

  @Post(':pluggyTxId/card-lend')
  cardLend(
    @Param('pluggyTxId') pluggyTxId: string,
    @Body() body: CardLendDto,
  ) {
    return this.reconciliation.createCardLend(pluggyTxId, body);
  }

  @Post(':pluggyTxId/ignore')
  ignore(
    @Param('pluggyTxId') pluggyTxId: string,
    @Body() body: IgnoreDto,
  ) {
    return this.reconciliation.ignoreTransaction(pluggyTxId, body);
  }
}

import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { OrganizzeService } from './organizze.service';

@Controller('organizze')
export class OrganizzeController {
  constructor(private readonly organizze: OrganizzeService) {}

  @Get('accounts')
  listAccounts(@Query('includeArchived') includeArchived?: string) {
    return this.organizze.listAccounts({
      includeArchived: includeArchived === 'true',
    });
  }

  @Get('categories')
  listCategories(@Query('includeArchived') includeArchived?: string) {
    return this.organizze.listCategories({
      includeArchived: includeArchived === 'true',
    });
  }

  @Get('transactions')
  listTransactions(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('accountId') accountId?: string,
  ) {
    return this.organizze.listTransactions({
      startDate,
      endDate,
      accountId: accountId ? Number(accountId) : undefined,
    });
  }

  @Get('credit-cards')
  listCreditCards(@Query('includeArchived') includeArchived?: string) {
    return this.organizze.listCreditCards({
      includeArchived: includeArchived === 'true',
    });
  }

  @Get('credit-cards/:creditCardId/invoices')
  listInvoices(@Param('creditCardId', ParseIntPipe) creditCardId: number) {
    return this.organizze.listInvoices(creditCardId);
  }
}

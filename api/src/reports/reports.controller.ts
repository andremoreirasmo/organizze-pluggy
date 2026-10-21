import { Controller, Get, Query } from '@nestjs/common';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('cashflow')
  getCashflow(@Query('month') month?: string) {
    return this.reports.getCashflowOverview(month);
  }
}

import { Controller, Get, Query } from '@nestjs/common';
import { InstallmentsService } from './installments.service';

@Controller('installments')
export class InstallmentsController {
  constructor(private readonly installments: InstallmentsService) {}

  @Get('overview')
  getOverview(@Query('month') month?: string) {
    return this.installments.getOverview(month);
  }
}

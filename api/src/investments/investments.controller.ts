import { Controller, Get } from '@nestjs/common';
import { InvestmentsService } from './investments.service';

@Controller('investments')
export class InvestmentsController {
  constructor(private readonly investments: InvestmentsService) {}

  @Get('overview')
  getOverview() {
    return this.investments.getOverview();
  }
}

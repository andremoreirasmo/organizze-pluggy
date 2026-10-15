import { Module } from '@nestjs/common';
import { BalancesModule } from '../balances/balances.module';
import { InstallmentsModule } from '../installments/installments.module';
import { OrganizzeModule } from '../organizze/organizze.module';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';

@Module({
  imports: [OrganizzeModule, BalancesModule, InstallmentsModule],
  controllers: [GoalsController],
  providers: [GoalsService],
  exports: [GoalsService],
})
export class GoalsModule {}

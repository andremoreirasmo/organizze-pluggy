import { Module } from '@nestjs/common';
import { OrganizzeModule } from '../organizze/organizze.module';
import { PluggyModule } from '../pluggy/pluggy.module';
import { SettingsModule } from '../settings/settings.module';
import { BalancesController } from './balances.controller';
import { BalancesService } from './balances.service';

@Module({
  imports: [OrganizzeModule, PluggyModule, SettingsModule],
  controllers: [BalancesController],
  providers: [BalancesService],
  exports: [BalancesService],
})
export class BalancesModule {}

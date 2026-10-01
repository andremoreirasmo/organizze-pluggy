import { Module } from '@nestjs/common';
import { OrganizzeModule } from '../organizze/organizze.module';
import { PluggyModule } from '../pluggy/pluggy.module';
import { SettingsModule } from '../settings/settings.module';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [OrganizzeModule, PluggyModule, SettingsModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}

import { Module } from '@nestjs/common';
import { OrganizzeModule } from '../organizze/organizze.module';
import { SettingsModule } from '../settings/settings.module';
import { InstallmentsController } from './installments.controller';
import { InstallmentsService } from './installments.service';

@Module({
  imports: [OrganizzeModule, SettingsModule],
  controllers: [InstallmentsController],
  providers: [InstallmentsService],
  exports: [InstallmentsService],
})
export class InstallmentsModule {}

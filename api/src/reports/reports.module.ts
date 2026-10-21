import { Module } from '@nestjs/common';
import { OrganizzeModule } from '../organizze/organizze.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [OrganizzeModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}

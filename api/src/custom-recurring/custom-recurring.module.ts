import { Module } from '@nestjs/common';
import { OrganizzeModule } from '../organizze/organizze.module';
import { CustomRecurringController } from './custom-recurring.controller';
import { CustomRecurringService } from './custom-recurring.service';

@Module({
  imports: [OrganizzeModule],
  controllers: [CustomRecurringController],
  providers: [CustomRecurringService],
  exports: [CustomRecurringService],
})
export class CustomRecurringModule {}

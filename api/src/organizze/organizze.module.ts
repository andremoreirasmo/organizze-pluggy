import { Module } from '@nestjs/common';
import { OrganizzeController } from './organizze.controller';
import { OrganizzeService } from './organizze.service';

@Module({
  controllers: [OrganizzeController],
  providers: [OrganizzeService],
  exports: [OrganizzeService],
})
export class OrganizzeModule {}

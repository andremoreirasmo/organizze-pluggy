import { Module } from '@nestjs/common';
import { PluggyController } from './pluggy.controller';
import { PluggyService } from './pluggy.service';

@Module({
  controllers: [PluggyController],
  providers: [PluggyService],
  exports: [PluggyService],
})
export class PluggyModule {}

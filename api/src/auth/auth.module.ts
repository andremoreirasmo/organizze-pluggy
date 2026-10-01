import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { BasicAuthGuard } from './basic-auth.guard';
import { BasicStrategy } from './basic.strategy';

@Module({
  imports: [PassportModule],
  providers: [BasicStrategy, BasicAuthGuard],
  exports: [BasicAuthGuard],
})
export class AuthModule {}

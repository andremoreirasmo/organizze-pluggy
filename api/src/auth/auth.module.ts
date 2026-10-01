import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OriginCheckGuard } from './origin-check.guard';
import { SessionAuthGuard } from './session-auth.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionAuthGuard, OriginCheckGuard],
  exports: [AuthService, SessionAuthGuard, OriginCheckGuard],
})
export class AuthModule {}

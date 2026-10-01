import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { SESSION_COOKIE_NAME, type SessionUser } from './session.types';

class GoogleLoginDto {
  @IsString()
  @MinLength(20)
  idToken!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Get('config')
  getConfig() {
    return {
      googleClientId: this.auth.getGoogleClientId(),
    };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('google')
  async googleLogin(
    @Body() body: GoogleLoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = await this.auth.loginWithGoogleIdToken(body.idToken);
    const token = await this.auth.createSession(user.email);
    this.auth.setSessionCookie(response, token);
    return { email: user.email };
  }

  @Public()
  @Post('logout')
  async logout(
    @Req() request: Request & { cookies?: Record<string, string | undefined> },
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.revokeSession(request.cookies?.[SESSION_COOKIE_NAME]);
    this.auth.clearSessionCookie(response);
    return { ok: true };
  }

  @Public()
  @Get('me')
  me(@Req() request: { user?: SessionUser }) {
    return {
      email: request.user?.email ?? null,
    };
  }
}

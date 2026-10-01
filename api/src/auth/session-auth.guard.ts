import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import { SESSION_COOKIE_NAME, type SessionUser } from './session.types';

type RequestWithUser = Request & {
  user?: SessionUser;
  cookies?: Record<string, string | undefined>;
};

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithUser>();
    const response = http.getResponse<Response>();
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    const session = await this.auth.resolveSession(token);

    if (session) {
      request.user = { email: session.email };
      await this.auth.touchSession(session, response);
    }

    if (isPublic) {
      return true;
    }

    if (!request.user) {
      throw new UnauthorizedException('Authentication required');
    }

    return true;
  }
}

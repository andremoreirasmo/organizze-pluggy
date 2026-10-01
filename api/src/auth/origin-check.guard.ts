import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hostFromUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

@Injectable()
export class OriginCheckGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const method = (request.method ?? 'GET').toUpperCase();
    if (!MUTATING.has(method)) {
      return true;
    }

    const path = request.path || request.url || '';
    if (!path.startsWith('/api')) {
      return true;
    }

    const requestHost = (request.headers.host ?? '').toLowerCase();
    const allowed = new Set<string>();
    if (requestHost) {
      allowed.add(requestHost);
    }

    const isProd = this.config.get<string>('NODE_ENV') === 'production';
    if (!isProd) {
      allowed.add('localhost:5173');
      allowed.add('127.0.0.1:5173');
    }

    const originHost = hostFromUrl(
      typeof request.headers.origin === 'string'
        ? request.headers.origin
        : undefined,
    );
    const refererHost = hostFromUrl(
      typeof request.headers.referer === 'string'
        ? request.headers.referer
        : undefined,
    );

    if (!originHost && !refererHost) {
      throw new ForbiddenException('Missing Origin or Referer');
    }

    if (originHost && allowed.has(originHost)) {
      return true;
    }
    if (refererHost && allowed.has(refererHost)) {
      return true;
    }

    throw new ForbiddenException('Invalid request origin');
  }
}

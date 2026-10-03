import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.module';
import { generateSessionToken, hashSessionToken } from './session';
import {
  SESSION_ABSOLUTE_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_SECONDS,
  SESSION_TOUCH_THROTTLE_SECONDS,
  type SessionUser,
} from './session.types';

export type ResolvedSession = SessionUser & {
  sessionId: string;
  token: string;
  lastSeenAt: Date;
  absoluteExpiresAt: Date;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleClient: OAuth2Client;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.googleClient = new OAuth2Client(
      this.config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
    );
  }

  getGoogleClientId(): string {
    return this.config.getOrThrow<string>('GOOGLE_CLIENT_ID');
  }

  getAllowedEmails(): string[] {
    return this.config
      .getOrThrow<string>('GOOGLE_ALLOWED_EMAILS')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
  }

  private requireDb(): void {
    if (!this.prisma.isEnabled()) {
      throw new ServiceUnavailableException(
        'Database is required for authentication sessions',
      );
    }
  }

  private isProd(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  private cookieOptions(maxAgeMs: number) {
    return {
      httpOnly: true,
      secure: this.isProd(),
      sameSite: 'lax' as const,
      path: '/',
      maxAge: maxAgeMs,
    };
  }

  setSessionCookie(response: Response, token: string): void {
    response.cookie(
      SESSION_COOKIE_NAME,
      token,
      this.cookieOptions(SESSION_IDLE_SECONDS * 1000),
    );
  }

  clearSessionCookie(response: Response): void {
    response.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: this.isProd(),
      sameSite: 'lax',
      path: '/',
    });
  }

  async loginWithGoogleIdToken(idToken: string): Promise<SessionUser> {
    if (!idToken || typeof idToken !== 'string') {
      throw new UnauthorizedException('Missing Google ID token');
    }

    let email: string | undefined;
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: this.getGoogleClientId(),
      });
      const payload = ticket.getPayload();
      email = payload?.email?.toLowerCase();
      if (!email || payload?.email_verified === false) {
        throw new UnauthorizedException('Google account email is not verified');
      }
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      this.logger.warn(`Google ID token verification failed: ${String(error)}`);
      throw new UnauthorizedException('Invalid Google ID token');
    }

    const allowed = this.getAllowedEmails();
    if (!allowed.includes(email)) {
      throw new ForbiddenException('This Google account is not allowed');
    }

    return { email };
  }

  async createSession(email: string): Promise<string> {
    this.requireDb();
    const normalized = email.toLowerCase();
    // Concurrent sessions are allowed (e.g. phone + desktop). Logout only
    // revokes the current cookie via revokeSession.

    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const now = new Date();
    const absoluteExpiresAt = new Date(
      now.getTime() + SESSION_ABSOLUTE_SECONDS * 1000,
    );

    await this.prisma.authSession.create({
      data: {
        tokenHash,
        email: normalized,
        lastSeenAt: now,
        absoluteExpiresAt,
      },
    });

    return token;
  }

  async resolveSession(token: string | undefined): Promise<ResolvedSession | null> {
    if (!token || typeof token !== 'string' || token.length < 32) {
      return null;
    }
    if (!this.prisma.isEnabled()) {
      return null;
    }

    const tokenHash = hashSessionToken(token);
    const row = await this.prisma.authSession.findUnique({
      where: { tokenHash },
    });
    if (!row) {
      return null;
    }

    const now = Date.now();
    if (row.absoluteExpiresAt.getTime() <= now) {
      await this.prisma.authSession
        .delete({ where: { id: row.id } })
        .catch(() => undefined);
      return null;
    }

    const idleMs = SESSION_IDLE_SECONDS * 1000;
    if (now - row.lastSeenAt.getTime() > idleMs) {
      await this.prisma.authSession
        .delete({ where: { id: row.id } })
        .catch(() => undefined);
      return null;
    }

    return {
      email: row.email,
      sessionId: row.id,
      token,
      lastSeenAt: row.lastSeenAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
    };
  }

  async touchSession(
    session: ResolvedSession,
    response: Response,
  ): Promise<void> {
    if (!this.prisma.isEnabled()) {
      return;
    }

    const now = Date.now();
    const throttleMs = SESSION_TOUCH_THROTTLE_SECONDS * 1000;
    if (now - session.lastSeenAt.getTime() < throttleMs) {
      return;
    }

    const lastSeenAt = new Date(now);
    await this.prisma.authSession.update({
      where: { id: session.sessionId },
      data: { lastSeenAt },
    });
    this.setSessionCookie(response, session.token);
  }

  async revokeSession(token: string | undefined): Promise<void> {
    if (!token || !this.prisma.isEnabled()) {
      return;
    }
    const tokenHash = hashSessionToken(token);
    await this.prisma.authSession
      .deleteMany({ where: { tokenHash } })
      .catch(() => undefined);
  }
}

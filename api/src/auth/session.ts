import { createHash, randomBytes } from 'crypto';

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

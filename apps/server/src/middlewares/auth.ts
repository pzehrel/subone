import type { HonoRequest } from 'hono';
import { createMiddleware } from 'hono/factory';
import crypto from 'crypto';
import { getAppConfig } from '../context';

export const activeSessions = new Map<string, { createdAt: number }>();
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function isValidSession(token?: string): boolean {
  if (!token) return false;
  const session = activeSessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

export function createSession(): string {
  const sessionToken = `sess_${crypto.randomBytes(24).toString('hex')}`;
  activeSessions.set(sessionToken, { createdAt: Date.now() });
  return sessionToken;
}

export function destroySession(token: string): void {
  activeSessions.delete(token);
}

export function extractBearerToken(req: HonoRequest): string | undefined {
  const authHeader = req.header('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  if (req.header('x-auth-token')) {
    return req.header('x-auth-token');
  }
  return undefined;
}

export const requireAuth = createMiddleware(async (c, next) => {
  const appConfig = getAppConfig();
  if (!appConfig.settings.adminPassword) {
    return await next();
  }
  const token = extractBearerToken(c.req);
  if (isValidSession(token)) {
    return await next();
  }
  return c.json({ success: false, message: '请先登录管理控制台' }, 401);
});

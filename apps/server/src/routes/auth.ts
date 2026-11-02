import { Hono } from 'hono';
import type { BodyEnv } from '../middlewares/body';
import crypto from 'crypto';
import { getAppConfig } from '../context';
import { saveServerConfig, generateRandomSubToken } from '../storage/db';
import {
  activeSessions,
  isValidSession,
  createSession,
  destroySession,
  extractBearerToken,
  requireAuth,
} from '../middlewares/auth';

export const authRouter = new Hono<BodyEnv>({ strict: false });

// Public Auth Endpoints
authRouter.get('/auth/status', (c) => {
  const appConfig = getAppConfig();
  const hasPassword = Boolean(appConfig.settings.adminPassword);
  const token = extractBearerToken(c.req);
  const authenticated = !hasPassword || isValidSession(token);
  return c.json({ success: true, authRequired: hasPassword, authenticated });
});

authRouter.post('/auth/login', (c) => {
  const body = c.get('body');
  const { password } = body;
  const appConfig = getAppConfig();
  const adminPassword = appConfig.settings.adminPassword;
  if (!adminPassword) {
    const sessionToken = createSession();
    return c.json({ success: true, token: sessionToken });
  }

  if (!password || typeof password !== 'string') {
    return c.json({ success: false, message: '请输入密码' }, 401);
  }

  const a = Buffer.from(password);
  const b = Buffer.from(adminPassword);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    const sessionToken = createSession();
    return c.json({ success: true, token: sessionToken });
  }

  return c.json({ success: false, message: '密码错误，请重新输入' }, 401);
});

authRouter.post('/auth/logout', (c) => {
  const token = extractBearerToken(c.req);
  if (token) destroySession(token);
  return c.json({ success: true, message: '已退出登录' });
});

authRouter.post('/auth/change-password', requireAuth, (c) => {
  const body = c.get('body');
  const { oldPassword, newPassword } = body;
  const appConfig = getAppConfig();
  if (!newPassword || typeof newPassword !== 'string' || newPassword.trim().length === 0) {
    return c.json({ success: false, message: '新密码不能为空' }, 400);
  }

  if (appConfig.settings.adminPassword) {
    if (!oldPassword || oldPassword !== appConfig.settings.adminPassword) {
      return c.json({ success: false, message: '旧密码验证失败' }, 400);
    }
  }

  appConfig.settings.adminPassword = newPassword.trim();
  saveServerConfig({ adminPassword: newPassword.trim() });
  return c.json({ success: true, message: '密码修改成功' });
});

authRouter.post('/settings/regenerate-sub-token', requireAuth, (c) => {
  const appConfig = getAppConfig();
  const newToken = generateRandomSubToken();
  appConfig.settings.subToken = newToken;
  saveServerConfig({ subToken: newToken });
  return c.json({ success: true, subToken: newToken });
});

import { createMiddleware } from 'hono/factory';
import qs from 'qs';

export type BodyEnv = {
  Variables: {
    body: Record<string, any>;
  };
};

export const parseRequestBody = createMiddleware<BodyEnv>(async (c, next) => {
  const contentType = c.req.header('content-type')?.split(';', 1)[0].trim().toLowerCase();
  let body: Record<string, any> = {};

  if (contentType === 'application/json' || contentType === 'application/x-www-form-urlencoded') {
    const text = await c.req.text();
    if (text) {
      if (contentType === 'application/json') {
        try {
          body = JSON.parse(text);
          if (body === null || typeof body !== 'object') {
            return c.text('Bad Request', 400);
          }
        } catch {
          return c.text('Bad Request', 400);
        }
      } else {
        body = qs.parse(text, { depth: 32, parameterLimit: 1000 });
      }
    }
  }

  c.set('body', body);
  await next();
});

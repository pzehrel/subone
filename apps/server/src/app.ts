import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'node:path';
import fs from 'node:fs';
import { requireAuth } from './middlewares/auth';
import { parseRequestBody, type BodyEnv } from './middlewares/body';
import { authRouter } from './routes/auth';
import { apiRouter } from './routes/api';
import { subRouter } from './routes/sub';
import { projectRoot } from './paths';

export function createApp() {
  const app = new Hono<BodyEnv>({ strict: false });

  app.use('*', cors({ allowMethods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'] }));
  app.use('*', bodyLimit({
    maxSize: 20 * 1024 * 1024,
    onError: (c) => c.text('Payload Too Large', 413),
  }));
  app.use('*', parseRequestBody);

  // Auth routes (handles /api/auth/status, /api/auth/login, etc.)
  app.route('/api', authRouter);

  // Protect all other /api routes
  app.use('/api/*', requireAuth);

  // Admin REST API
  app.route('/api', apiRouter);

  // Subscription serving routes (/s/:subToken...)
  app.route('/', subRouter);

  // Legacy /sub routes return silent 404
  app.all('/sub', (c) => c.text('404 Not Found', 404));
  app.all('/sub/*', (c) => c.text('404 Not Found', 404));

  // Static files (Web UI)
  const webDistPath = path.join(projectRoot, 'apps/web/dist');
  if (fs.existsSync(webDistPath)) {
    app.use('*', serveStatic({ root: webDistPath }));
    app.get('*', (c, next) => {
      if (!c.req.path.startsWith('/api') && !c.req.path.startsWith('/s/')) {
        return serveStatic({ path: path.join(webDistPath, 'index.html') })(c, next);
      }
      return next();
    });
  }

  app.notFound((c) => c.text('404 Not Found', 404));
  return app;
}

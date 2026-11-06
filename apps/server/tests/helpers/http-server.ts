import { serve } from '@hono/node-server';
import { createApp } from '../../src/app';

const app = createApp();
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => {
  process.send?.({ port: info.port });
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));

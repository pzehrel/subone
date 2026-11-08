import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer as createViteServer } from 'vite';

test('development proxy preserves the public host for previews and subscriptions', async t => {
  const backend = createHttpServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ host: req.headers.host, path: req.url, method: req.method }));
  });
  t.after(() => new Promise((resolve, reject) => backend.close(error => error ? reject(error) : resolve())));
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');

  const previousPort = process.env.PORT;
  let vite;
  try {
    process.env.PORT = String(backend.address().port);
    vite = await createViteServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null },
      logLevel: 'silent',
    });
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
  t.after(() => vite.close());
  await vite.listen();
  const port = vite.httpServer.address().port;
  const publicHost = '192.0.2.5:5173';

  for (const [path, method] of [['/api/generate/preview', 'POST'], ['/s/test-token/qx', 'GET']]) {
    await t.test(path, async () => {
      const forwarded = await new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path, method, headers: { Host: publicHost }, agent: false }, res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            try {
              assert.equal(res.statusCode, 200);
              resolve(JSON.parse(body));
            } catch (error) { reject(error); }
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
      assert.deepEqual(forwarded, { host: publicHost, path, method });
    });
  }
});

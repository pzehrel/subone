import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before } from 'node:test';

/** Each suite owns its server and data directory, including across restarts. */
export function httpApp(prefix: string) {
  let directory: string;
  let child: ChildProcess;
  let origin: string;
  async function start() {
    child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'http-server.ts')], {
      env: { ...process.env, SUBONE_ROOT: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let errors = '';
    child.stderr?.on('data', chunk => { errors += chunk; });
    const [message] = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(([code]) => { throw new Error(`Server exited ${code}: ${errors}`); }),
    ]);
    origin = `http://127.0.0.1:${message.port}`;
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), prefix));
    await writeFile(join(directory, 'config.json'), JSON.stringify({ port: 3456, adminPassword: '' }));
    await start();
  });
  after(async () => {
    try { await stop(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  });
  return {
    get origin() { return origin; },
    async restart() { await stop(); await start(); },
    async api(path: string, method = 'GET', value?: unknown) {
      const response = await fetch(`${origin}/api${path}`, {
        method, headers: { 'Content-Type': 'application/json' },
        body: value === undefined ? undefined : JSON.stringify(value),
      });
      return { status: response.status, ...(await response.json() as any) };
    },
  };
}

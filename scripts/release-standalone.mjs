import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const evidenceDirectory = path.join(root, 'artifacts/standalone-smoke');
fs.rmSync(evidenceDirectory, { recursive: true, force: true });

await run('standalone assets', 'node', ['scripts/verify-standalone-assets.mjs']);
await run('automated tests', 'npm', ['test']);

await buildAndSmoke({ profile: 'root', base: '/', port: 4173 });
await buildAndSmoke({ profile: 'project', base: '/test1/', port: 4174 });
await run('browser evidence', 'node', ['scripts/verify-standalone-evidence.mjs']);
console.log('[release] standalone release profile passed');

async function buildAndSmoke({ profile, base, port }) {
  await run(`${profile} production build`, 'npm', ['run', 'build'], { VITE_BASE_PATH: base });
  const server = spawn(path.join(root, 'node_modules/.bin/vite'), ['preview', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, VITE_BASE_PATH: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => process.stdout.write(`[preview:${profile}] ${chunk}`));
  server.stderr.on('data', (chunk) => process.stderr.write(`[preview:${profile}] ${chunk}`));
  const url = `http://127.0.0.1:${port}${base}`;
  try {
    await waitForServer(url, 30_000, server);
    await run(`${profile} browser smoke`, 'node', ['scripts/smoke-standalone.mjs'], {
      GAME_URL: url,
      SMOKE_PROFILE: profile,
    });
  } finally {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }
}

function run(label, command, args, environment = {}) {
  console.log(`[release] ${label}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: 'inherit',
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${label} exceeded 12 minutes`));
    }, 12 * 60 * 1000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function waitForServer(url, timeoutMs, server) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`preview server exited with code ${server.exitCode}: ${url}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* Preview is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`preview server did not become ready: ${url}`);
}

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(resolve(root, '.local'), { recursive: true });
const environment = {
  ...process.env,
  DATABASE_MODE: 'embedded',
  PGLITE_PATH: resolve(root, '.local', 'preview-db'),
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
  HOST: '127.0.0.1',
  PORT: '3000',
};
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'backend/src/server.ts'], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
function watch(child) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code || 0));
}
children.forEach(watch);
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
const startedAt = Date.now();
let ready = false;
while (!stopping && Date.now() - startedAt < 30_000) {
  try {
    const response = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(500) });
    const health = await response.json();
    if (response.ok && health.service === 'wisdom-tree') { ready = true; break; }
  } catch { /* The API is still initializing its database. */ }
  await delay(250);
}
if (!stopping && ready) {
  const web = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { cwd: resolve(root, 'frontend'), env: environment, stdio: 'inherit', windowsHide: true });
  children.push(web); watch(web);
  console.log('Local preview: http://127.0.0.1:5173 (embedded PostgreSQL kernel; production uses PostgreSQL).');
} else if (!stopping) {
  console.error('API 未能在 30 秒内就绪，请检查数据库和端口。'); stop(1);
}

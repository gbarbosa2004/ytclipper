import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

test('HTTP API: local-only access, input validation, and no exposure of project files', { timeout: 20_000 }, async () => {
  const port = 46000 + Math.floor(Math.random() * 10000);
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.mjs'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(server, 'exit');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server did not start')), 10_000);
      server.stdout.on('data', data => { if (data.toString().includes(origin)) { clearTimeout(timer); resolve(); } });
      server.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited before startup')); });
    });
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('Export MP4'));
    assert.ok(page.headers.get('content-security-policy').includes("frame-ancestors 'self'"));
    assert.equal((await fetch(`${origin}/api/status`).then(r => r.json())).destination, '~/Downloads');
    assert.equal((await fetch(`${origin}/api/status`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    // fetch ignores a custom Host header; use the HTTP client to exercise DNS-rebinding protection.
    const untrustedHost = await new Promise((resolve, reject) => {
      http.get(`${origin}/api/status`, { headers: { Host: `evil.example:${port}` } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(untrustedHost, 403);
    assert.equal((await fetch(`${origin}/api/video`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://127.0.0.1/private' }) })).status, 400);
    assert.equal((await fetch(`${origin}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await fetch(`${origin}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'invalid' })).status, 400);
    for (const resource of ['/server.mjs', '/package.json', '/api/exports/unknown', '/%2e%2e/server.mjs']) assert.equal((await fetch(`${origin}${resource}`)).status, 404);
  } finally {
    server.kill('SIGTERM');
    await exited;
  }
});

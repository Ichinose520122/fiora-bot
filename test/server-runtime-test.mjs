import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { applyEnvironment } from '../src/environment.js';
import { ensureConfig } from '../scripts/start.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
test('deployment environment overrides non-empty values and preserves migrated configuration', () => {
  const config = { fiora: { url: 'https://old.example', apiKey: 'saved-key' }, api: { model: 'old-model' }, server: { port: 3210 } };
  const result = applyEnvironment(config, { FIORA_BOT_KEY: '', FIORA_URL: 'https://new.example',
    MODEL_NAME: 'new-model', QQ_AGENT_HOST: '0.0.0.0', QQ_AGENT_PORT: '3220', FIORA_ENABLED: 'true' });
  assert.equal(result.fiora.apiKey, 'saved-key');
  assert.equal(result.fiora.url, 'https://new.example');
  assert.equal(result.fiora.enabled, true);
  assert.equal(result.server.host, '0.0.0.0');
  assert.equal(result.server.port, 3220);
  assert.equal(result.api.model, 'new-model');
  assert.throws(() => applyEnvironment({}, { QQ_AGENT_PORT: 'NaN' }), /QQ_AGENT_PORT/);
  assert.throws(() => applyEnvironment({}, { FIORA_ENABLED: 'invalid' }), /FIORA_ENABLED/);
});

test('first-start initialization never overwrites an existing configuration', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiora-init-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = ensureConfig(root, { QQ_AGENT_DATA_DIR: dataDir });
  const initial = JSON.parse(fs.readFileSync(file));
  assert.equal(initial.fiora.apiKey, '');
  fs.writeFileSync(file, '{"marker":"preserved"}');
  ensureConfig(root, { QQ_AGENT_DATA_DIR: dataDir });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { marker: 'preserved' });
});

test('Linux server binds its configured address and shuts down cleanly on SIGTERM',
  { skip: process.platform === 'win32' ? 'POSIX signal behavior is verified by Linux CI and Docker smoke tests' : false, timeout: 25000 }, async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiora-server-test-'));
    const reservation = http.createServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const child = spawn(process.execPath, ['scripts/start.mjs'], { cwd: root,
      env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_HOST: '0.0.0.0', QQ_AGENT_PORT: String(port),
        FIORA_ENABLED: 'true', FIORA_URL: '', FIORA_BOT_KEY: '', MODEL_API_KEY: '', QQ_AGENT_TELEMETRY: '0' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) });
        if (response.ok && (await response.text()).includes('<html')) { ready = true; break; }
      } catch { /* Wait until the real HTTP server has started. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(ready, output);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, output);
    assert.equal(fs.existsSync(path.join(dataDir, 'fiora-bot.lock')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'))).fiora.enabled, true);
  });

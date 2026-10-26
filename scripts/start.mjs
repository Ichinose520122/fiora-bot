import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function ensureConfig(root, env = process.env) {
  const dir = env.QQ_AGENT_DATA_DIR || path.join(root, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(file, fs.readFileSync(path.join(root, 'config', 'config.example.json')), { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureConfig(fileURLToPath(new URL('..', import.meta.url)));
  await import('../src/server.js');
}

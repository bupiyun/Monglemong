import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { prepareClient, resolveFlavor } from './prepare-client.mjs';

const root = resolve(import.meta.dirname, '..');
try {
  const flavor = resolveFlavor(process.argv[2] || 'user');
  const prepared = prepareClient({ flavor });
  const runtime = spawnSync(process.execPath, [resolve(root, 'scripts/ensure-electron.mjs')], { cwd: root, stdio: 'inherit', shell: false });
  if (runtime.error || runtime.status !== 0) throw new Error('Electron runtime setup failed.');
  const require = createRequire(import.meta.url);
  const executable = require('electron');
  const child = spawn(executable, [prepared.directory], { cwd: root, stdio: 'inherit', shell: false });
  child.on('error', () => { console.error('Could not launch MongleMong.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) { console.error(error.message); process.exitCode = 1; }

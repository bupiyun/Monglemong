import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
try {
  const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  if (resolve(top) !== root) throw new Error('This source folder is not its own Git checkout. Hooks were not installed in the containing repository.');
  const hook = resolve(root, '.githooks/pre-push');
  if (!readFileSync(hook, 'utf8').includes('check-public-source.mjs --pre-push')) throw new Error('The public source pre-push hook is missing.');
  let existing = '';
  try { existing = execFileSync('git', ['-C', root, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim(); } catch {}
  if (existing && existing !== '.githooks') throw new Error(`Existing hooksPath (${existing}) was preserved. Add the public source pre-push check to that hook before publishing.`);
  chmodSync(hook, 0o755);
  execFileSync('git', ['-C', root, 'config', '--local', 'core.hooksPath', '.githooks']);
  console.log('Installed the user source pre-push check for this checkout. GitHub CI also checks committed snapshots.');
} catch (error) { console.error(error.message); process.exitCode = 1; }

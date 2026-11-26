import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const POLICY = 'public-source-policy.json';
const SHA = /^[0-9a-f]{40,64}$/;
const ZERO = /^0+$/;
const PRIVATE_PATH = /(?:^|\/)(?:server|private|private-workspace|monglemong-private|node_modules|release|build-clients|test-results|coverage|playwright-report)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)(?:admin\.[^/]+|(?:build|start)-windows-admin\.cmd|compose\.ya?ml|Dockerfile|\.dockerignore)$|\.(?:exe|zip|7z|tar|gz|sqlite(?:-wal|-shm)?|db|pem|key|p12|pfx|dmg|AppImage|blockmap)$/i;
const privatePath = path => PRIVATE_PATH.test(path) || (/^assets\/characters\//i.test(path) && !path.endsWith('/') && path !== 'assets/characters/cafemong.png');
const PRIVATE_RUNTIME = /\/v1\/admin(?:\/|["'`])|(?:from\s*|import\s*\(\s*)["']\.\/admin\.js["']|settings-admin|mountCharacterAdmin/;

function git(repository, args, options = {}) {
  try { return execFileSync('git', ['--no-replace-objects', '-C', repository, ...args], { encoding: 'utf8', maxBuffer: 48 * 1024 * 1024, ...options }); }
  catch (error) { throw new Error(`Git source inspection failed (${args[0]}). Fetch the full repository and resolve conflicts before publishing.`, { cause: error }); }
}
function ownCheckout(repository) {
  const top = git(repository, ['rev-parse', '--show-toplevel']).trim();
  if (resolve(top) !== resolve(repository)) throw new Error('This source folder is not its own Git checkout. Use --worktree for a downloaded source archive.');
}
function commit(repository, value) {
  if (!SHA.test(value)) throw new Error('A full Git object SHA is required.');
  return git(repository, ['rev-parse', '--verify', `${value}^{commit}`]).trim();
}
function blob(repository, oid) { return git(repository, ['cat-file', 'blob', oid]); }
function entries(repository, reference) {
  const records = reference === 'index'
    ? git(repository, ['ls-files', '--stage', '-z'])
    : git(repository, ['ls-tree', '-r', '-z', reference]);
  return records.split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    const fields = record.slice(0, tab).split(' ');
    if (reference === 'index' && fields[2] !== '0') throw new Error('Resolve all staged merge conflicts before publishing.');
    return { path: record.slice(tab + 1), mode: fields[0], oid: fields[reference === 'index' ? 1 : 2] };
  });
}
function readPolicy(files, read) {
  const entry = files.find(file => file.path === POLICY);
  if (!entry || entry.mode !== '100644') throw new Error(`Missing regular ${POLICY} in the inspected Git snapshot.`);
  let policy;
  try { policy = JSON.parse(read(entry.oid)); } catch { throw new Error('The public source allowlist is not valid JSON.'); }
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.files) || !policy.files.length
    || Object.keys(policy).some(key => !['schemaVersion', 'files'].includes(key))) throw new Error('Invalid public source allowlist.');
  const allowed = new Set();
  for (const path of policy.files) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')
      || path.split('/').some(part => !part || part === '.' || part === '..') || privatePath(path)
      || allowed.has(path.toLowerCase())) throw new Error(`Unsafe or duplicate allowlist entry: ${String(path)}`);
    allowed.add(path.toLowerCase());
  }
  return new Set(policy.files);
}

/** Inspect Git objects, never a cleaned working-tree substitute for staged data. */
export function checkSnapshot(repository = ROOT, reference = 'index') {
  ownCheckout(repository);
  if (reference !== 'index') reference = commit(repository, reference);
  const files = entries(repository, reference);
  return inspectFiles(reference, files, oid => blob(repository, oid));
}

function inspectFiles(reference, files, read) {
  const allowed = readPolicy(files, read);
  const problems = [];
  for (const entry of files) {
    const { path, mode, oid } = entry;
    if (!['100644', '100755'].includes(mode)) problems.push(`${path}: symlinks and submodules are not public source files`);
    if (privatePath(path) || !allowed.has(path)) problems.push(`${path}: not approved for the user source repository`);
    if (problems.length > 30) break;
    if (!['100644', '100755'].includes(mode)) continue;
    if (path === 'package.json') {
      let manifest;
      try { manifest = JSON.parse(read(oid)); } catch { problems.push('package.json: invalid JSON'); continue; }
      if (Object.entries(manifest.scripts || {}).some(([name, value]) => /(?:^|:)(?:admin|server)(?:$|:)/.test(name)
        || /(?:start-client|prepare-client|build-windows)\.mjs\s+admin\b|--prefix\s+server\b/.test(value))) {
        problems.push('package.json: private administrator/server commands must stay outside this repository');
      }
    }
    if (/^(?:src|electron)\//.test(path) && /\.(?:js|cjs|json)$/.test(path)) {
      const source = read(oid);
      if (PRIVATE_RUNTIME.test(source)) problems.push(`${path}: administrator authoring code or API routes are present`);
      if (path === 'src/runtime-config.json') {
        try { if (JSON.parse(source).flavor !== 'user') problems.push(`${path}: only the user flavor may be published`); }
        catch { problems.push(`${path}: invalid runtime configuration`); }
      }
    }
  }
  const present = new Set(files.map(file => file.path));
  for (const path of allowed) if (!present.has(path)) problems.push(`${path}: approved source file is missing from this snapshot`);
  if (problems.length) throw new Error(`Public source check rejected ${reference}:\n${problems.join('\n')}`);
  return { reference, files: files.length, paths: files.map(file => file.path) };
}

/** Explicit source-only inspection also works in a downloaded ZIP without Git. */
export function checkWorktree(repository = ROOT) {
  const ignored = new Set(['.git', 'node_modules', 'build-clients', 'release', 'test-results', 'playwright-report', 'coverage']);
  const files = [];
  function walk(directory, prefix = '') {
    for (const name of readdirSync(directory)) {
      if (!prefix && ignored.has(name)) continue;
      const path = prefix + name;
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        if (PRIVATE_PATH.test(path + '/')) throw new Error(`${path}: private directories must be outside the user checkout`);
        walk(absolute, path + '/');
      } else {
        files.push({ path, oid: absolute, mode: stat.isSymbolicLink() ? '120000' : stat.isFile() ? (stat.mode & 0o111 ? '100755' : '100644') : 'unsupported' });
      }
    }
  }
  walk(resolve(repository));
  return inspectFiles('working source', files, path => readFileSync(path, 'utf8'));
}

/** Every ancestor must be public source. A clean tip must not hide private
 * code in an older commit or in a merged branch. BASE is only a validated
 * transport value; after an authorized rewrite it need not exist locally.
 */
export function checkRange(repository, base, head) {
  ownCheckout(repository);
  if (base !== undefined && base !== null && base !== '' && !SHA.test(base)) {
    throw new Error('A full Git base object SHA or zero SHA is required.');
  }
  if (git(repository, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new Error('Fetch the full repository history before publishing. Shallow history cannot be verified.');
  }
  const grafts = resolve(repository, git(repository, ['rev-parse', '--git-path', 'info/grafts']).trim());
  if (existsSync(grafts) && readFileSync(grafts, 'utf8').trim()) {
    throw new Error('Remove local Git grafts before publishing. They can hide historical snapshots.');
  }
  const tip = commit(repository, head);
  const snapshots = git(repository, ['rev-list', tip]).trim().split('\n').filter(Boolean);
  for (const sha of snapshots) checkSnapshot(repository, sha);
  return snapshots.length;
}

/** Git pre-push input supplies actual objects, including annotated tag objects. */
export function checkPush(repository, input) {
  let count = 0;
  for (const line of input.trim().split('\n').filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !SHA.test(fields[1]) || !SHA.test(fields[3])) throw new Error('Invalid Git pre-push ref input.');
    const [, localSha, , remoteSha] = fields;
    if (ZERO.test(localSha)) continue; // Deleting a ref uploads no source.
    count += checkRange(repository, remoteSha, localSha);
  }
  return count;
}

function cli() {
  const [mode, first, second, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected public source check arguments.');
  let message;
  if (mode === '--pre-push' && !first) message = `${checkPush(ROOT, readFileSync(0, 'utf8'))} reachable snapshots`;
  else if (mode === '--commit' && first && !second) message = `${checkSnapshot(ROOT, first).files} committed files`;
  else if (mode === '--range' && first && second) message = `${checkRange(ROOT, first, second)} committed snapshots`;
  else if (mode === '--worktree' && !first) message = `${checkWorktree(ROOT).files} working source files`;
  else if ((!mode || mode === '--index') && !first) message = `${checkSnapshot(ROOT).files} staged files`;
  else throw new Error('Usage: check-public-source.mjs [--index | --worktree | --commit SHA | --range BASE HEAD | --pre-push]');
  console.log(`Public user source check passed: ${message}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

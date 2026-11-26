import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkSnapshot, checkWorktree, checkRange, checkPush } from '../scripts/check-public-source.mjs';

const zero = '0'.repeat(40);
function put(root, name, contents) {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), contents);
}
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function policy(root, extra = []) {
  put(root, 'public-source-policy.json', JSON.stringify({ schemaVersion: 1,
    files: ['.gitignore', 'package.json', 'public-source-policy.json', 'src/app.js', 'src/runtime-config.json', ...extra] }));
}
function commit(root, message) {
  git(root, 'add', '-A'); git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}
function fixture(t, { repository = true, dirtyHistory = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'monglemong-public-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let legacy;
  if (repository) {
    git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Source Check Test');
    git(root, 'config', 'user.email', 'source-check@example.test');
    if (dirtyHistory) {
      put(root, 'server/legacy.mjs', 'legacy private source must never be republished');
      legacy = commit(root, 'old private root');
      rmSync(join(root, 'server'), { recursive: true });
    }
  }
  put(root, '.gitignore', 'src/admin.js\nserver/\nnode_modules/\n');
  put(root, 'package.json', JSON.stringify({ name: 'test-user-client', scripts: { start: 'node scripts/start-client.mjs user' } }));
  put(root, 'src/app.js', 'export const userClient = true;\n');
  put(root, 'src/runtime-config.json', JSON.stringify({ flavor: 'user', apiBaseUrl: '' }));
  policy(root);
  const current = repository ? commit(root, 'clean user source') : null;
  return { root, legacy, current };
}

test('non-Git source archives are checked with the same exact source allowlist', t => {
  const { root } = fixture(t, { repository: false });
  put(root, 'node_modules/dependency/package.json', '{}');
  put(root, 'build-clients/user/package.json', '{}');
  const checked = checkWorktree(root);
  assert.equal(checked.files, 5);
  assert.ok(checked.paths.includes('src/app.js'));
  assert.ok(!checked.paths.some(path => path.startsWith('node_modules/')));
  put(root, 'src/unreviewed-helper.js', 'private implementation');
  assert.throws(() => checkWorktree(root), /not approved/);
});

test('forced ignored files are rejected from the index even when the worktree is cleaned', t => {
  const { root, current } = fixture(t);
  put(root, 'src/admin.js', 'private editor');
  git(root, 'add', '-f', 'src/admin.js');
  rmSync(join(root, 'src/admin.js'));
  assert.doesNotThrow(() => checkWorktree(root));
  assert.throws(() => checkSnapshot(root), /src\/admin\.js: not approved/);
  assert.doesNotThrow(() => checkSnapshot(root, current));
});

test('private files cannot be approved by adding them to the allowlist', t => {
  const { root } = fixture(t);
  put(root, 'server/auth.mjs', 'private server'); policy(root, ['server/auth.mjs']);
  git(root, 'add', '-f', 'server/auth.mjs'); git(root, 'add', 'public-source-policy.json');
  assert.throws(() => checkSnapshot(root), /Unsafe or duplicate allowlist/);
  assert.throws(() => checkWorktree(root), /private directories/);
});

test('allowed source filenames cannot carry private administrator runtime routes', t => {
  const { root } = fixture(t);
  put(root, 'src/app.js', "fetch('/v1/admin/characters');"); git(root, 'add', 'src/app.js');
  assert.throws(() => checkSnapshot(root), /administrator authoring code/);
});

test('admin commands and runtime flavors are rejected independently of filenames', t => {
  const { root } = fixture(t);
  put(root, 'package.json', JSON.stringify({ scripts: { 'dist:win:admin': 'node scripts/build-windows.mjs admin' } }));
  put(root, 'src/runtime-config.json', JSON.stringify({ flavor: 'admin' }));
  git(root, 'add', '-A');
  assert.throws(() => checkSnapshot(root), /private administrator\/server commands[\s\S]*only the user flavor/);
});

test('symlinks are rejected without following their external contents', t => {
  const { root } = fixture(t);
  rmSync(join(root, 'src/app.js'));
  symlinkSync('/does-not-exist/private-source', join(root, 'src/app.js'));
  git(root, 'add', 'src/app.js');
  assert.throws(() => checkSnapshot(root), /symlinks and submodules/);
  assert.throws(() => checkWorktree(root), /symlinks and submodules/);
});

test('every reachable snapshot is checked even when a clean base would hide older code', t => {
  const { root, current } = fixture(t);
  assert.equal(checkRange(root, zero, current), 1);
  assert.equal(checkPush(root, `refs/heads/main ${current} refs/heads/main ${zero}\n`), 1);
  put(root, 'src/admin.js', 'accidentally committed private editor'); git(root, 'add', '-f', 'src/admin.js');
  const dirty = commit(root, 'accidental private upload');
  rmSync(join(root, 'src/admin.js'));
  const cleanTip = commit(root, 'remove accidental file');
  assert.doesNotThrow(() => checkSnapshot(root, cleanTip));
  for (const base of [current, dirty, cleanTip, zero]) {
    assert.throws(() => checkRange(root, base, cleanTip), /src\/admin\.js/);
  }
  assert.throws(() => checkPush(root, `refs/heads/feature ${cleanTip} refs/heads/feature ${zero}\n`), /src\/admin\.js/);
});

test('an old private root has no legacy exception even when the current tree is clean', t => {
  const { root, legacy, current } = fixture(t, { dirtyHistory: true });
  assert.doesNotThrow(() => checkSnapshot(root, current));
  assert.throws(() => checkRange(root, legacy, current), /Missing regular public-source-policy/);
  assert.throws(() => checkRange(root, current, current), /Missing regular public-source-policy/);
});

test('a clean root can replace a remote whose old base object is absent locally', t => {
  const { root, current } = fixture(t);
  const unavailableBase = 'a'.repeat(40);
  assert.notEqual(spawnSync('git', ['-C', root, 'cat-file', '-e', unavailableBase], { stdio: 'ignore' }).status, 0);
  assert.equal(checkRange(root, unavailableBase, current), 1);
  assert.equal(checkPush(root, `refs/heads/main ${current} refs/heads/main ${unavailableBase}\n`), 1);
  assert.throws(() => checkRange(root, 'main', current), /full Git base object SHA/);
});

test('annotated tags check all target ancestry, including an old private root', t => {
  const { root, current } = fixture(t);
  git(root, 'tag', '-a', 'v-next', '-m', 'source release', current);
  const goodTag = git(root, 'rev-parse', 'v-next');
  assert.equal(checkPush(root, `refs/tags/v-next ${goodTag} refs/tags/v-next ${zero}\n`), 1);
  const dirty = fixture(t, { dirtyHistory: true });
  git(dirty.root, 'tag', '-a', 'old-source', '-m', 'must not republish', dirty.current);
  const badTag = git(dirty.root, 'rev-parse', 'old-source');
  assert.throws(() => checkPush(dirty.root, `refs/tags/old-source ${badTag} refs/tags/old-source ${zero}\n`), /Missing regular public-source-policy/);
});

test('a merge cannot reintroduce a private root behind an otherwise clean tree', t => {
  const { root, legacy, current } = fixture(t, { dirtyHistory: true });
  const tree = git(root, 'rev-parse', `${current}^{tree}`);
  const cleanRoot = git(root, 'commit-tree', tree, '-m', 'independent clean root');
  const merged = git(root, 'commit-tree', tree, '-p', cleanRoot, '-p', legacy, '-m', 'clean tree with private ancestry');
  assert.equal(checkRange(root, zero, cleanRoot), 1);
  assert.doesNotThrow(() => checkSnapshot(root, merged));
  assert.throws(() => checkRange(root, cleanRoot, merged), /Missing regular public-source-policy/);
});

test('local replacement refs cannot conceal private ancestors from the source check', t => {
  const { root, current } = fixture(t, { dirtyHistory: true });
  git(root, 'replace', '--graft', current);
  assert.equal(git(root, 'rev-list', '--count', current), '1');
  assert.throws(() => checkRange(root, zero, current), /Missing regular public-source-policy/);
});

test('legacy Git graft files must be removed before history is trusted', t => {
  const { root, current } = fixture(t, { dirtyHistory: true });
  put(root, '.git/info/grafts', current + '\n');
  assert.throws(() => checkRange(root, zero, current), /Remove local Git grafts/);
});

test('shallow checkouts cannot claim that all historical snapshots were checked', t => {
  const { root, current } = fixture(t);
  put(root, '.git/shallow', current + '\n');
  assert.throws(() => checkRange(root, zero, current), /Shallow history cannot be verified/);
});

test('ref deletions upload nothing and missing source files fail closed', t => {
  const { root, current } = fixture(t);
  assert.equal(checkPush(root, `(delete) ${zero} refs/heads/old ${current}\n`), 0);
  git(root, 'rm', 'src/app.js');
  assert.throws(() => checkSnapshot(root), /approved source file is missing/);
  assert.throws(() => checkPush(root, 'invalid hook input'), /Invalid Git pre-push/);
});

test('hook installation never changes a containing repository for an extracted source folder', t => {
  const { root } = fixture(t);
  const extracted = join(root, 'downloaded-source');
  mkdirSync(join(extracted, 'scripts'), { recursive: true });
  cpSync(resolve(import.meta.dirname, '../scripts/install-git-hooks.mjs'), join(extracted, 'scripts/install-git-hooks.mjs'));
  const result = spawnSync(process.execPath, [join(extracted, 'scripts/install-git-hooks.mjs')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not its own Git checkout/);
  const config = readFileSync(join(root, '.git/config'), 'utf8');
  assert.ok(!config.includes('hooksPath'));
});

test('private character art cannot be added to the public allowlist', t => {
  const { root } = fixture(t);
  put(root, 'assets/characters/unreleased.png', 'private sprite');
  policy(root, ['assets/characters/unreleased.png']);
  git(root, 'add', '-A');
  assert.throws(() => checkSnapshot(root), /Unsafe or duplicate allowlist/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureElectron, isElectronReady } from '../scripts/ensure-electron.mjs';

function fixture(t, installer) {
  // Spaces in the path exercise the shell-free invocation used on Windows.
  const root = mkdtempSync(join(tmpdir(), 'mori setup test '));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const directory = join(root, 'node_modules', 'electron');
  mkdirSync(directory, {recursive:true});
  writeFileSync(join(directory, 'package.json'), JSON.stringify({name:'electron',version:'45.4.1'}));
  if (installer !== undefined) writeFileSync(join(directory, 'install.js'), installer);
  return {root,directory};
}
const installFixture = `
const fs = require('node:fs'); const path = require('node:path');
const marker = path.join(__dirname, 'runs.txt');
fs.writeFileSync(marker, String(Number(fs.existsSync(marker) ? fs.readFileSync(marker,'utf8') : 0) + 1));
fs.mkdirSync(path.join(__dirname, 'dist'), {recursive:true});
fs.writeFileSync(path.join(__dirname, 'dist', 'electron.exe'), 'fixture executable');
fs.writeFileSync(path.join(__dirname, 'dist', 'version'), '45.4.1');
fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron.exe');
`;
const silent = () => {};

test('a package with no lifecycle scripts gets its runtime via the explicit official entry point', t => {
  const {root,directory} = fixture(t, installFixture);
  assert.equal(isElectronReady(directory,'45.4.1','win32'),false);
  ensureElectron({root,platform:'win32',log:silent});
  assert.equal(isElectronReady(directory,'45.4.1','win32'),true);
  assert.equal(readFileSync(join(directory,'runs.txt'),'utf8'),'1');
  ensureElectron({root,platform:'win32',log:silent});
  assert.equal(readFileSync(join(directory,'runs.txt'),'utf8'),'1','A ready runtime must not be downloaded again');
});

test('partial and outdated runtime installations are repaired without reinstalling dependencies', t => {
  const {root,directory} = fixture(t, installFixture);
  const sentinel = join(root, 'node_modules', 'unrelated-package.txt');
  writeFileSync(sentinel,'keep me');
  for (const damage of ['missing-executable','wrong-version','wrong-platform-path']) {
    ensureElectron({root,platform:'win32',log:silent});
    if (damage === 'missing-executable') rmSync(join(directory,'dist','electron.exe'));
    if (damage === 'wrong-version') writeFileSync(join(directory,'dist','version'),'44.0.0');
    if (damage === 'wrong-platform-path') writeFileSync(join(directory,'path.txt'),'electron');
    assert.equal(isElectronReady(directory,'45.4.1','win32'),false);
    ensureElectron({root,platform:'win32',log:silent});
    assert.equal(isElectronReady(directory,'45.4.1','win32'),true);
    assert.equal(readFileSync(sentinel,'utf8'),'keep me');
  }
});

test('a failed download stops startup and can be retried successfully', t => {
  const {root,directory} = fixture(t, 'process.exit(7);');
  assert.throws(() => ensureElectron({root,platform:'win32',log:silent}), /download failed \(7\)/);
  assert.equal(existsSync(join(directory,'path.txt')),false);
  writeFileSync(join(directory,'install.js'),installFixture);
  ensureElectron({root,platform:'win32',log:silent});
  assert.equal(isElectronReady(directory,'45.4.1','win32'),true);
});

test('a zero installer exit without a runtime does not claim success', t => {
  const {root} = fixture(t, 'process.exit(0);');
  assert.throws(() => ensureElectron({root,platform:'win32',log:silent}), /without a usable runtime/);
});

test('missing package or installer has actionable errors', t => {
  const {root,directory} = fixture(t);
  assert.throws(() => ensureElectron({root,platform:'win32',log:silent}), /installer is missing/);
  rmSync(join(directory,'package.json'));
  assert.throws(() => ensureElectron({root,platform:'win32',log:silent}), /package is missing/);
});

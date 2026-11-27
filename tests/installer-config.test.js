import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, normalize, resolve, win32 } from 'node:path';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { variantManifest } from '../scripts/prepare-client.mjs';
import { readPE, embeddedArchive, assertRuntimeMembers, assertPackagedManifest, verifyRuntimeArchive } from '../scripts/verify-windows-package.mjs';

const require = createRequire(import.meta.url);
const { createTransformer } = require('app-builder-lib/out/fileTransformer.js');
const asar = require('@electron/asar');
const root=resolve(import.meta.dirname,'..');
const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));

test('Windows release is an offline NSIS installer with persistent shortcuts',()=>{
  const target=Array.isArray(pkg.build.win.target) ? pkg.build.win.target : [pkg.build.win.target];
  assert.ok(target.some(item=>(typeof item==='string' ? item : item.target)==='nsis'));
  assert.ok(!target.some(item=>(typeof item==='string' ? item : item.target)==='nsis-web'));
  assert.equal(pkg.build.nsis.createStartMenuShortcut,true);
  assert.ok([true,'always'].includes(pkg.build.nsis.createDesktopShortcut));
  assert.equal(pkg.build.productName,'MongleMong');
  assert.equal(pkg.build.nsis.shortcutName,'몽글몽');
  assert.equal(pkg.build.nsis.uninstallDisplayName,'몽글몽');
  assert.equal(pkg.build.nsis.artifactName,'MongleMong-Setup-${version}-${arch}.${ext}');
  assert.equal(pkg.build.nsis.runAfterFinish,true);
});

test('installation is per-user and uninstall preserves game data',()=>{
  assert.equal(pkg.build.appId,'studio.mori.desktop');
  assert.equal(pkg.build.nsis.perMachine,false);
  assert.equal(pkg.build.nsis.allowElevation,false);
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall,false);
  assert.equal(pkg.main,'electron/main.cjs');
  assert.ok(pkg.build.files.includes('assets/**'));
  assert.ok(pkg.build.files.includes('electron/**'));
});

test('runtime archive allows the hidden window collector while excluding development launchers',()=>{
  assert.doesNotThrow(()=>assertRuntimeMembers(['index.html', 'electron/main.cjs', 'electron/native/window-surfaces.ps1']));
  for (const file of ['build-windows.cmd', 'start.bat', 'scripts/setup.js', 'tests/engine.test.js', 'node_modules/tool/index.js', 'electron/native/other.ps1']) {
    assert.throws(()=>assertRuntimeMembers(['electron/native/window-surfaces.ps1', file]), /Developer tools or console launchers/);
  }
});

test('PE reader distinguishes GUI and console executables and rejects malformed binaries',t=>{
  const directory=mkdtempSync(join(tmpdir(),'MongleMong-pe-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const bytes=Buffer.alloc(512);
  bytes.write('MZ');bytes.writeUInt32LE(128,0x3c);bytes.write('PE\0\0',128);
  bytes.writeUInt16LE(0x8664,132);bytes.writeUInt16LE(240,148);bytes.writeUInt16LE(0x20b,152);
  bytes.writeUInt16LE(2,220);
  const file=join(directory,'fixture.exe');writeFileSync(file,bytes);
  assert.deepEqual(readPE(file),{machine:0x8664,format:0x20b,subsystem:2,size:512});
  bytes.writeUInt16LE(3,220);writeFileSync(file,bytes);
  assert.equal(readPE(file).subsystem,3);
  bytes.writeUInt32LE(500,0x3c);writeFileSync(file,bytes);
  assert.throws(()=>readPE(file),/Invalid PE header location/);
  writeFileSync(file,Buffer.from('not an executable'));
  assert.throws(()=>readPE(file),/Missing DOS header/);
});

test('offline payload check rejects a generator stub and truncated application data',()=>{
  assert.throws(()=>embeddedArchive(Buffer.alloc(150_880)),/Installer is incomplete/);
  const bytes=Buffer.alloc(1_100_100);
  Buffer.from([0x37,0x7a,0xbc,0xaf,0x27,0x1c]).copy(bytes,100);
  bytes.writeBigUInt64LE(1_099_900n,112);
  bytes.writeBigUInt64LE(68n,120);
  assert.equal(embeddedArchive(bytes).length,1_100_000);
  assert.throws(()=>embeddedArchive(bytes.subarray(0,150_880)),/Installer is incomplete/);
});

test('package verification accepts electron-builder cleaned metadata and rejects changed runtime identity', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'MongleMong-package-metadata-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const flavor of ['user']) {
    const source = variantManifest(pkg, flavor);
    const file = join(directory, 'package.json');
    writeFileSync(file, JSON.stringify(source));
    // Exercise the installed builder's real transformation, without building
    // or executing an installer, rather than assuming it preserves build.appId.
    const transformed = await createTransformer(directory, source.build)(file);
    const manifest = JSON.parse(transformed);
    assert.equal(manifest.build, undefined);
    assert.equal(manifest.name, source.name);
    assert.doesNotThrow(() => assertPackagedManifest(manifest, source));
    for (const [field, value] of [['name', 'wrong-client'], ['version', '0.0.0'], ['main', 'wrong-entry.cjs'], ['type', 'commonjs']]) {
      assert.throws(() => assertPackagedManifest({ ...manifest, [field]: value }, source));
    }
    assert.throws(() => assertPackagedManifest({ ...manifest, main: 'wrong-entry.cjs' }, { ...source, main: 'wrong-entry.cjs' }), /launch Electron directly/);
  }
});

async function runtimeArchiveFixture(t, flavor = 'user') {
  // Real ASAR files exercise host-native member lookup. The Windows CI job
  // executes this same verifier, with no installer or Electron executable.
  const directory = mkdtempSync(join(tmpdir(), 'MongleMong ASAR 검사-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, 'prepared source');
  const manifest = variantManifest(pkg, flavor);
  const files = {
    'index.html': '<!doctype html><title>MongleMong fixture</title>',
    'src/runtime-config.json': JSON.stringify({ flavor, apiBaseUrl: 'https://game.example.com' }),
    'assets/characters/cafemong.png': readFileSync(join(root, 'assets/characters/cafemong.png')),
    'electron/main.cjs': "'use strict';\n",
    'electron/native/window-surfaces.ps1': readFileSync(join(root, 'electron/native/window-surfaces.ps1')),
    'package.json': JSON.stringify(manifest),
  };
  for (const [name, bytes] of Object.entries(files)) {
    const file = join(sourceRoot, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  let sequence = 0;
  return {
    sourceRoot, flavor, approvedPaths: Object.keys(files), runtimeFileCount: Object.keys(files).length - 1,
    async pack(mutate = () => {}) {
      const packaged = join(directory, `packaged-${++sequence}`);
      cpSync(sourceRoot, packaged, { recursive: true });
      const packageFile = join(packaged, 'package.json');
      writeFileSync(packageFile, await createTransformer(packaged, manifest.build)(packageFile));
      mutate(packaged);
      const archive = join(directory, `app-${sequence}.asar`);
      await asar.createPackage(packaged, archive);
      t.after(() => asar.uncache(archive));
      return archive;
    },
  };
}

test('real ASAR verification reads original Cafemong and nested runtime members on the host platform', async t => {
  for (const flavor of ['user']) {
    const fixture = await runtimeArchiveFixture(t, flavor);
    const archive = await fixture.pack();
    const verified = verifyRuntimeArchive({ ...fixture, archive });
    assert.equal(verified, fixture.runtimeFileCount);
    const image = asar.extractFile(archive, normalize('assets/characters/cafemong.png'));
    assert.deepEqual(image, readFileSync(join(root, 'assets/characters/cafemong.png')));
  }
});

test('real ASAR verification still rejects missing or changed Cafemong artwork', async t => {
  const fixture = await runtimeArchiveFixture(t);
  const missing = await fixture.pack(directory => rmSync(join(directory, 'assets/characters/cafemong.png')));
  assert.throws(() => verifyRuntimeArchive({ ...fixture, archive: missing }), /Missing runtime file: assets\/characters\/cafemong\.png/);
  const corrupt = await fixture.pack(directory => {
    const file = join(directory, 'assets/characters/cafemong.png');
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(file, bytes);
  });
  assert.throws(() => verifyRuntimeArchive({ ...fixture, archive: corrupt }), /Stale runtime file: assets\/characters\/cafemong\.png/);
});

test('real ASAR verification rejects stale nested runtime code and a different client flavor', async t => {
  const fixture = await runtimeArchiveFixture(t);
  const stale = await fixture.pack(directory => writeFileSync(join(directory, 'electron/native/window-surfaces.ps1'), '# stale collector'));
  assert.throws(() => verifyRuntimeArchive({ ...fixture, archive: stale }), /Stale runtime file: electron\/native\/window-surfaces\.ps1/);
  const wrongFlavor = await fixture.pack(directory => writeFileSync(join(directory, 'src/runtime-config.json'), JSON.stringify({ flavor: 'admin' })));
  assert.throws(() => verifyRuntimeArchive({ ...fixture, archive: wrongFlavor }), /Packaged client/);
});

test('actual ASAR Windows lookup requires native separators for nested members', async t => {
  const fixture = await runtimeArchiveFixture(t);
  const archive = await fixture.pack();
  const library = require.resolve('@electron/asar/lib/filesystem.js');
  const libraryRequire = createRequire(library);
  const loaded = { exports: {} };
  // Run the installed library's own lookup code with Windows path operations,
  // using a real archive header. This is not a replacement filesystem model.
  const load = runInNewContext(`(function(require, module, exports) {\n${readFileSync(library, 'utf8')}\n})`, {}, { filename: library });
  load(name => name === 'path' ? win32 : libraryRequire(name), loaded, loaded.exports);
  const { Filesystem } = loaded.exports;
  const windowsFilesystem = new Filesystem('C:\\fixture\\app.asar');
  const header = asar.getRawHeader(archive);
  windowsFilesystem.setHeader(header.header, header.headerSize);
  assert.ok(windowsFilesystem.getFile('src/runtime-config.json'), 'one-level paths can hide the Windows lookup bug');
  for (const name of ['assets/characters/cafemong.png', 'electron/native/window-surfaces.ps1']) {
    assert.throws(() => windowsFilesystem.getFile(name), /was not found in this archive/);
    const windowsMember = windowsFilesystem.getFile(win32.normalize(name));
    const actualMember = asar.statFile(archive, normalize(name));
    assert.equal(windowsMember.size, actualMember.size);
    assert.equal(windowsMember.offset, actualMember.offset);
  }
});

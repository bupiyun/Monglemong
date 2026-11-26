import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readPE, embeddedArchive, assertRuntimeMembers } from '../scripts/verify-windows-package.mjs';

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

import assert from 'node:assert/strict';
import { closeSync, createReadStream, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBaseAssets } from './check-base-assets.mjs';
import { resolveFlavor } from './prepare-client.mjs';
import { checkWorktree } from './check-public-source.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js');
const root = resolve(import.meta.dirname, '..');

export function assertRuntimeMembers(members, { flavor = 'user', approvedPaths } = {}) {
  resolveFlavor(flavor);
  if (approvedPaths) {
    const allowed = new Set(approvedPaths);
    assert.ok(members.every(name => allowed.has(name) || approvedPaths.some(path => path.startsWith(name + '/'))), 'Runtime files must come from the approved user source');
  }
  // The bundled, hidden Win32 geometry collector is a runtime dependency.
  // Development launchers and other PowerShell scripts remain excluded.
  const collector = 'electron/native/window-surfaces.ps1';
  assert.ok(!members.some(name => /(^|\/)(node_modules|tests|scripts|server|\.git)(\/|$)|(^|\/)\.env(?:\.|$)|\.(cmd|bat|sqlite|db|pem|key)$/i.test(name)
    || (/\.ps1$/i.test(name) && name !== collector)), 'Developer tools or console launchers must not ship in the runtime archive');
  assert.ok(!members.some(name => /(^|\/)admin(?:[./_-]|$)/i.test(name)), 'User client must not include privileged authoring files');
}

/** Check runtime metadata that survives electron-builder's package cleanup. */
export function assertPackagedManifest(manifest, source) {
  // electron-builder removes build (including appId) before writing app.asar.
  // Flavor is additionally checked in runtime-config and every runtime file is
  // compared byte-for-byte with the prepared source below.
  assert.equal(manifest.name, source.name, 'Packaged identity must match the prepared client');
  assert.equal(manifest.version, source.version, 'Packaged version must match source');
  assert.equal(source.main, 'electron/main.cjs', 'Prepared app must launch Electron directly');
  assert.equal(manifest.main, source.main, 'Installed app must launch Electron directly');
  assert.equal(manifest.type, source.type, 'Packaged module type must match source');
}

/** Inspect PE metadata without launching a Windows executable. */
export function readPE(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const dos = Buffer.alloc(64);
    assert.equal(readSync(fd,dos,0,dos.length,0),dos.length,'Missing DOS header');
    assert.equal(dos.toString('ascii',0,2),'MZ','Missing MZ signature');
    const peOffset = dos.readUInt32LE(0x3c);
    assert.ok(peOffset >= 64 && peOffset + 24 + 70 <= size,'Invalid PE header location');
    const pe = Buffer.alloc(24 + 70);
    assert.equal(readSync(fd,pe,0,pe.length,peOffset),pe.length,'Truncated PE header');
    assert.equal(pe.toString('ascii',0,4),'PE\0\0','Missing PE signature');
    assert.ok(pe.readUInt16LE(20) >= 70,'Truncated optional header');
    const format = pe.readUInt16LE(24);
    assert.ok(format === 0x10b || format === 0x20b,'Unknown PE optional header');
    return {machine:pe.readUInt16LE(4),format,subsystem:pe.readUInt16LE(24+68),size};
  } finally { closeSync(fd); }
}

function filesUnder(directory) {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry => {
    const path = join(directory,entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(file) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function embeddedArchive(bytes) {
  // electron-builder embeds its 7z app archive verbatim (NSIS SetCompress off).
  // This intentionally rejects the small temporary uninstaller-writer EXE left
  // at the final filename when NSIS preparation fails.
  const signature=Buffer.from([0x37,0x7a,0xbc,0xaf,0x27,0x1c]);
  const candidates=[];
  for(let start=bytes.indexOf(signature);start!==-1;start=bytes.indexOf(signature,start+6)) {
    if(start+32>bytes.length) continue;
    const size=32n+bytes.readBigUInt64LE(start+12)+bytes.readBigUInt64LE(start+20);
    if(size>1_000_000n && size<=BigInt(bytes.length-start)) candidates.push({start,size:Number(size)});
  }
  const candidate=candidates.sort((a,b)=>b.size-a.size)[0];
  assert.ok(candidate,'Installer is incomplete: no embedded application archive (it may be an uninstaller-writer stub)');
  return bytes.subarray(candidate.start,candidate.start+candidate.size);
}

export async function verifyWindowsPackage({projectRoot=root,installer,appDirectory,flavor='user'}={}) {
  resolveFlavor(flavor);
  const approved = checkWorktree(projectRoot);
  const sourceRoot = join(projectRoot, 'build-clients', flavor);
  assert.ok(existsSync(join(sourceRoot, 'package.json')), 'Prepared user client source is missing. Prepare the user client first.');
  checkBaseAssets(sourceRoot);
  const source = JSON.parse(readFileSync(join(sourceRoot,'package.json'),'utf8'));
  const rootManifest = JSON.parse(readFileSync(join(projectRoot,'package.json'),'utf8'));
  assert.equal(source.version, rootManifest.version, 'Prepared client is from a different source version');
  const installPath = installer || join(projectRoot,'release',flavor,`${source.build.productName}-Setup-${source.version}-x64.exe`);
  const appDir = appDirectory || join(dirname(installPath),'win-unpacked');
  const executableName = `${source.build.productName}.exe`;
  const executable = join(appDir,executableName);
  const archive = join(appDir,'resources','app.asar');
  assert.ok(existsSync(installPath),'Installer artifact is missing');
  assert.ok(existsSync(executable),`Bundled ${executableName} is missing`);
  assert.ok(existsSync(archive),'Bundled application archive is missing');
  const installerPE=readPE(installPath), appPE=readPE(executable);
  assert.equal(installerPE.subsystem,2,'Installer must use the Windows GUI subsystem');
  assert.equal(appPE.subsystem,2,`${executableName} must use the Windows GUI subsystem, not a console subsystem`);
  assert.equal(appPE.machine,0x8664,'This artifact is the x64 Windows release');

  const members = asar.listPackage(archive).map(name=>name.replaceAll('\\','/').replace(/^\//,''));
  assertRuntimeMembers(members, { flavor, approvedPaths: approved.paths.filter(name => ['index.html', 'package.json'].includes(name) || /^(src|assets|electron)\//.test(name)) });
  const manifest=JSON.parse(asar.extractFile(archive,'package.json').toString());
  assertPackagedManifest(manifest, source);
  const runtimeConfig = JSON.parse(asar.extractFile(archive, 'src/runtime-config.json').toString());
  assert.equal(runtimeConfig.flavor, flavor, 'Packaged client must be the user client');
  const required=[join(sourceRoot,'index.html'),...['src','assets','electron'].flatMap(folder=>filesUnder(join(sourceRoot,folder)))];
  for(const file of required) {
    const name=relative(sourceRoot,file).replaceAll('\\','/');
    assert.ok(members.includes(name),`Missing runtime file: ${name}`);
    assert.equal(sha256(asar.extractFile(archive,name)),sha256(readFileSync(file)),`Stale runtime file: ${name}`);
  }
  for(const binary of ['icudtl.dat','resources.pak','v8_context_snapshot.bin','locales/en-US.pak']) {
    assert.ok(existsSync(join(appDir,binary)),`Missing bundled Electron resource: ${binary}`);
  }
  const installerBytes=readFileSync(installPath);
  const payload=embeddedArchive(installerBytes);
  const temp=mkdtempSync(join(tmpdir(),'MongleMong-installer-verify-'));
  try {
    const payloadFile=join(temp,'app.7z');
    writeFileSync(payloadFile,payload);
    const sevenZip=await getPath7za();
    for(const args of [['t',payloadFile],['x','-y',`-o${temp}`,payloadFile,executableName,'resources/app.asar']]) {
      const result=spawnSync(sevenZip,args,{encoding:'utf8',maxBuffer:2*1024*1024,timeout:180_000,shell:false});
      assert.equal(result.error,undefined,`Payload verification tool failed: ${result.error?.message}`);
      assert.equal(result.status,0,`Embedded application payload is invalid: ${result.stderr || result.stdout}`);
    }
    assert.equal(readPE(join(temp,executableName)).subsystem,2,'Embedded application must itself be a GUI executable');
    assert.equal(await hashFile(join(temp,executableName)),await hashFile(executable),'Installer contains a different application executable');
    assert.equal(await hashFile(join(temp,'resources','app.asar')),await hashFile(archive),'Installer contains stale application code');
  } finally {rmSync(temp,{recursive:true,force:true});}
  return {installer:installPath,flavor,version:source.version,installerBytes:installerPE.size,appBytes:appPE.size,
    guiSubsystem:true,architecture:'x64',verifiedRuntimeFiles:required.length,
    embeddedPayloadBytes:payload.length,sha256:sha256(installerBytes),executionTested:false};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const flavor = args[0] === '--flavor' ? resolveFlavor(args.splice(0, 2)[1])
      : ['user', 'admin'].includes(args[0]) ? resolveFlavor(args.shift()) : resolveFlavor();
    const result=await verifyWindowsPackage({flavor,installer:args[0] ? resolve(args[0]) : undefined,appDirectory:args[1] ? resolve(args[1]) : undefined});
    console.log(JSON.stringify(result,null,2));
    console.log('Installer/package structure verified. This check does not execute Windows or simulate installation.');
  } catch(error) {console.error(error.message);process.exitCode=1;}
}

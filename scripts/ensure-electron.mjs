import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '..');

function executableFor(platform) {
  if (platform === 'win32') return 'electron.exe';
  if (platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron';
  if (['linux', 'freebsd', 'openbsd'].includes(platform)) return 'electron';
  throw new Error(`Electron is not supported on this platform: ${platform}`);
}

export function isElectronReady(directory, version, platform = process.platform) {
  const executable = executableFor(platform);
  try {
    const installedVersion = readFileSync(join(directory, 'dist', 'version'), 'utf8').trim().replace(/^v/, '');
    const recordedPath = readFileSync(join(directory, 'path.txt'), 'utf8').trim();
    const binary = statSync(join(directory, 'dist', executable));
    return installedVersion === version && recordedPath === executable && binary.isFile() && binary.size > 0;
  } catch {
    return false;
  }
}

/** Install only Electron's own runtime, leaving npm's script permissions unchanged. */
export function ensureElectron({ root = projectRoot, platform = process.platform, env = process.env, log = console.log } = {}) {
  const directory = join(root, 'node_modules', 'electron');
  const manifest = join(directory, 'package.json');
  if (!existsSync(manifest)) throw new Error('Electron package is missing. Run npm.cmd ci (Windows) or npm ci first.');
  const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
  if (typeof version !== 'string' || !version) throw new Error('Electron package metadata is invalid. Run npm ci again.');
  if (isElectronReady(directory, version, platform)) {
    log(`Electron ${version} is ready.`);
    return;
  }

  const installer = join(directory, 'install.js');
  if (!existsSync(installer)) throw new Error('Electron installer is missing. Run npm ci again.');
  log(`Installing the Electron ${version} runtime. The first download needs an internet connection.`);
  const result = spawnSync(process.execPath, [installer], { cwd: root, env, stdio: 'inherit', shell: false });
  if (result.error) throw new Error(`Could not run the Electron installer: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Electron download failed (${result.signal || result.status}). Check the installer error above and network access to GitHub releases, then run npm run setup:electron again.`);
  }
  if (!isElectronReady(directory, version, platform)) {
    throw new Error('Electron installer exited without a usable runtime. Check ELECTRON_INSTALL_PLATFORM, ELECTRON_INSTALL_ARCH and ELECTRON_OVERRIDE_DIST_PATH if configured, then retry npm run setup:electron.');
  }
  log(`Electron ${version} is ready.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { ensureElectron(); }
  catch (error) { console.error(`[MongleMong] ${error.message}`); process.exitCode = 1; }
}

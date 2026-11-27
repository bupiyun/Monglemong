import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBaseAssets } from './check-base-assets.mjs';
import { prepareClient, resolveFlavor } from './prepare-client.mjs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');

/** Resolve the same standalone project that prepare:user/start use. No build runs here. */
export function createWindowsBuildOptions(prepared, {
  electronVersion = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version,
  electronCache = process.env.MONGLEMONG_ELECTRON_CACHE || process.env.MONGEULMONG_ELECTRON_CACHE || process.env.MORI_ELECTRON_CACHE,
} = {}) {
  resolveFlavor(prepared.config.flavor);
  const { Platform, Arch } = require('electron-builder');
  const configuration = structuredClone(prepared.manifest.build);
  // The staged package.json owns its build configuration. Pointing projectDir
  // at the source checkout and directories.app at staging selects a two-package
  // layout, where electron-builder forbids this application's build field.
  const directories = { ...configuration.directories, output: resolve(prepared.releaseDirectory) };
  delete directories.app;
  return {
    projectDir: resolve(prepared.directory),
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    publish: 'never',
    config: {
      ...configuration, directories, electronVersion,
      ...(electronCache ? { electronDownload: { cache: resolve(electronCache) } } : {}),
    },
  };
}

async function buildWindowsInstaller() {
  const flavor = resolveFlavor(process.argv[2] || 'user');
  const prepared = prepareClient({ projectRoot: root, flavor });
  const { manifest } = prepared;
  const { build } = require('electron-builder');
  let restoreExtraction = () => {};

  if (process.platform === 'linux') {
    // The unsigned NSIS uninstaller does not need to execute during a build.
    // Use electron-builder's own NSIS reader (also used by its macOS build path)
    // for this one generated file. No installed dependency files are modified.
    // This internal API is covered by the pinned electron-builder version.
    const { WineVmManager } = require('app-builder-lib/out/vm/WineVm.js');
    const { UninstallerReader } = require('app-builder-lib/out/targets/nsis/nsisUtil.js');
    const expectedWriter = join(prepared.releaseDirectory, `${manifest.build.productName}-Setup-${manifest.version}-x64.exe`);
    const original = WineVmManager.prototype.execWine;
    WineVmManager.prototype.execWine = async function (request) {
      if (resolve(request.file) !== expectedWriter || (request.appArgs?.length ?? 0) !== 0 || manifest.build.win.signExecutable !== false) {
        throw new Error('This Linux build only supports extraction of the unsigned MongleMong NSIS uninstaller. Build other Windows targets on Windows.');
      }
      const uninstaller = join(dirname(request.file), `${basename(request.file, 'exe')}__uninstaller.exe`);
      console.log('Extracting the NSIS uninstaller with electron-builder\'s built-in reader.');
      await UninstallerReader.exec(request.file, uninstaller);
      return '';
    };
    restoreExtraction = () => { WineVmManager.prototype.execWine = original; };
  }

  try {
    checkBaseAssets(root);
    await build(createWindowsBuildOptions(prepared));
  } finally {
    restoreExtraction();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWindowsInstaller().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

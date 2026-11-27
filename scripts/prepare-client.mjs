import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBaseAssets } from './check-base-assets.mjs';
import { checkWorktree } from './check-public-source.mjs';
import { UPDATE_ORIGIN } from '../src/update-manifest.js';

const require = createRequire(import.meta.url);
const { normalizeApiBaseUrl } = require('../electron/service-bridge.cjs');
const ROOT = resolve(import.meta.dirname, '..');
const RUNTIME_EXTENSIONS = new Set(['.js', '.cjs', '.css', '.json', '.svg', '.png', '.ico', '.ps1', '.jpg', '.jpeg', '.webp']);

// This checkout is the distributable user client. Privileged tooling lives in
// a separate, private workspace and cannot be enabled with a build switch.
export function resolveFlavor(value = process.env.MONGLEMONG_BUILD_FLAVOR || 'user') {
  if (value !== 'user' || (process.env.MONGLEMONG_BUILD_FLAVOR && process.env.MONGLEMONG_BUILD_FLAVOR !== 'user')) {
    throw new Error('This source supports user builds only. Use the separate private workspace for privileged tooling.');
  }
  return 'user';
}

/** An explicit empty override keeps a build in guest-only mode. */
export function resolveClientApiBaseUrl(projectRoot = ROOT, override = process.env.MONGLEMONG_API_URL) {
  const value = override === undefined
    ? JSON.parse(readFileSync(join(projectRoot, 'src', 'runtime-config.json'), 'utf8')).apiBaseUrl
    : override;
  return normalizeApiBaseUrl(value);
}

export function clientConnectPolicy(apiBaseUrl) {
  const origins = [...new Set([apiBaseUrl, UPDATE_ORIGIN].filter(Boolean))];
  return `connect-src 'self' ${origins.join(' ')};`;
}

export function variantManifest(source, flavor = 'user', releaseOutput = '../../release/user') {
  resolveFlavor(flavor);
  const build = structuredClone(source.build);
  build.directories = { ...build.directories, output: releaseOutput };
  return {
    name: source.name, version: source.version, description: source.description,
    private: true, type: 'module', main: 'electron/main.cjs', build,
  };
}

function copyRuntimeFiles(projectRoot, destination, approvedPaths) {
  for (const name of approvedPaths) {
    if (!/^(src|assets|electron)\//.test(name) || !RUNTIME_EXTENSIONS.has(extname(name).toLowerCase())) continue;
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(projectRoot, name), target);
  }
}

/** Prepare source only. This function never starts Electron or builds EXEs. */
export function prepareClient({ projectRoot = ROOT, flavor = 'user', apiBaseUrl } = {}) {
  resolveFlavor(flavor);
  projectRoot = resolve(projectRoot);
  const approved = checkWorktree(projectRoot);
  const config = { flavor, apiBaseUrl: resolveClientApiBaseUrl(projectRoot, apiBaseUrl) };
  checkBaseAssets(projectRoot);
  const source = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  const directory = join(projectRoot, 'build-clients', flavor);
  const releaseDirectory = join(projectRoot, 'release', flavor);
  const manifest = variantManifest(source, flavor, relative(directory, releaseDirectory).replaceAll('\\', '/'));
  // Generated directories are intentionally outside the source allowlist. Do
  // not let a link redirect staging cleanup or a future build into other data.
  for (const name of ['build-clients', 'build-clients/user', 'release', 'release/user']) {
    try {
      if (lstatSync(join(projectRoot, name)).isSymbolicLink()) throw new Error(`Build output directories cannot be symlinks: ${name}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  copyRuntimeFiles(projectRoot, directory, approved.paths);
  for (const file of ['icon.ico', 'icon.png']) {
    const sourceIcon = join(projectRoot, 'build', file);
    if (approved.paths.includes(`build/${file}`) && existsSync(sourceIcon)) {
      mkdirSync(join(directory, 'build'), { recursive: true });
      copyFileSync(sourceIcon, join(directory, 'build', file));
    }
  }
  let html = readFileSync(join(projectRoot, 'index.html'), 'utf8');
  html = html.replace(/^\s*<link\b[^>]*href=["']src\/admin\.css["'][^>]*>\s*$/gm, '');
  // Replacing the directive separately avoids changing any other CSP boundary.
  html = html.replace(/connect-src 'self'[^;]*;/, clientConnectPolicy(config.apiBaseUrl));
  writeFileSync(join(directory, 'index.html'), html);
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(directory, 'src', 'runtime-config.json'), JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(directory, 'src', 'runtime-config.js'), `export const RUNTIME_CONFIG = Object.freeze(${JSON.stringify(config)});\n`);
  return { directory, releaseDirectory, manifest, config };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const prepared = prepareClient({ flavor: process.argv[2] || 'user' });
    console.log(`Prepared ${prepared.config.flavor} client source: ${prepared.directory}`);
    console.log(prepared.config.apiBaseUrl ? 'Online service URL configured.' : 'No online service URL: local guest mode only. Set MONGLEMONG_API_URL before preparing an online client.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

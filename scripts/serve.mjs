import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFlavor } from './prepare-client.mjs';
import { checkWorktree } from './check-public-source.mjs';

const require = createRequire(import.meta.url);
const { normalizeApiBaseUrl } = require('../electron/service-bridge.cjs');
const ROOT = resolve(import.meta.dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

export function createPreviewServer({
  projectRoot = ROOT,
  flavor = process.env.MONGLEMONG_BUILD_FLAVOR || 'user',
  apiBaseUrl = process.env.MONGLEMONG_API_URL || '',
} = {}) {
  const root = resolve(projectRoot);
  const config = { flavor: resolveFlavor(flavor), apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl) };
  const approved = new Set(checkWorktree(root).paths);
  const runtimeModule = `export const RUNTIME_CONFIG = Object.freeze(${JSON.stringify(config)});\n`;
  return http.createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const path = resolve(root, '.' + pathname);
      if ((!path.startsWith(root + sep) && path !== root) || pathname.includes('\0')) {
        res.writeHead(403).end();
        return;
      }
      const target = path === root ? resolve(root, 'index.html') : path;
      const name = relative(root, target).replaceAll('\\', '/');
      // Expose runtime sources only, never server code, tests, credentials or
      // hidden character assets accidentally present in the working checkout.
      const isRuntimeFile = name === 'index.html' || name.startsWith('src/') || name.startsWith('assets/');
      const isHiddenFile = name.split('/').some(part => part.startsWith('.'));
      const isUnreleasedSprite = name.startsWith('assets/characters/') && name !== 'assets/characters/cafemong.png';
      const isExcludedAdminFile = /(^|\/)admin(?:[./_-]|$)/i.test(name);
      if (!approved.has(name) || !isRuntimeFile || isHiddenFile || isUnreleasedSprite || isExcludedAdminFile || !MIME[extname(target)]) {
        res.writeHead(404).end('Not found');
        return;
      }
      let body;
      if (name === 'src/runtime-config.js') {
        body = runtimeModule;
      } else {
        // Reject aliases that could bypass the runtime/admin file allowlist.
        const actualRoot = await realpath(root);
        const actualTarget = await realpath(target);
        if (actualTarget !== resolve(actualRoot, name)) {
          res.writeHead(403).end();
          return;
        }
        body = await readFile(actualTarget);
        if (name === 'index.html') {
          body = body.toString('utf8');
          body = body.replace(/^\s*<link\b[^>]*href=["']src\/admin\.css["'][^>]*>\s*$/gm, '');
          body = body.replace(/connect-src 'self'[^;]*;/, `connect-src 'self'${config.apiBaseUrl ? ` ${config.apiBaseUrl}` : ''};`);
        }
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(target)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
    const server = createPreviewServer({ flavor: process.argv[2] || process.env.MONGLEMONG_BUILD_FLAVOR || 'user' });
    server.on('error', () => { console.error('Preview server could not start. Check whether PORT is already in use.'); process.exitCode = 1; });
    server.listen(port, '0.0.0.0', () => console.log('MongleMong preview: http://localhost:' + server.address().port));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

// Minimal static server with SPA fallback for the CHECKS_STATIC e2e mode.
//
// `expo serve` cannot be used here: with web.output "single" the export is a
// single-page app whose deep links (/search, /object/123, …) must fall back
// to index.html, and `expo serve` returns 404 for them (measured 2026-06-11;
// it has no SPA flag). In production the Hono server provides the fallback —
// this file is the equivalent for the stub-provider static checks, with no
// added dependency.
//
// Usage: node e2e/static-server.mjs [port] [dir]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.argv[2] ?? 8081);
const DIR = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, '../apps/mobile/dist'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // Resolve inside DIR only; anything path-traversing or missing falls
    // through to the SPA fallback / 404 below.
    const file = path.join(DIR, path.normalize(url.pathname));
    const ext = path.extname(url.pathname);
    let target = file.startsWith(DIR) && ext && fs.existsSync(file) ? file : null;
    if (!target && !ext) target = path.join(DIR, 'index.html'); // SPA fallback
    if (!target) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);
  })
  .listen(PORT, () => console.log(`[static-server] ${DIR} on :${PORT}`));

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain',
  '.sql': 'text/plain', '.sqlite': 'application/octet-stream',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

export async function serveActual(root, port) {
  root = path.resolve(root);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.resolve(root, `.${url}`);
      if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      if (url === '/' || (!path.extname(url) && req.headers.accept?.includes('text/html'))) {
        file = path.join(root, 'index.html');
      }
      const bytes = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(bytes);
    } catch (error) {
      res.writeHead(error instanceof URIError ? 400 : 404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

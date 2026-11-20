import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.glsl': 'text/plain; charset=utf-8',
  '.vert': 'text/plain; charset=utf-8',
  '.frag': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.map': 'application/json; charset=utf-8',
};

const COMPRESSIBLE_EXTS = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json',
  '.svg', '.glsl', '.vert', '.frag', '.txt', '.gltf', '.map',
]);

/**
 * Start a local-only static file server on a random free port.
 * @param {string} rootDir Absolute or relative directory to serve.
 * @returns {Promise<{url: string, origin: string, host: string, port: number, close: () => Promise<void>, getServedStats: () => {requests: number, bytesTransferred: number, files: string[]}}>}
 */
export async function startServer(rootDir) {
  const absRoot = path.resolve(rootDir);
  const sockets = new Set();
  let requests = 0;
  let bytesTransferred = 0;
  const servedFiles = new Set();

  async function resolveFile(rawUrlOrPath) {
    const reqUrl = new URL(rawUrlOrPath || '/', 'http://127.0.0.1');
    let pathname = decodeURIComponent(reqUrl.pathname);
    if (pathname.endsWith('/')) {
      pathname += 'index.html';
    }

    // Normalize and enforce containment inside absRoot
    const rel = pathname.replace(/^\/+/, '');
    let filePath = path.resolve(absRoot, rel);
    const relCheck = path.relative(absRoot, filePath);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      return { status: 403, contentType: 'text/plain; charset=utf-8', body: Buffer.from('Forbidden'), ext: '' };
    }

    try {
      let stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        stat = await fs.stat(filePath);
      }
    } catch {
      return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('Not Found'), ext: '' };
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const raw = await fs.readFile(filePath);
    const relServed = path.relative(absRoot, filePath).replace(/\\/g, '/');
    return { status: 200, contentType, body: raw, ext, relServed };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const resolved = await resolveFile(req.url || '/');
      if (resolved.status !== 200) {
        res.writeHead(resolved.status, { 'Content-Type': resolved.contentType });
        res.end(resolved.body);
        return;
      }

      const acceptEncoding = String(req.headers['accept-encoding'] || '');
      const shouldGzip = COMPRESSIBLE_EXTS.has(resolved.ext) && /\bgzip\b/i.test(acceptEncoding);
      const body = shouldGzip ? zlib.gzipSync(resolved.body, { level: 6 }) : resolved.body;

      const headers = {
        'Content-Type': resolved.contentType,
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      if (shouldGzip) {
        headers['Content-Encoding'] = 'gzip';
      }

      requests += 1;
      bytesTransferred += body.length;
      servedFiles.add(resolved.relServed);

      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(body);
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end(String(err?.message || err));
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const host = '127.0.0.1';
  const origin = `http://${host}:${port}`;
  const url = `${origin}/`;

  // Probe whether loopback TCP connect works in the current environment
  let loopbackReachable = false;
  try {
    await new Promise((resolve, reject) => {
      const probeReq = http.request({ host, port, path: '/', method: 'HEAD', timeout: 1000 }, (probeRes) => {
        probeRes.resume();
        resolve();
      });
      probeReq.on('error', reject);
      probeReq.on('timeout', () => {
        probeReq.destroy(new Error('timeout'));
      });
      probeReq.end();
    });
    loopbackReachable = true;
  } catch {
    loopbackReachable = false;
  }

  return {
    url,
    origin,
    host,
    port,
    loopbackReachable,
    resolveFile,
    getServedStats() {
      return {
        requests,
        bytesTransferred,
        files: Array.from(servedFiles),
      };
    },
    close() {
      return new Promise((resolve) => {
        if (typeof server.closeIdleConnections === 'function') {
          server.closeIdleConnections();
        }
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        for (const s of sockets) {
          try {
            s.destroy();
          } catch {
            // ignore
          }
        }
        sockets.clear();
        server.close(() => resolve());
      });
    },
  };
}

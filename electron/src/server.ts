import { createServer, Server } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

const PREFERRED_PORT = 49217;

function listen(server: Server, port: number): Promise<number> {
  return new Promise((res, rej) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      rej(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      if (addr && typeof addr === 'object') res(addr.port);
      else rej(new Error('Server address unavailable'));
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startStaticServer(
  distRoot: string
): Promise<RunningServer> {
  const root = resolve(distRoot);

  const server = createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0];
    let relPath: string;
    try {
      relPath = decodeURIComponent(urlPath);
    } catch {
      res.statusCode = 400;
      res.end('Bad request');
      return;
    }
    if (relPath === '/' || relPath === '') relPath = '/index.html';

    const absPath = resolve(root, '.' + relPath);
    const rel = relative(root, absPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    let target = absPath;
    try {
      const s = statSync(target);
      if (s.isDirectory()) target = join(target, 'index.html');
    } catch {
      // Expo Router SPA: any unknown path falls back to index.html so client routing works.
      target = join(root, 'index.html');
    }

    try {
      const s = statSync(target);
      res.setHeader(
        'Content-Type',
        MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
      );
      res.setHeader('Content-Length', String(s.size));
      res.setHeader('Cache-Control', 'no-store');
      createReadStream(target).pipe(res);
    } catch {
      res.statusCode = 404;
      res.end('Not found');
    }
  });

  let port: number;
  try {
    port = await listen(server, PREFERRED_PORT);
  } catch {
    port = await listen(server, 0);
  }

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((res) => {
        server.close(() => res());
      }),
  };
}

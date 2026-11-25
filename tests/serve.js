// 정적 파일 서버 — 로컬에서 /admin 화면 모양을 확인할 때 쓴다.
//   node tests/serve.js 4173  →  http://127.0.0.1:4173/admin/
// 실제 데이터/로그인은 Netlify Functions 가 필요하므로 `npx netlify dev` 로 확인하는 것이 정확하다.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

export function startServer(port) {
  const server = http.createServer(async function (req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      let filePath = path.join(ROOT, decodeURIComponent(url.pathname));
      const info = await stat(filePath).catch(function () { return null; });
      if (info && info.isDirectory()) filePath = path.join(filePath, 'index.html');
      const body = await readFile(filePath).catch(function () { return null; });
      if (!body) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(filePath)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('error');
    }
  });
  return new Promise(function (resolve) {
    server.listen(port, '127.0.0.1', function () { resolve(server); });
  });
}

if (process.argv[1] && process.argv[1].endsWith('serve.js')) {
  const port = parseInt(process.argv[2] || '4173', 10);
  startServer(port).then(function () {
    console.log('http://127.0.0.1:' + port + '/admin/  (정적 미리보기 — 로그인/데이터는 netlify dev 필요)');
  });
}

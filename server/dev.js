/* Servidor local para probar el juego con la nube sin Vercel:
 *   DATABASE_URL=postgres://usuario:clave@localhost:5432/ps node server/dev.js
 * Sirve la web (como Vercel) y la API en /api/v1. Puerto: PORT (8000 por defecto).
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { handler } = require('./api');

const ROOT = path.join(__dirname, '..');
const PORT = +process.env.PORT || 8000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.txt': 'text/plain' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/v1') return handler(req, res);
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (p.startsWith('..') || /(^|[/\\])(server|node_modules|\.git)([/\\]|$)/.test(p)) { res.statusCode = 404; return res.end(); }
  let file = path.join(ROOT, p);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (e, data) => {
    if (e) { res.statusCode = 404; return res.end('404'); }
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
}).listen(PORT, () => console.log(`PokéSurvivor en http://localhost:${PORT}  (API: /api/v1)`));

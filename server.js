// LifeSprint local server: serves the public/ folder (the app itself saves in the browser).
// Run: node server.js  ->  http://localhost:4000
const http = require('http'), fs = require('fs'), path = require('path');
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end('bad request'); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end('bad request'); }
  const file = path.join(PUB, path.normalize(rel.endsWith('/') ? rel + 'index.html' : rel));
  if (file !== PUB && !file.startsWith(PUB + path.sep)) { res.writeHead(404); return res.end('not found'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size,
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

function start(port = +process.env.PORT || 4000, host = process.env.HOST || '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { start };

if (require.main === module) {
  start().then(s => console.log(`LifeSprint running at http://localhost:${s.address().port}`), err => {
    console.error(err.code === 'EADDRINUSE' ? 'Port is already in use. Is LifeSprint already running? Try PORT=4001 node server.js' : err.message);
    process.exit(1);
  });
}

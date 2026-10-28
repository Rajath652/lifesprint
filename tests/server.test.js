// Tries to break the local static server: traversal, odd paths, methods, encodings.
const test = require('node:test'), { after } = test, assert = require('node:assert'), http = require('node:http');
const { start } = require('../server');

let server, port;
// Node 20 doesn't await async top-level before() hooks, so requests await this instead
const ready = start(0).then(s => { server = s; port = s.address().port; });
after(() => server.close());

const get = (p, method = 'GET') => ready.then(() => new Promise((resolve, reject) => {
  // raw path, so "../" is not normalised away by the client
  const req = http.request({ host: '127.0.0.1', port, path: p, method }, res => {
    let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
  });
  req.on('error', reject); req.end();
}));

test('serves the app shell with correct types', async () => {
  for (const [p, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/store.js', 'text/javascript'], ['/manifest.webmanifest', 'application/manifest+json'], ['/icon.svg', 'image/svg+xml'], ['/icon-192.png', 'image/png']]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.ok(r.type.startsWith(type), `${p} -> ${r.type}`);
  }
});

test('ignores query strings and hashes', async () => {
  assert.equal((await get('/app.js?v=123')).status, 200);
  assert.equal((await get('/?x=1#y')).status, 200);
});

test('blocks path traversal in every encoding', async () => {
  for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/server.js', '/%2e%2e%2fpackage.json', '/..\\server.js', '/..%5cserver.js',
    '/public/../../server.js', '//etc/passwd', '/%2e%2e%2f%2e%2e%2fWindows/win.ini', '/C:/Windows/win.ini', '/c:%5cWindows%5cwin.ini']) {
    const r = await get(p);
    assert.notEqual(r.status, 200, `${p} should not be served`);
    assert.ok(!/require\(|"devDependencies"|\[fonts\]/.test(r.body), `${p} leaked a file`);
  }
});

test('directories and missing files return 404 instead of crashing', async () => {
  for (const p of ['/nope', '/nope/', '/%00', '/icon.svg/', '/' + 'a'.repeat(5000)]) {
    const r = await get(p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal((await get('/')).status, 200, 'server still alive');
});

test('malformed URL encoding is a 400, not a crash', async () => {
  assert.equal((await get('/%E0%A4%A')).status, 400);
  assert.equal((await get('/')).status, 200);
});

test('only GET and HEAD are allowed', async () => {
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await get('/', m)).status, 405, m);
  const head = await get('/app.js', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body, '');
});

test('survives many concurrent requests', async () => {
  const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => get(i % 2 ? '/app.js' : '/missing-' + i)));
  assert.equal(rs.filter(r => r.status === 200).length, 100);
});

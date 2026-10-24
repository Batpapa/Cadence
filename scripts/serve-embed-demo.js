// Serves the BUILT app the way GitHub Pages does — dist/ under /Cadence/ — plus
// the thesession-embed test page, to check the widget as it will really ship:
// its page two folders down, its bundle, worker and WASM at the root, found at
// run time by thesessionEmbed/publicPath.ts. The dev server cannot show that
// part, its paths are not production's.
//
//   npm run build
//   node scripts/serve-embed-demo.js        (port 3003, or PORT=…)
//
// Local testing only; nothing here is deployed.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3003;
const DIST = path.join(__dirname, '..', 'dist');
const DEMO = path.join(__dirname, '..', 'src', 'thesessionEmbed', 'demo.html');
const PREFIX = '/Cadence/';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // wasm-bindgen streams the module only when it is served as such.
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '/demo.html') { send(res, DEMO); return; }
  if (!p.startsWith(PREFIX)) { res.writeHead(404).end('Not found'); return; }
  let file = path.normalize(path.join(DIST, p.slice(PREFIX.length)));
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (p.endsWith('/')) file = path.join(file, 'index.html');
  send(res, file);
}).listen(PORT, () => {
  console.log(`Test page:  http://localhost:${PORT}/demo.html?base=${PREFIX}`);
  console.log(`Widget:     http://127.0.0.1:${PORT}${PREFIX}TuneAnalyser/thesession-embed/`);
});

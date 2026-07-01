// ============================================================
// EconoSchool Pro — Serveur local
// Lance avec : node server.js
// Accès : http://localhost:3000
// ============================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;

// Types MIME
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // ===== PROXY SMS Orange CI (évite le problème CORS) =====
  if (req.method === 'POST' && (parsed.pathname === '/sms-proxy' || parsed.pathname === '/api/sms-proxy')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const targetUrl = payload.url;
        const targetBody = payload.body;
        const headers = payload.headers || {};

        // Vérifier que c'est bien Orange API
        if (!targetUrl.startsWith('https://api.orange.com')) {
          res.writeHead(403); res.end('Forbidden'); return;
        }

        const urlObj = new URL(targetUrl);
        const options = {
          hostname: urlObj.hostname,
          path: urlObj.pathname + urlObj.search,
          method: payload.method || 'POST',
          headers: { ...headers, 'Content-Length': Buffer.byteLength(targetBody || '') }
        };

        const proxyReq = https.request(options, proxyRes => {
          let data = '';
          proxyRes.on('data', chunk => data += chunk);
          proxyRes.on('end', () => {
            res.writeHead(proxyRes.statusCode, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(data);
          });
        });

        proxyReq.on('error', err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });

        if (targetBody) proxyReq.write(targetBody);
        proxyReq.end();

      } catch(e) {
        res.writeHead(400); res.end('Bad Request: ' + e.message);
      }
    });
    return;
  }

  // ===== OPTIONS (preflight CORS) =====
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(); return;
  }

  // ===== FICHIERS STATIQUES =====
  let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Fichier non trouvé: ' + parsed.pathname);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║      EconoSchool Pro — Serveur OK      ║');
  console.log('╠════════════════════════════════════════╣');
  console.log('║  Ouvrez dans le navigateur :           ║');
  console.log('║  http://localhost:' + PORT + '              ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  console.log('  Appuyez sur Ctrl+C pour arrêter');
  console.log('');
});

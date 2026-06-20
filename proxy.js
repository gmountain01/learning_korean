const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(200); res.end(); return;
  }

  if (req.method === 'POST' && req.url === '/api/claude') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const apiKey = parsed.apiKey;
      delete parsed.apiKey;

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      };

      const proxyReq = https.request(options, proxyRes => {
        res.writeHead(proxyRes.statusCode,
          { 'content-type': 'application/json' });
        proxyRes.pipe(res);
      });
      proxyReq.on('error', e => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      });
      proxyReq.write(JSON.stringify(parsed));
      proxyReq.end();
    });
    return;
  }

  // 정적 파일 서빙
  let filePath = path.join(__dirname,
    req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css'
  }[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': mime });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});

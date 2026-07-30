const http = require('http');
const QRCode = require('qrcode');

let currentQR = null;
let status = 'waiting'; // 'waiting' | 'qr' | 'ready'
let whatsappClient = null;

function setQR(qr) {
  currentQR = qr;
  status = 'qr';
}

function setReady() {
  currentQR = null;
  status = 'ready';
}

function setClient(c) {
  whatsappClient = c;
}

function createServer() {
  const port = process.env.PORT || 3000;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }

    if (req.url === '/groups') {
      if (!whatsappClient || status !== 'ready') {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('⏳ Not ready', '<h2>⏳ Bot not ready</h2><p>Wait for the bot to be authenticated and try again.</p>'));
        return;
      }
      try {
        const chats = await whatsappClient.getChats();
        const groups = chats.filter((c) => c.isGroup);
        const items = groups.map((g) => {
          const tag = g.groupMetadata?.isCommunityAnnounceGroup
            ? ' <strong style="color:green">← Community announcement channel</strong>'
            : '';
          return `<li style="margin:6px 0"><code style="background:#eee;padding:2px 6px;border-radius:4px">${g.name}</code>${tag}</li>`;
        }).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Groups', `<h2>WhatsApp Groups</h2><p>Copy the exact name into <code>WHATSAPP_GROUP_NAME</code> in your <code>.env</code>:</p><ul style="text-align:left;display:inline-block">${items}</ul>`));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Error', `<h2>Error</h2><pre>${err.message}</pre>`));
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

    if (status === 'ready') {
      res.end(page('✅ Connected', '<h2>✅ WhatsApp Connected</h2><p>The bot is authenticated and running. You can close this page.</p>'));
      return;
    }

    if (status === 'waiting' || !currentQR) {
      res.end(page('⏳ Starting…', '<h2>⏳ Starting up…</h2><p>The bot is initialising. This page will refresh automatically.</p>', 3));
      return;
    }

    const dataURL = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
    res.end(page('📱 Scan QR', `
      <h2>📱 Scan with WhatsApp</h2>
      <p>Open WhatsApp → <strong>Settings → Linked Devices → Link a Device</strong></p>
      <img src="${dataURL}" alt="QR code" style="border:8px solid #fff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.15)">
      <p style="color:#888;font-size:13px;margin-top:12px">QR codes expire after ~20 s — page refreshes automatically.</p>
    `, 20));
  });

  server.listen(port, () => console.log(`[qr-server] Listening on port ${port}`));
  return server;
}

function page(title, body, refreshSecs) {
  const meta = refreshSecs ? `<meta http-equiv="refresh" content="${refreshSecs}">` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>spitbot – ${title}</title>
  ${meta}
  <style>
    body{font-family:sans-serif;text-align:center;padding:48px;background:#f5f5f5;color:#222}
    img{display:block;margin:24px auto}
  </style>
</head>
<body>${body}</body>
</html>`;
}

module.exports = { createServer, setQR, setReady, setClient };

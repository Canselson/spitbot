const http = require('http');
const QRCode = require('qrcode');
const { getWeekEvents } = require('./calendar');
const { formatWeeklyMessage } = require('./formatter');

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
          const meta = g.groupMetadata;
          const isAnnounce = !!(meta && (meta.announce || meta.isCommunityAnnounceGroup));
          const tag = isAnnounce ? ' <strong style="color:green">← Community announcement channel</strong>' : '';
          return `<li style="margin:6px 0"><code style="background:#eee;padding:2px 6px;border-radius:4px">${g.name}</code>${tag}</li>`;
        }).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Groups', `<h2>WhatsApp Groups</h2><p>Copy the exact name into <code>WHATSAPP_GROUP_NAME</code> in your <code>.env</code>:</p><ul style="text-align:left;display:inline-block">${items}</ul>${navLinks()}`));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Error', `<h2>Error</h2><pre>${err.message}</pre>`));
      }
      return;
    }

    if (req.url === '/preview') {
      try {
        const events = await getWeekEvents();
        const message = formatWeeklyMessage(events);
        const rendered = message
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\*(.*?)\*/g, '<strong>$1</strong>')
          .replace(/_(.*?)_/g, '<em>$1</em>')
          .replace(/\n/g, '<br>');
        const group = process.env.WHATSAPP_GROUP_NAME || '(group not set)';
        const body = `
          <h2>📋 Message Preview</h2>
          <p style="color:#888;font-size:13px">What will be sent to <strong>${group}</strong> on Monday at 08:00</p>
          <div style="background:#dcf8c6;border-radius:12px;padding:16px 20px;max-width:380px;margin:20px auto;text-align:left;font-size:15px;line-height:1.6;box-shadow:0 1px 4px rgba(0,0,0,.12);word-break:break-word">${rendered}</div>
          <p style="margin-top:24px"><a href="/preview" style="color:#555;font-size:13px">↺ Refresh</a></p>
          ${navLinks()}
        `;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Preview', body));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Error', `<h2>Error fetching calendar</h2><pre>${err.message}</pre>`));
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

    if (status === 'ready') {
      res.end(page('✅ Connected', `<h2>✅ WhatsApp Connected</h2><p>The bot is authenticated and running.</p>${navLinks()}`));
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

function navLinks() {
  return `
    <p style="margin-top:32px;font-size:13px;color:#888">
      <a href="/" style="color:#555;margin:0 8px">Status</a>
      <a href="/preview" style="color:#555;margin:0 8px">Preview message</a>
      <a href="/groups" style="color:#555;margin:0 8px">List groups</a>
    </p>`;
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
    a{color:#555}
  </style>
</head>
<body>${body}</body>
</html>`;
}

module.exports = { createServer, setQR, setReady, setClient };

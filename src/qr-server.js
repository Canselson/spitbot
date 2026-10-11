const http = require('http');
const QRCode = require('qrcode');
const { getWeekEvents, getNextWeekBounds } = require('./calendar');
const { formatWeeklyMessage } = require('./formatter');
const state = require('./state');

let currentQR = null;
let status = 'waiting'; // 'waiting' | 'qr' | 'ready'
let whatsappClient = null;

// Injected by index.js to avoid a require cycle (scheduler → whatsapp → qr-server).
let hooks = {
  triggerDigest: async () => ({ ok: false, error: 'Scheduler not wired up.' }),
  healthCheck: async () => { throw new Error('Health check not wired up.'); },
  getJobs: () => [],
};

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

function setHooks(h) {
  hooks = { ...hooks, ...h };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function runBadge(run) {
  if (!run) return '<span style="color:#888">— never run</span>';
  const when = `${esc(timeAgo(run.at))}${run.trigger === 'manual' ? ' (manual)' : ''}`;
  if (run.ok) {
    const dest = run.detail && run.detail.chatName ? ` → ${esc(run.detail.chatName)}` : '';
    return `<span style="color:#1a7f37">✅ delivered ${when}${dest}</span>`;
  }
  return `<span style="color:#c0392b">❌ failed ${when}</span><br><small style="color:#c0392b">${esc(run.error || '')}</small>`;
}

function createServer() {
  const port = process.env.PORT || 3000;

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }

    // Deep health check — actually proves the session can reach WhatsApp Web.
    if (url === '/check') {
      try {
        const health = await hooks.healthCheck();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Health check', `
          <h2>✅ Session healthy</h2>
          <p>Fetched <strong>${health.totalChats}</strong> chats (<strong>${health.groupCount}</strong> groups).</p>
          <p style="color:#888;font-size:13px">Linked number: ${esc(health.me || 'unknown')}</p>
          ${navLinks()}`));
      } catch (err) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Health check', `
          <h2>❌ Session not healthy</h2>
          <p>The bot shows as connected but could not fetch chats. The weekly digest would fail.</p>
          <pre style="white-space:pre-wrap;color:#c0392b">${esc(err.message)}</pre>
          <p style="color:#888;font-size:13px">A common cause is a stale pinned WhatsApp Web version — see <code>webVersionCache</code> in <code>whatsapp.js</code>.</p>
          ${navLinks()}`));
      }
      return;
    }

    // Manual "Send now" — triggers the weekly digest immediately.
    if (url === '/send-now' && req.method === 'POST') {
      await readBody(req);
      if (status !== 'ready') {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Send now', `<h2>⏳ Not ready</h2><p>The bot is not connected yet. Try again once it shows as connected.</p>${navLinks()}`));
        return;
      }
      const result = await hooks.triggerDigest();
      const body = result.ok
        ? `<h2>✅ Sent</h2><p>Delivered to <strong>${esc(result.entry.detail?.chatName || '')}</strong>.</p>`
        : `<h2>❌ Send failed</h2><pre style="white-space:pre-wrap;color:#c0392b">${esc(result.error)}</pre>`;
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Send now', body + navLinks()));
      return;
    }

    if (url === '/groups') {
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
          return `<li style="margin:6px 0"><code style="background:#eee;padding:2px 6px;border-radius:4px">${esc(g.name)}</code>${tag}</li>`;
        }).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Groups', `<h2>WhatsApp Groups</h2><p>Copy the exact name into <code>WHATSAPP_GROUP_NAME</code> in your <code>.env</code>:</p><ul style="text-align:left;display:inline-block">${items}</ul>${navLinks()}`));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Error', `<h2>Error</h2><pre>${esc(err.message)}</pre>${navLinks()}`));
      }
      return;
    }

    // Read-only view of all scheduled jobs (digest + recurring messages) and their last result.
    if (url === '/messages') {
      const rows = hooks.getJobs().map((job) => {
        const run = state.getLastRun(job.id);
        const schedule = job.enabled ? `<code>${esc(job.schedule)}</code>` : '<em style="color:#888">disabled</em>';
        return `<tr>
          <td style="padding:8px 12px">${esc(job.name)}</td>
          <td style="padding:8px 12px">${esc(job.type)}</td>
          <td style="padding:8px 12px">${schedule}</td>
          <td style="padding:8px 12px">${runBadge(run)}</td>
        </tr>`;
      }).join('');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Scheduled messages', `
        <h2>🗓️ Scheduled messages</h2>
        <table style="margin:16px auto;border-collapse:collapse;text-align:left;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
          <thead><tr style="background:#eee">
            <th style="padding:8px 12px">Name</th><th style="padding:8px 12px">Type</th><th style="padding:8px 12px">Schedule</th><th style="padding:8px 12px">Last run</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="color:#888;font-size:13px">Times are Europe/London. Adding/editing recurring messages from here is coming soon.</p>
        ${navLinks()}`));
      return;
    }

    if (url === '/preview') {
      try {
        const bounds = getNextWeekBounds();
        const events = await getWeekEvents(bounds);
        const message = formatWeeklyMessage(events);
        const rendered = message
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\*(.*?)\*/g, '<strong>$1</strong>')
          .replace(/_(.*?)_/g, '<em>$1</em>')
          .replace(/\n/g, '<br>');
        const group = process.env.WHATSAPP_GROUP_NAME || '(group not set)';
        const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });
        const rangeLabel = `${fmtDate(bounds.monday)} – ${fmtDate(bounds.sunday)}`;
        const body = `
          <h2>📋 Message Preview</h2>
          <p style="color:#888;font-size:13px">What will be sent to <strong>${esc(group)}</strong> on Monday at 08:00<br>Covering <strong>${rangeLabel}</strong></p>
          <div style="background:#dcf8c6;border-radius:12px;padding:16px 20px;max-width:380px;margin:20px auto;text-align:left;font-size:15px;line-height:1.6;box-shadow:0 1px 4px rgba(0,0,0,.12);word-break:break-word">${rendered}</div>
          <p style="margin-top:24px"><a href="/preview" style="color:#555;font-size:13px">↺ Refresh</a></p>
          ${navLinks()}
        `;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Preview', body));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Error', `<h2>Error fetching calendar</h2><pre>${esc(err.message)}</pre>${navLinks()}`));
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

    if (status === 'ready') {
      const lastDigest = state.getLastRun('weekly-digest');
      res.end(page('✅ Connected', `
        <h2>✅ WhatsApp Connected</h2>
        <p>The bot is authenticated and running.</p>
        <div style="background:#fff;border-radius:10px;padding:16px 20px;max-width:460px;margin:20px auto;box-shadow:0 1px 4px rgba(0,0,0,.08);text-align:left">
          <div style="font-weight:600;margin-bottom:6px">Weekly digest</div>
          <div>${runBadge(lastDigest)}</div>
          <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
            <form method="POST" action="/send-now" style="margin:0" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Sending…'">
              <button type="submit" style="background:#1a7f37;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;font-size:14px">Send digest now</button>
            </form>
            <a href="/check" style="background:#eee;color:#333;border-radius:6px;padding:8px 14px;text-decoration:none;font-size:14px">Run health check</a>
          </div>
        </div>
        ${navLinks()}`));
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
      <a href="/messages" style="color:#555;margin:0 8px">Scheduled messages</a>
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

module.exports = { createServer, setQR, setReady, setClient, setHooks };

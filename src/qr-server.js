const http = require('http');
const cron = require('node-cron');
const QRCode = require('qrcode');
const { getWeekEvents, getNextWeekBounds } = require('./calendar');
const { formatWeeklyMessage } = require('./formatter');
const state = require('./state');
const messages = require('./messages');

let currentQR = null;
let status = 'waiting'; // 'waiting' | 'qr' | 'ready'
let whatsappClient = null;

// Injected by index.js to avoid a require cycle (scheduler → whatsapp → qr-server).
let hooks = {
  triggerDigest: async () => ({ ok: false, error: 'Scheduler not wired up.' }),
  triggerTestToSelf: async () => ({ ok: false, error: 'Scheduler not wired up.' }),
  healthCheck: async () => { throw new Error('Health check not wired up.'); },
  diagnostics: async () => { throw new Error('Diagnostics not wired up.'); },
  listGroups: async () => { throw new Error('Group listing not wired up.'); },
  getJobs: () => [],
  reloadSchedule: () => {},
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

// --- Recurring-message schedule helpers (friendly day + time <-> cron) ---
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_CHOICES = [
  ['everyday', 'Every day'], ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'],
  ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday'],
];

function pad2(n) { return String(n).padStart(2, '0'); }

// Build a cron expression from a day choice ('everyday' or '0'-'6') and "HH:MM".
// Returns null if the inputs are invalid.
function buildCron(day, time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time || '');
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  const validDay = day === 'everyday' || /^[0-6]$/.test(day);
  if (!validDay) return null;
  const dow = day === 'everyday' ? '*' : day;
  const expr = `${minute} ${hour} * * ${dow}`;
  return cron.validate(expr) ? expr : null;
}

// Parse our generated "m h * * dow" cron back into { day, time }, or null if custom.
function parseCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5 || f[2] !== '*' || f[3] !== '*') return null;
  const minute = Number(f[0]);
  const hour = Number(f[1]);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null;
  const dow = f[4];
  const day = dow === '*' ? 'everyday' : (/^[0-6]$/.test(dow) ? dow : null);
  if (day === null) return null;
  return { day, time: `${pad2(hour)}:${pad2(minute)}` };
}

function scheduleToHuman(expr) {
  const p = parseCron(expr);
  if (!p) return `cron: ${esc(expr)}`;
  const label = p.day === 'everyday' ? 'Every day' : `${DAY_NAMES[Number(p.day)]}s`;
  return `${label} at ${p.time}`;
}

function dayOptions(selected) {
  return DAY_CHOICES
    .map(([v, l]) => `<option value="${v}"${v === selected ? ' selected' : ''}>${l}</option>`)
    .join('');
}

function parseForm(body) {
  const p = new URLSearchParams(body || '');
  return {
    id: p.get('id') || '',
    name: (p.get('name') || '').trim(),
    day: p.get('day') || '',
    time: p.get('time') || '',
    text: p.get('text') || '',
  };
}

// Reusable add/edit form.
function messageForm({ action, submitLabel, id = '', name = '', day = '2', time = '12:00', text = '' }) {
  const field = 'display:block;width:100%;max-width:420px;margin:4px 0 14px;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:14px;box-sizing:border-box';
  return `<form method="POST" action="${action}" style="text-align:left;max-width:460px;margin:0 auto;background:#fff;padding:20px;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08)">
    ${id ? `<input type="hidden" name="id" value="${esc(id)}">` : ''}
    <label style="font-weight:600;font-size:13px">Name<input name="name" required maxlength="80" value="${esc(name)}" placeholder="e.g. Training signup reminder" style="${field}"></label>
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      <label style="font-weight:600;font-size:13px;flex:1">Day<select name="day" style="${field}">${dayOptions(day)}</select></label>
      <label style="font-weight:600;font-size:13px;flex:1">Time<input type="time" name="time" required value="${esc(time)}" style="${field}"></label>
    </div>
    <label style="font-weight:600;font-size:13px">Message<textarea name="text" required rows="3" placeholder="Remember to sign up for training this Sunday!" style="${field};resize:vertical">${esc(text)}</textarea></label>
    <button type="submit" style="background:#1a7f37;color:#fff;border:0;border-radius:6px;padding:9px 16px;cursor:pointer;font-size:14px">${submitLabel}</button>
    <a href="/messages" style="margin-left:12px;font-size:14px">Cancel</a>
  </form>`;
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function createServer() {
  const port = process.env.PORT || 3000;

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const url = parsedUrl.pathname;

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
        console.error('[check] Health check failed:', err && err.stack ? err.stack : err);
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Health check', `
          <h2>❌ Session not healthy</h2>
          <p>The bot shows as connected but could not fetch chats. The weekly digest would fail.</p>
          <pre style="white-space:pre-wrap;color:#c0392b;text-align:left;max-width:700px;margin:12px auto;background:#fff;padding:12px;border-radius:8px;font-size:12px">${esc((err && err.stack) || (err && err.message) || String(err))}</pre>
          <p style="color:#888;font-size:13px">A common cause is a stale pinned WhatsApp Web version — see <code>webVersionCache</code> in <code>whatsapp.js</code>.</p>
          ${navLinks()}`));
      }
      return;
    }

    // Low-level diagnostic — reports what actually loaded in the WhatsApp Web page.
    if (url === '/diag') {
      try {
        const diag = await hooks.diagnostics();
        console.log('[diag]', JSON.stringify(diag));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Diagnostics', `
          <h2>🔬 WhatsApp Web diagnostics</h2>
          <pre style="white-space:pre-wrap;text-align:left;max-width:700px;margin:12px auto;background:#fff;padding:16px;border-radius:8px;font-size:13px">${esc(JSON.stringify(diag, null, 2))}</pre>
          ${navLinks()}`));
      } catch (err) {
        console.error('[diag] failed:', err && err.stack ? err.stack : err);
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Diagnostics', `<h2>Diagnostics unavailable</h2><pre style="white-space:pre-wrap;color:#c0392b">${esc((err && err.stack) || String(err))}</pre>${navLinks()}`));
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

    // Safe test — sends the digest to the bot's own "Message Yourself" chat.
    if (url === '/send-test' && req.method === 'POST') {
      await readBody(req);
      if (status !== 'ready') {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Send test', `<h2>⏳ Not ready</h2><p>The bot is not connected yet. Try again once it shows as connected.</p>${navLinks()}`));
        return;
      }
      const result = await hooks.triggerTestToSelf();
      const body = result.ok
        ? `<h2>✅ Test sent</h2><p>The digest was sent to the bot's own chat (<em>Message Yourself</em>). Open WhatsApp on the linked phone to see it — no group was touched.</p>`
        : `<h2>❌ Test failed</h2><pre style="white-space:pre-wrap;color:#c0392b">${esc(result.error)}</pre>`;
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Send test', body + navLinks()));
      return;
    }

    if (url === '/groups') {
      if (!whatsappClient || status !== 'ready') {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('⏳ Not ready', '<h2>⏳ Bot not ready</h2><p>Wait for the bot to be authenticated and try again.</p>'));
        return;
      }
      try {
        const groups = await hooks.listGroups();
        const items = groups.map((g) => {
          const tag = g.announce ? ' <strong style="color:green">← Community announcement channel</strong>' : '';
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

    // List scheduled jobs (digest + recurring messages), with controls for recurring ones.
    if (url === '/messages') {
      const btn = 'border:0;border-radius:5px;padding:5px 10px;cursor:pointer;font-size:13px;margin:0';
      const rows = hooks.getJobs().map((job) => {
        const run = state.getLastRun(job.id);
        const recurring = job.type === 'text';
        const schedule = recurring
          ? (job.enabled ? scheduleToHuman(job.schedule) : `<em style="color:#888">${scheduleToHuman(job.schedule)} (disabled)</em>`)
          : scheduleToHuman(job.schedule);
        const actions = recurring
          ? `<div style="display:flex;gap:6px;flex-wrap:wrap">
              <a href="/messages/edit?id=${encodeURIComponent(job.id)}" style="${btn};background:#eee;color:#333;text-decoration:none">Edit</a>
              <form method="POST" action="/messages/toggle" style="margin:0"><input type="hidden" name="id" value="${esc(job.id)}"><button type="submit" style="${btn};background:#e8e8e8;color:#333">${job.enabled ? 'Disable' : 'Enable'}</button></form>
              <form method="POST" action="/messages/delete" style="margin:0" onsubmit="return confirm('Delete this recurring message?')"><input type="hidden" name="id" value="${esc(job.id)}"><button type="submit" style="${btn};background:#b0381f;color:#fff">Delete</button></form>
            </div>`
          : '<span style="color:#aaa;font-size:13px">built-in</span>';
        return `<tr>
          <td style="padding:8px 12px">${esc(job.name)}</td>
          <td style="padding:8px 12px">${schedule}</td>
          <td style="padding:8px 12px">${runBadge(run)}</td>
          <td style="padding:8px 12px">${actions}</td>
        </tr>`;
      }).join('');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Scheduled messages', `
        <h2>🗓️ Scheduled messages</h2>
        <table style="margin:16px auto;border-collapse:collapse;text-align:left;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
          <thead><tr style="background:#eee">
            <th style="padding:8px 12px">Name</th><th style="padding:8px 12px">Schedule</th><th style="padding:8px 12px">Last run</th><th style="padding:8px 12px">Actions</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="color:#888;font-size:13px">Times are Europe/London. Recurring messages send to the same group as the weekly digest (<code>${esc(process.env.WHATSAPP_GROUP_NAME || '(group not set)')}</code>).</p>
        <h3 style="margin-top:32px">➕ Add a recurring message</h3>
        ${messageForm({ action: '/messages/add', submitLabel: 'Add message' })}
        ${navLinks()}`));
      return;
    }

    // Edit form for an existing recurring message.
    if (url === '/messages/edit' && req.method === 'GET') {
      const msg = messages.get(parsedUrl.searchParams.get('id') || '');
      if (!msg) { redirect(res, '/messages'); return; }
      const parsed = parseCron(msg.schedule) || { day: '2', time: '12:00' };
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Edit message', `
        <h2>✏️ Edit recurring message</h2>
        ${messageForm({ action: '/messages/edit', submitLabel: 'Save changes', id: msg.id, name: msg.name, day: parsed.day, time: parsed.time, text: msg.text })}
        ${navLinks()}`));
      return;
    }

    // Create / update / delete / toggle recurring messages.
    if ((url === '/messages/add' || url === '/messages/edit') && req.method === 'POST') {
      const f = parseForm(await readBody(req));
      const schedule = buildCron(f.day, f.time);
      if (!f.name || !f.text.trim() || !schedule) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Invalid', `<h2>⚠️ Could not save</h2><p>Please provide a name, a message, and a valid day/time.</p><p><a href="/messages">Back</a></p>`));
        return;
      }
      if (url === '/messages/add') {
        messages.add({ name: f.name, schedule, text: f.text });
      } else {
        messages.update(f.id, { name: f.name, schedule, text: f.text });
      }
      hooks.reloadSchedule();
      redirect(res, '/messages');
      return;
    }

    if (url === '/messages/delete' && req.method === 'POST') {
      const f = parseForm(await readBody(req));
      messages.remove(f.id);
      hooks.reloadSchedule();
      redirect(res, '/messages');
      return;
    }

    if (url === '/messages/toggle' && req.method === 'POST') {
      const f = parseForm(await readBody(req));
      const msg = messages.get(f.id);
      if (msg) messages.update(f.id, { enabled: !msg.enabled });
      hooks.reloadSchedule();
      redirect(res, '/messages');
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
            <form method="POST" action="/send-test" style="margin:0" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Sending…'">
              <button type="submit" style="background:#1a7f37;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;font-size:14px">Send test to yourself</button>
            </form>
            <form method="POST" action="/send-now" style="margin:0" onsubmit="return confirm('This posts the REAL digest to the live group. Continue?')&&(this.querySelector('button').disabled=true,this.querySelector('button').textContent='Sending…',true)">
              <button type="submit" style="background:#b0381f;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;font-size:14px">Send to live group</button>
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

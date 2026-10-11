/**
 * Persistent store of user-defined recurring messages.
 *
 * This is the data layer for the planned website feature where a user can add
 * messages to send on a schedule (e.g. "every Tuesday at 12:00 send
 * 'Remember to sign up for training this Sunday!'"). The scheduler reads from
 * here; a CRUD UI can be layered on top later without touching the scheduler.
 *
 * Backed by a JSON file in DATA_PATH. Each message:
 *   { id, type:'text', name, schedule (cron), text, group (null = default), enabled }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_PATH = process.env.DATA_PATH || './data';
const FILE = path.join(DATA_PATH, 'messages.json');

let messages = [];

function load() {
  try {
    messages = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(messages)) messages = [];
  } catch {
    messages = [];
  }
}

function persist() {
  try {
    fs.mkdirSync(DATA_PATH, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(messages, null, 2));
  } catch (err) {
    console.error('[messages] Failed to persist messages:', err.message);
  }
}

function list() {
  return messages.slice();
}

function get(id) {
  return messages.find((m) => m.id === id) || null;
}

function add({ name, schedule, text, group = null, enabled = true }) {
  const msg = {
    id: crypto.randomUUID(),
    type: 'text',
    name: name || 'Untitled message',
    schedule,
    text,
    group: group || null,
    enabled: enabled !== false,
    createdAt: new Date().toISOString(),
  };
  messages.push(msg);
  persist();
  return msg;
}

function update(id, patch) {
  const msg = get(id);
  if (!msg) return null;
  Object.assign(msg, patch, { id: msg.id, type: 'text' });
  persist();
  return msg;
}

function remove(id) {
  const before = messages.length;
  messages = messages.filter((m) => m.id !== id);
  const removed = messages.length !== before;
  if (removed) persist();
  return removed;
}

load();

module.exports = { list, get, add, update, remove };

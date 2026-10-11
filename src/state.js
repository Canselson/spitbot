/**
 * Persistent record of send results so failures are visible on the website
 * (and survive restarts). Backed by a JSON file in DATA_PATH.
 */
const fs = require('fs');
const path = require('path');

const DATA_PATH = process.env.DATA_PATH || './data';
const FILE = path.join(DATA_PATH, 'state.json');
const MAX_HISTORY = 25;

let state = { lastRunById: {}, history: [] };

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state.lastRunById = parsed.lastRunById || {};
    state.history = parsed.history || [];
  } catch {
    // No file yet (first run) — start empty.
  }
}

function persist() {
  try {
    fs.mkdirSync(DATA_PATH, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[state] Failed to persist state:', err.message);
  }
}

/**
 * Record the outcome of a send attempt.
 * @param {{id:string,name:string,type:string,ok:boolean,error?:string,detail?:object,trigger?:string}} run
 */
function recordRun({ id, name, type, ok, error, detail, trigger = 'schedule' }) {
  const entry = {
    id,
    name,
    type,
    ok: !!ok,
    error: error || null,
    detail: detail || null,
    trigger,
    at: new Date().toISOString(),
  };
  state.lastRunById[id] = entry;
  state.history.unshift(entry);
  state.history = state.history.slice(0, MAX_HISTORY);
  persist();
  return entry;
}

function getLastRun(id) {
  return state.lastRunById[id] || null;
}

function getHistory() {
  return state.history;
}

load();

module.exports = { recordRun, getLastRun, getHistory };

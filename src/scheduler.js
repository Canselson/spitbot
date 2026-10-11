/**
 * Data-driven scheduler.
 *
 * Builds cron jobs from two sources:
 *   1. The built-in weekly calendar digest (configured via env).
 *   2. User-defined recurring messages from the messages store.
 *
 * Every run — scheduled or manually triggered — goes through runJob(), which
 * records the outcome to state so success/failure is visible on the website.
 */
const cron = require('node-cron');
const { sendToGroup } = require('./whatsapp');
const { getWeekEvents } = require('./calendar');
const { formatWeeklyMessage } = require('./formatter');
const state = require('./state');
const messages = require('./messages');

const TZ = 'Europe/London';
const DIGEST_ID = 'weekly-digest';

let tasks = [];

function digestJob() {
  return {
    id: DIGEST_ID,
    name: 'Weekly calendar digest',
    type: 'digest',
    schedule: process.env.CRON_SCHEDULE || '0 8 * * 1',
    group: process.env.WHATSAPP_GROUP_NAME || null,
    enabled: true,
  };
}

/** All jobs the scheduler knows about (digest + stored messages), enabled or not. */
function allJobs() {
  return [digestJob(), ...messages.list()];
}

async function buildMessage(job) {
  if (job.type === 'digest') {
    const events = await getWeekEvents();
    return formatWeeklyMessage(events);
  }
  if (!job.text || !job.text.trim()) {
    throw new Error('Message has no text to send.');
  }
  return job.text;
}

/**
 * Execute a single job: build its message, send it, and record the result.
 * Never throws — always resolves with { ok, error, entry } so callers (cron and
 * the website "Send now" button) can react uniformly.
 */
async function runJob(job, trigger = 'schedule') {
  console.log(`[scheduler] Running "${job.name}" (${job.type}, ${trigger})…`);
  try {
    const message = await buildMessage(job);
    const group = job.group || process.env.WHATSAPP_GROUP_NAME;
    const detail = await sendToGroup(group, message);
    const entry = state.recordRun({
      id: job.id, name: job.name, type: job.type, ok: true, detail, trigger,
    });
    console.log(`[scheduler] "${job.name}" delivered to "${detail.chatName}".`);
    return { ok: true, error: null, entry };
  } catch (err) {
    const entry = state.recordRun({
      id: job.id, name: job.name, type: job.type, ok: false, error: err.message, trigger,
    });
    console.error(`[scheduler] "${job.name}" FAILED: ${err.message}`);
    return { ok: false, error: err.message, entry };
  }
}

/** Trigger the weekly digest immediately (used by the website "Send now" button). */
function runDigestNow() {
  return runJob(digestJob(), 'manual');
}

/** (Re)register cron tasks from the current set of enabled jobs. */
function reload() {
  for (const t of tasks) t.stop();
  tasks = [];

  for (const job of allJobs()) {
    if (!job.enabled) {
      console.log(`[scheduler] Skipping disabled job "${job.name}".`);
      continue;
    }
    if (!cron.validate(job.schedule)) {
      console.error(`[scheduler] Invalid schedule for "${job.name}": "${job.schedule}" — skipped.`);
      continue;
    }
    const task = cron.schedule(job.schedule, () => runJob(job, 'schedule'), { timezone: TZ });
    tasks.push(task);
    console.log(`[scheduler] Scheduled "${job.name}" at "${job.schedule}" (${TZ}).`);
  }
}

function start() {
  reload();
}

module.exports = { start, reload, runJob, runDigestNow, digestJob, allJobs, TZ };

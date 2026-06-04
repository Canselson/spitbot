require('dotenv').config();
const cron = require('node-cron');
const { createServer } = require('./qr-server');
const { createClient, sendToGroup } = require('./whatsapp');
const { getWeekEvents } = require('./calendar');
const { formatWeeklyMessage } = require('./formatter');

async function sendWeeklyDigest() {
  try {
    console.log('[digest] Fetching calendar events…');
    const events = await getWeekEvents();
    const message = formatWeeklyMessage(events);
    console.log('[digest] Message preview:\n', message, '\n');
    await sendToGroup(process.env.WHATSAPP_GROUP_NAME, message);
  } catch (err) {
    console.error('[digest] Error:', err.message);
  }
}

const schedule = process.env.CRON_SCHEDULE || '0 8 * * 1';

if (!cron.validate(schedule)) {
  console.error(`Invalid CRON_SCHEDULE: "${schedule}". Falling back to default: 0 8 * * 1`);
}

// Start the QR web server first so the URL is available while WhatsApp initialises
createServer();

console.log(`Starting spitbot. Schedule: "${schedule}" (Monday 08:00 by default)`);
console.log('Initialising WhatsApp — scan the QR code if prompted…');

createClient().initialize();

cron.schedule(schedule, () => {
  console.log('[cron] Triggered. Sending weekly digest…');
  sendWeeklyDigest();
});

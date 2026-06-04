/**
 * Immediately fetches this week's calendar events and sends the WhatsApp message.
 * Useful for testing your configuration without waiting for the Monday cron.
 *
 * Run with: npm run test-send
 */
require('dotenv').config();
const { createClient, waitUntilReady, sendToGroup } = require('./whatsapp');
const { getWeekEvents } = require('./calendar');
const { formatWeeklyMessage } = require('./formatter');

async function main() {
  console.log('Initialising WhatsApp — scan the QR code if this is your first run…\n');

  const client = createClient();
  // initialize() starts puppeteer and fires events asynchronously — do not await
  client.initialize();

  console.log('Waiting for WhatsApp to be ready (up to 5 minutes for QR scan)…');
  await waitUntilReady(300000);

  console.log('\nFetching calendar events for this week…');
  const events = await getWeekEvents();
  const message = formatWeeklyMessage(events);

  console.log('\n--- Message preview ---\n');
  console.log(message);
  console.log('\n-----------------------\n');

  console.log(`Sending to group: "${process.env.WHATSAPP_GROUP_NAME}"…`);
  await sendToGroup(process.env.WHATSAPP_GROUP_NAME, message);

  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

/**
 * Lists all WhatsApp groups you're a member of, including community sub-groups.
 * Run with: node src/list-groups.js
 */
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

client.on('qr', (qr) => {
  console.log('\nScan QR to authenticate:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  await new Promise((r) => setTimeout(r, 5000));
  const chats = await client.getChats();
  const groups = chats.filter((c) => c.isGroup);

  console.log(`\nFound ${groups.length} group(s):\n`);

  for (const g of groups) {
    const communityTag = g.groupMetadata?.isCommunityAnnounceGroup
      ? ' [Community announcement channel]'
      : g.groupMetadata?.isCommunity
      ? ' [Community]'
      : '';
    console.log(`  "${g.name}"${communityTag}`);
  }

  console.log('\nCopy the exact name (including capitalisation and spaces) into WHATSAPP_GROUP_NAME in .env');
  process.exit(0);
});

client.on('auth_failure', (msg) => {
  console.error('Auth failure:', msg);
  process.exit(1);
});

console.log('Connecting to WhatsApp…');
client.initialize();

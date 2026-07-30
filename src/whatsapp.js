const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { setQR, setReady, setClient } = require('./qr-server');

let client = null;
let isReady = false;

function createClient() {
  const authPath = process.env.WWEBJS_AUTH_PATH || './.wwebjs_auth';

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // required in Docker containers
        '--disable-gpu',
      ],
    },
  });

  client.on('qr', (qr) => {
    // Show in terminal (local) and via web server (remote/Railway)
    qrcode.generate(qr, { small: true });
    console.log('\n[whatsapp] Scan the QR code above, or open the app URL in your browser.\n');
    setQR(qr);
  });

  client.on('authenticated', () => {
    console.log('[whatsapp] Session authenticated.');
  });

  client.on('ready', () => {
    console.log('[whatsapp] Client ready.');
    isReady = true;
    setReady();
    setClient(client);
  });

  client.on('auth_failure', (msg) => {
    console.error('[whatsapp] Authentication failure —', msg);
    isReady = false;
  });

  client.on('disconnected', (reason) => {
    console.warn('[whatsapp] Disconnected —', reason);
    isReady = false;
  });

  return client;
}

async function waitUntilReady(timeoutMs = 300000) {
  if (isReady) return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`WhatsApp client did not become ready within ${timeoutMs / 1000}s`)),
      timeoutMs
    );
    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function sendToGroup(groupName, message) {
  if (!groupName) throw new Error('WHATSAPP_GROUP_NAME is not set in .env');

  await waitUntilReady();

  const chats = await client.getChats();
  const group = chats.find((chat) => chat.isGroup && chat.name === groupName);

  if (!group) {
    const groupNames = chats.filter((c) => c.isGroup).map((c) => `"${c.name}"`).join(', ');
    throw new Error(
      `Group "${groupName}" not found.\nAvailable groups: ${groupNames || '(none)'}\nCheck WHATSAPP_GROUP_NAME in .env`
    );
  }

  const meta = group.groupMetadata;
  const isAnnounce = !!(meta && (meta.announce || meta.isCommunityAnnounceGroup));

  const myNumber = client.info.wid.user;
  const participants = meta?.participants || [];
  const me = participants.find((p) => p.id.user === myNumber);
  const isAdmin = me ? (me.isAdmin || me.isSuperAdmin) : null;

  console.log(`[send] Chat: "${group.name}" | ID: ${group.id._serialized}`);
  console.log(`[send] Announce-only: ${isAnnounce} | Bot listed as admin: ${isAdmin ?? 'unknown'}`);

  if (isAnnounce && isAdmin === false) {
    throw new Error(
      'The bot account is not listed as an admin in this announcement channel.\n' +
      'Open the community in WhatsApp → Announcement group → Edit → make the linked number an admin.'
    );
  }

  if (isAnnounce) {
    const result = await client.pupPage.evaluate(async (chatId, text) => {
      try {
        const chat = window.Store.Chat.get(chatId);
        if (!chat) return { ok: false, err: `chat ${chatId} not in Store` };
        await window.Store.SendMessage.sendTextMsgToChat(chat, text, { ephemeralExpiration: 0 });
        return { ok: true };
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    }, group.id._serialized, message);

    if (!result.ok) {
      console.warn(`[send] Store API failed: ${result.err} — falling back to standard sendMessage`);
      await client.sendMessage(group.id._serialized, message);
    } else {
      console.log('[send] Dispatched via Store API.');
    }
  } else {
    await client.sendMessage(group.id._serialized, message);
  }

  await new Promise((r) => setTimeout(r, 3000));
  const recent = await group.fetchMessages({ limit: 10 });
  const confirmed = recent.find((m) => m.fromMe && m.body === message);
  if (confirmed) {
    console.log(`[send] Confirmed in chat history. Message delivered to "${groupName}".`);
  } else {
    console.warn(
      `[send] WARNING: message not found in chat history after 3 s.\n` +
      `       This usually means WhatsApp rejected it silently.\n` +
      `       Check that the linked account is an admin of the ANNOUNCEMENT channel.`
    );
  }
}

module.exports = { createClient, waitUntilReady, sendToGroup };

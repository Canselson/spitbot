const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { setQR, setReady, setClient } = require('./qr-server');
const { WA_WEB_VERSION_CACHE } = require('./wa-web-version');

let client = null;
let isReady = false;

function createClient() {
  const authPath = process.env.WWEBJS_AUTH_PATH || './.wwebjs_auth';

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    webVersionCache: WA_WEB_VERSION_CACHE,
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

function isClientReady() {
  return isReady;
}

/**
 * Actively verifies the session can talk to WhatsApp Web by fetching chats.
 * This is what "logged in" should really mean — it catches a stale pinned
 * WhatsApp Web version or a broken Store that the "ready" event alone misses.
 * Throws if the session is not usable.
 */
async function getSessionHealth() {
  if (!client || !isReady) throw new Error('WhatsApp client is not ready.');
  const chats = await client.getChats();
  const groups = chats.filter((c) => c.isGroup);
  return {
    totalChats: chats.length,
    groupCount: groups.length,
    me: client.info && client.info.wid ? client.info.wid.user : null,
  };
}

async function sendToGroup(groupName, message) {
  if (!groupName) throw new Error('WHATSAPP_GROUP_NAME is not set in .env');

  await waitUntilReady();

  const chats = await client.getChats();
  const matches = chats.filter((chat) => chat.isGroup && chat.name === groupName);

  if (matches.length === 0) {
    const groupNames = chats.filter((c) => c.isGroup).map((c) => `"${c.name}"`).join(', ');
    throw new Error(
      `Group "${groupName}" not found.\nAvailable groups: ${groupNames || '(none)'}\nCheck WHATSAPP_GROUP_NAME in .env`
    );
  }

  // Prefer the community announcement channel if there are multiple groups with the same name
  const group = matches.find((c) => {
    const m = c.groupMetadata;
    return m && (m.announce || m.isCommunityAnnounceGroup);
  }) ?? matches[0];

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
  if (!confirmed) {
    throw new Error(
      `Message was dispatched but did not appear in "${groupName}" after 3s — ` +
      `WhatsApp likely rejected it silently. ` +
      (isAnnounce
        ? 'This is almost always because the linked account is not an admin of the announcement channel.'
        : 'Check the account still has permission to post in this group.')
    );
  }

  console.log(`[send] Confirmed in chat history. Message delivered to "${groupName}".`);
  return {
    chatName: group.name,
    chatId: group.id._serialized,
    isAnnounce,
    isAdmin,
    confirmed: true,
  };
}

module.exports = { createClient, waitUntilReady, isClientReady, getSessionHealth, sendToGroup };

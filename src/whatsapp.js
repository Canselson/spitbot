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
 * Lightweight list of group chats: { id, name, announce }.
 *
 * Deliberately avoids client.getChats(), whose per-chat getChatModel()
 * serialization throws an IndexedDB DataError against current WhatsApp Web
 * builds. We only read the in-memory Chat collection, which works fine.
 */
async function listGroups() {
  if (!client || !isReady) throw new Error('WhatsApp client is not ready.');
  return client.pupPage.evaluate(() => {
    const chats = window.require('WAWebCollections').Chat.getModelsArray();
    return chats
      .filter((c) => {
        const id = (c.id && c.id._serialized) || '';
        return !!c.groupMetadata || /@g\.us$/.test(id);
      })
      .map((c) => {
        const meta = c.groupMetadata;
        return {
          id: c.id._serialized,
          name: c.formattedTitle || (meta && meta.subject) || '(unknown)',
          announce: !!(meta && (meta.announce || meta.isCommunityAnnounceGroup)),
        };
      });
  });
}

/**
 * Actively verifies the session can talk to WhatsApp Web by reading the chat
 * collection. This is what "logged in" should really mean — it catches a
 * stale pinned WhatsApp Web version that the "ready" event alone misses.
 * Throws if the session is not usable.
 */
async function getSessionHealth() {
  if (!client || !isReady) throw new Error('WhatsApp client is not ready.');
  const counts = await client.pupPage.evaluate(() => {
    const chats = window.require('WAWebCollections').Chat.getModelsArray();
    const groups = chats.filter((c) => {
      const id = (c.id && c.id._serialized) || '';
      return !!c.groupMetadata || /@g\.us$/.test(id);
    });
    return { totalChats: chats.length, groupCount: groups.length };
  });
  return {
    ...counts,
    me: client.info && client.info.wid ? client.info.wid.user : null,
  };
}

/**
 * Probes the WhatsApp Web page context to pinpoint why getChats() fails.
 * Never throws — every check is wrapped, so we always get a full report of
 * what loaded (actual WA Web version, module loader, the modules getChats needs).
 */
async function getDiagnostics() {
  if (!client || !isReady) throw new Error('WhatsApp client is not ready.');
  return client.pupPage.evaluate(async () => {
    const safe = (fn) => {
      try { const v = fn(); return v === undefined ? 'undefined' : v; }
      catch (e) { return `ERR: ${(e && e.message) || String(e)}`; }
    };
    const req = (m) => { try { return window.require(m) ? 'present' : 'undefined'; } catch (e) { return `ERR: ${e.message}`; } };

    const chats = window.require('WAWebCollections').Chat.getModelsArray();
    const perChat = [];
    for (let i = 0; i < chats.length; i++) {
      const c = chats[i];
      const info = { i, isGroup: !!c.groupMetadata, title: safe(() => c.formattedTitle) };
      try {
        await window.WWebJS.getChatModel(c);
        info.getChatModel = 'ok';
      } catch (e) {
        info.getChatModel = `ERR: ${(e && e.message) || String(e)} | name=${e && e.name}`;
      }
      perChat.push(info);
    }

    return {
      debugVersion: safe(() => window.Debug && window.Debug.VERSION),
      modules: {
        WAWebLidMigrationUtils: req('WAWebLidMigrationUtils'),
        WAWebWidFactory: req('WAWebWidFactory'),
        groupMetaInCollections: safe(() => {
          const C = window.require('WAWebCollections');
          return !!(C.GroupMetadata || C.WAWebGroupMetadataCollection) ? 'present' : 'undefined';
        }),
        toPnType: safe(() => typeof window.require('WAWebLidMigrationUtils').toPn),
      },
      perChat,
    };
  });
}

/**
 * Send text to a chat id and confirm it landed, all in the page context.
 * Avoids getChats/getChatModel/getMessageModel, which throw an IndexedDB
 * DataError against current WhatsApp Web builds.
 */
async function dispatchToChat(chatId, label, message, isAnnounce) {
  console.log(`[send] Chat: "${label}" | ID: ${chatId} | Announce-only: ${isAnnounce}`);

  const result = await client.pupPage.evaluate(async (chatId, text) => {
    try {
      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      if (!chat) return { ok: false, err: 'chat not found in page context' };
      const msg = await window.WWebJS.sendMessage(chat, text, {});
      return { ok: true, id: msg && msg.id ? msg.id._serialized : null };
    } catch (e) {
      return { ok: false, err: (e && e.message) || String(e) };
    }
  }, chatId, message);

  if (!result.ok) {
    throw new Error(`Failed to dispatch message to "${label}": ${result.err}`);
  }

  await new Promise((r) => setTimeout(r, 3000));

  const confirmed = await client.pupPage.evaluate(async (chatId, text) => {
    try {
      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      const msgs = chat && chat.msgs && chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : [];
      return msgs.slice(-15).some((m) => m && m.body === text && m.id && m.id.fromMe);
    } catch (e) {
      return false;
    }
  }, chatId, message);

  if (!confirmed) {
    throw new Error(
      `Message was dispatched but did not appear in "${label}" after 3s — ` +
      `WhatsApp likely rejected it silently. ` +
      (isAnnounce
        ? 'This is almost always because the linked account is not an admin of the announcement channel.'
        : 'Check the account still has permission to post in this chat.')
    );
  }

  console.log(`[send] Confirmed in chat history. Message delivered to "${label}".`);
  return { chatName: label, chatId, isAnnounce, confirmed: true };
}

async function sendToGroup(groupName, message) {
  if (!groupName) throw new Error('WHATSAPP_GROUP_NAME is not set in .env');

  await waitUntilReady();

  const groups = await listGroups();
  const matches = groups.filter((g) => g.name === groupName);

  if (matches.length === 0) {
    const names = groups.map((g) => `"${g.name}"`).join(', ');
    throw new Error(
      `Group "${groupName}" not found.\nAvailable groups: ${names || '(none)'}\nCheck WHATSAPP_GROUP_NAME in .env`
    );
  }

  // Prefer the community announcement channel if several groups share the name.
  const group = matches.find((g) => g.announce) || matches[0];
  return dispatchToChat(group.id, group.name, message, group.announce);
}

/**
 * Send to the bot's own "Message Yourself" chat — a safe end-to-end test that
 * never touches a real group. Proves the full send path works.
 */
async function sendToSelf(message) {
  await waitUntilReady();
  const selfId = client.info && client.info.wid ? client.info.wid._serialized : null;
  if (!selfId) throw new Error('Could not determine the linked account id.');
  return dispatchToChat(selfId, 'yourself (test)', message, false);
}

module.exports = { createClient, waitUntilReady, isClientReady, listGroups, getSessionHealth, getDiagnostics, sendToGroup, sendToSelf };

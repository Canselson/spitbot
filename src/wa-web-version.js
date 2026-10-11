/**
 * Pinned WhatsApp Web version, shared by whatsapp.js and list-groups.js.
 *
 * whatsapp-web.js can break against the live WhatsApp Web build, so we pin a
 * known-good HTML snapshot from wppconnect-team/wa-version. Symptom of drift:
 * `getChats()` throws a cryptic minified error and the bot authenticates but
 * can't fetch chats or send (the /check page will say "Session not healthy").
 *
 * To update: browse https://github.com/wppconnect-team/wa-version/tree/main/html
 * pick the newest 2.3000.*-alpha.html, update the version below, and rebuild.
 */
const WA_WEB_VERSION = '2.3000.1049983640-alpha';

const WA_WEB_VERSION_CACHE = {
  type: 'remote',
  remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${WA_WEB_VERSION}.html`,
};

module.exports = { WA_WEB_VERSION, WA_WEB_VERSION_CACHE };

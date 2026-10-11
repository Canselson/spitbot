require('dotenv').config();
const { createServer, setHooks } = require('./qr-server');
const { createClient, getSessionHealth, getDiagnostics } = require('./whatsapp');
const scheduler = require('./scheduler');

// Start the QR web server first so the URL is available while WhatsApp initialises.
createServer();

// Give the website its controls: manual send, deep health check, and the job list.
setHooks({
  triggerDigest: () => scheduler.runDigestNow(),
  healthCheck: () => getSessionHealth(),
  diagnostics: () => getDiagnostics(),
  getJobs: () => scheduler.allJobs(),
});

console.log(`Starting spitbot. Digest schedule: "${process.env.CRON_SCHEDULE || '0 8 * * 1'}" (Europe/London).`);
console.log('Initialising WhatsApp — scan the QR code if prompted…');

createClient().initialize();

// Register the weekly digest + any recurring messages.
scheduler.start();

const express = require('express');
const { config, validateStartupConfig } = require('./src/config');

try {
  validateStartupConfig();
} catch (error) {
  console.error('startup_configuration_error', { message: error.message });
  process.exit(1);
}

const { bot } = require('./bot');
const store = require('./src/services/store');
const notifications = require('./src/services/notifications');
const scheduledSales = require('./src/services/scheduledSales');
const { binancePay } = require('./src/services/binancePay');

const app = express();
app.disable('x-powered-by');
module.exports = app;

app.post('/webhook/telegram', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  try {
    if (config.webhookSecret && req.get('x-telegram-bot-api-secret-token') !== config.webhookSecret) {
      return res.status(401).send('Unauthorized');
    }
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    if (!raw) return res.status(400).send('Empty update');
    await bot.handleUpdate(JSON.parse(raw));
    return res.status(200).send('OK');
  } catch (error) {
    console.error('telegram_webhook_failed', { message: error.message });
    return res.status(200).send('OK');
  }
});

// Binance Pay is verified on demand against the signed account Pay Trade History API.
// No public Binance webhook is required for this mode.

app.use(express.json({ limit: '256kb' }));
app.get('/', (_, res) => res.json({ status: 'ok', service: 'telegram-store-bot' }));
app.get('/health', (_, res) => res.json({
  status: 'healthy',
  binanceAutomatic: binancePay.enabled,
  timestamp: new Date().toISOString()
}));

// Mount the authenticated web administration panel on the same Express app.
// admin.js reuses this exported instance and never creates a second server.
require('./admin');

let server = null;
let expiryTimer = null;

function startServer() {
  if (server) return server;
  server = app.listen(config.port, async () => {
    console.log('server_started', { port: config.port, mode: config.webhookUrl ? 'webhook' : 'polling' });
    try {
      if (config.webhookUrl) {
        const webhook = `${config.webhookUrl}/webhook/telegram`;
        await bot.telegram.setWebhook(webhook, config.webhookSecret ? { secret_token: config.webhookSecret } : {});
        console.log('telegram_webhook_configured', { url: webhook });
      } else {
        await bot.launch();
        console.log('telegram_polling_started');
      }
      notifications.startWorker(bot);
      scheduledSales.startWorker();
    } catch (error) {
      console.error('telegram_start_failed', { message: error.message });
      process.exitCode = 1;
    }
  });
  expiryTimer = setInterval(() => {
    store.expireDeposits().catch((error) => console.error('deposit_expiry_failed', { message: error.message }));
  }, 5 * 60 * 1000);
  expiryTimer.unref();
  return server;
}

async function shutdown(signal) {
  console.log('shutdown_started', { signal });
  if (expiryTimer) clearInterval(expiryTimer);
  notifications.stopWorker();
  scheduledSales.stopWorker();
  if (!config.webhookUrl) bot.stop(signal);
  if (!server) return;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

if (require.main === module) {
  startServer();
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = app;
module.exports.startServer = startServer;

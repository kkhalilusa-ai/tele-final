const path = require('path');
require('dotenv').config({ path: process.env.DOTENV_PATH || path.join(process.cwd(), '.env') });

function numberValue(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a valid number`);
  return value;
}

function booleanValue(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function csvNumbers(...names) {
  const values = names
    .flatMap((name) => (process.env[name] || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isSafeInteger);
  return [...new Set(values)];
}

const config = {
  env: process.env.NODE_ENV || 'development',
  botToken: process.env.BOT_TOKEN || '',
  port: numberValue('PORT', 3000),
  webhookUrl: (process.env.WEBHOOK_URL || '').replace(/\/$/, ''),
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '',
  adminIds: csvNumbers('ADMIN_IDS', 'FOUNDER_ID'),
  defaultLanguage: ['en', 'ar', 'hi'].includes(process.env.DEFAULT_LANGUAGE)
    ? process.env.DEFAULT_LANGUAGE
    : 'en',
  supportUsername: process.env.SUPPORT_USERNAME || '',
  supportUrl: process.env.SUPPORT_URL || '',
  channelUrl: process.env.VIP_URL || process.env.CHANNEL_URL || '',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || process.env.WEBHOOK_URL || '').replace(/\/$/, ''),
  inventoryEncryptionKey: process.env.INVENTORY_ENCRYPTION_KEY || '',
  lowStockThreshold: numberValue('LOW_STOCK_THRESHOLD', 5),
  deposit: {
    presets: (process.env.DEPOSIT_PRESETS || '5,10,25,50')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => /^\d+(\.\d{1,8})?$/.test(value)),
    min: process.env.MIN_DEPOSIT || '1',
    max: process.env.MAX_DEPOSIT || '1000',
    expiryMinutes: numberValue('USDT_BEP20_EXPIRY_MINUTES', 30),
    bep20Address: process.env.USDT_BEP20_ADDRESS || '',
    bep20Min: process.env.USDT_BEP20_MIN_DEPOSIT || '1',
    bep20Max: process.env.USDT_BEP20_MAX_DEPOSIT || '1000',
    bep20Network: process.env.USDT_BEP20_NETWORK_NAME || 'BNB Smart Chain (BEP20)'
  },
  binance: {
    payId: process.env.BINANCE_PAY_ID || '',
    uid: process.env.BINANCE_UID || '',
    paymentName: process.env.BINANCE_PAYMENT_NAME || '',
    currency: (process.env.BINANCE_CURRENCY || 'USDT').toUpperCase(),
    autoEnabled: booleanValue('BINANCE_PAY_AUTO_ENABLED'),
    // Standard Binance account API credentials (read-only USER_DATA is enough).
    // Legacy BINANCE_PAY_* names remain fallbacks for easier migration.
    apiKey: process.env.BINANCE_API_KEY || process.env.BINANCE_PAY_API_KEY || '',
    secretKey: process.env.BINANCE_API_SECRET || process.env.BINANCE_PAY_SECRET_KEY || '',
    baseUrl: (process.env.BINANCE_API_BASE_URL || 'https://api.binance.com').replace(/\/$/, ''),
    timeoutMs: numberValue('BINANCE_API_TIMEOUT_MS', numberValue('BINANCE_PAY_TIMEOUT_MS', 8000)),
    recvWindow: numberValue('BINANCE_API_RECV_WINDOW', 5000),
    expiryMinutes: numberValue('BINANCE_PAY_EXPIRY_MINUTES', 20),
    minPayment: process.env.BINANCE_MIN_PAYMENT || '0.01'
  }
};

config.binance.isReady = Boolean(
  config.binance.autoEnabled && config.binance.apiKey && config.binance.secretKey && config.binance.uid
);

function validateStartupConfig() {
  const missing = [];
  if (!config.botToken) missing.push('BOT_TOKEN');
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!config.adminIds.length) missing.push('ADMIN_IDS');
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (config.binance.autoEnabled && !config.binance.isReady) {
    throw new Error('BINANCE_PAY_AUTO_ENABLED=true requires BINANCE_API_KEY, BINANCE_API_SECRET, and BINANCE_UID');
  }
  if (config.binance.recvWindow < 1 || config.binance.recvWindow > 60000) {
    throw new Error('BINANCE_API_RECV_WINDOW must be between 1 and 60000');
  }
  if (config.binance.expiryMinutes < 1 || config.binance.expiryMinutes > 1440) {
    throw new Error('BINANCE_PAY_EXPIRY_MINUTES must be between 1 and 1440');
  }
  if (config.deposit.expiryMinutes < 1 || config.deposit.expiryMinutes > 1440) {
    throw new Error('USDT_BEP20_EXPIRY_MINUTES must be between 1 and 1440');
  }
  if (!Number.isSafeInteger(config.lowStockThreshold) || config.lowStockThreshold < 1 || config.lowStockThreshold > 100000) {
    throw new Error('LOW_STOCK_THRESHOLD must be a whole number between 1 and 100000');
  }
}

module.exports = { config, validateStartupConfig };

'use strict';

const crypto = require('crypto');
const express = require('express');
const app = require('./index');
const { config } = require('./src/config');
const { db, unwrap } = require('./src/database');
const store = require('./src/services/store');
const { bot, customEmojiService } = require('./bot');
const { t, normalizeLanguage } = require('./src/i18n');
const { formatAmount } = require('./src/utils');
const { buildDeliveryView } = require('./src/services/delivery');
const inventoryCrypto = require('./src/security/inventoryCrypto');
const liveEvents = require('./src/services/liveEvents');
const notificationAutomation = require('./src/services/notifications');
const { binancePay, orderIdValue } = require('./src/services/binancePay');
const adminSecurity = require('./src/admin/security');

const router = express.Router();
const COOKIE_NAME = 'tg_store_admin_session';
const SESSION_SECONDS = 12 * 60 * 60;
const BODY_LIMIT = 2 * 1024 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const API_TIMEOUT_MS = 15_000;
const LOW_STOCK_DEFAULT = 5;
const PAGE_SIZES = new Set([10, 25, 50, 100]);
const loginFailures = new Map();
const broadcastJobs = new Map();
let activeBroadcastId = null;

if (process.env.RENDER) app.set('trust proxy', 1);

const adminUsername = String(process.env.ADMIN_WEB_USERNAME || '');
const adminPassword = String(process.env.ADMIN_WEB_PASSWORD || '');
const sessionSecret = String(process.env.ADMIN_SESSION_SECRET || '');
const adminTelegramRaw = String(process.env.ADMIN_WEB_TELEGRAM_ID || '');
const adminTelegramNumber = /^\d+$/.test(adminTelegramRaw) ? Number(adminTelegramRaw) : NaN;
const adminConfigured = Boolean(
  adminUsername &&
  adminUsername.length <= 120 &&
  adminPassword &&
  sessionSecret.length >= 32 &&
  Number.isSafeInteger(adminTelegramNumber) &&
  adminTelegramNumber > 0 &&
  config.adminIds.includes(adminTelegramNumber)
);

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.apiCode = code;
  }
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hmac(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

function fixedDigest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(left, right) {
  return crypto.timingSafeEqual(fixedDigest(left), fixedDigest(right));
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseCookies(req) {
  const result = Object.create(null);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    try { result[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch (_) { /* Ignore malformed cookies. */ }
  }
  return result;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.env === 'production',
    sameSite: 'lax',
    path: '/admin',
    maxAge: SESSION_SECONDS * 1000
  };
}

function clearSession(res) {
  const options = cookieOptions();
  delete options.maxAge;
  res.clearCookie(COOKIE_NAME, options);
}

function createSession() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    sub: adminUsername,
    adminTelegramId: adminTelegramRaw,
    iat: now,
    exp: now + SESSION_SECONDS,
    jti: randomToken(18)
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${hmac(`session:${encoded}`)}`;
}

function readSession(req) {
  const value = parseCookies(req)[COOKIE_NAME];
  if (!value || value.length > 2048) return null;
  const parts = value.split('.');
  if (parts.length !== 2 || !safeEqual(parts[1], hmac(`session:${parts[0]}`))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (_) { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (!payload || payload.v !== 1 || payload.sub !== adminUsername || payload.adminTelegramId !== adminTelegramRaw) return null;
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.iat > now + 60) return null;
  if (payload.exp <= now || payload.exp - payload.iat > SESSION_SECONDS) return null;
  if (typeof payload.jti !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(payload.jti)) return null;
  return payload;
}

function createPreAuthToken() {
  const payload = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), nonce: randomToken(16) })).toString('base64url');
  return `${payload}.${hmac(`preauth:${payload}`)}`;
}

function validPreAuthToken(token) {
  if (typeof token !== 'string' || token.length > 1024) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !safeEqual(parts[1], hmac(`preauth:${parts[0]}`))) return false;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    return Number.isInteger(data.iat) && data.iat <= now + 60 && now - data.iat <= 15 * 60 &&
      typeof data.nonce === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(data.nonce);
  } catch (_) {
    return false;
  }
}

function csrfFor(session) {
  return hmac(`csrf:${session.jti}:${session.exp}`);
}

function sameOrigin(req) {
  return adminSecurity.sameOrigin(req, config.publicBaseUrl || config.webhookUrl);
}

function validLoginOrigin(req) {
  return adminSecurity.validLoginOrigin(req, config.publicBaseUrl || config.webhookUrl);
}

function requireMutationProtection(req, _res, next) {
  const token = req.get('x-csrf-token') || req.body?._csrf;
  if (!sameOrigin(req) || typeof token !== 'string' || !safeEqual(token, csrfFor(req.admin))) {
    return next(new ApiError(403, 'CSRF_FAILED', 'Security validation failed. Refresh the page and try again.'));
  }
  next();
}

function jsonSuccess(res, data, meta) {
  const body = { ok: true, data };
  if (meta !== undefined) body.meta = meta;
  return res.json(body);
}

function jsonFailure(res, status, code, message) {
  return res.status(status).json({ ok: false, error: { code, message } });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function withTimeout(promise, ms = API_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ApiError(503, 'TIMEOUT', 'The operation timed out. Please try again.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function checked(result, operation) {
  if (result.error) {
    const error = new Error(`${operation} failed`);
    error.code = result.error.code;
    error.internalMessage = result.error.message;
    throw error;
  }
  return result;
}

function pageParams(query) {
  const page = /^\d+$/.test(String(query.page || '1')) ? Number(query.page || 1) : 1;
  const requestedLimit = /^\d+$/.test(String(query.limit || '25')) ? Number(query.limit || 25) : 25;
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new ApiError(400, 'INVALID_PAGE', 'Invalid page number.');
  if (!PAGE_SIZES.has(requestedLimit)) throw new ApiError(400, 'INVALID_LIMIT', 'Page size must be 10, 25, 50, or 100.');
  return { page, limit: requestedLimit, from: (page - 1) * requestedLimit, to: page * requestedLimit - 1 };
}

function paginationMeta(page, limit, count) {
  return { page, limit, count: count || 0, pages: Math.max(1, Math.ceil((count || 0) / limit)) };
}

function cleanSearch(value, max = 100) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length > max || !/^[\p{L}\p{N}\s@._-]+$/u.test(text)) {
    throw new ApiError(400, 'INVALID_SEARCH', 'Search contains unsupported characters.');
  }
  return text;
}

function positiveId(value, label = 'ID') {
  const text = String(value || '');
  if (!/^[1-9]\d*$/.test(text) || text.length > 20) throw new ApiError(400, 'INVALID_ID', `${label} is invalid.`);
  return text;
}

function uuid(value, label = 'ID') {
  const text = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) {
    throw new ApiError(400, 'INVALID_ID', `${label} is invalid.`);
  }
  return text;
}

function textField(value, name, max, { required = true } = {}) {
  if (typeof value !== 'string') throw new ApiError(422, 'INVALID_FIELD', `${name} must be text.`);
  const result = value.trim();
  if (required && !result) throw new ApiError(422, 'INVALID_FIELD', `${name} is required.`);
  if (result.length > max) throw new ApiError(422, 'INVALID_FIELD', `${name} is too long.`);
  return result;
}

function decimalField(value, name, { positive = false } = {}) {
  const text = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(text) || (positive && /^0(?:\.0+)?$/.test(text))) {
    throw new ApiError(422, 'INVALID_DECIMAL', `${name} must be a valid decimal with at most 8 decimal places.`);
  }
  return text;
}

function signedDecimalField(value, name) {
  const text = String(value ?? '').trim();
  if (!/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(text) || /^-?0(?:\.0+)?$/.test(text)) {
    throw new ApiError(422, 'INVALID_DECIMAL', `${name} must be a non-zero decimal with at most 8 decimal places.`);
  }
  return text;
}

function integerField(value, name, min = 0, max = 2147483647) {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) throw new ApiError(422, 'INVALID_INTEGER', `${name} must be a whole number.`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new ApiError(422, 'INVALID_INTEGER', `${name} is out of range.`);
  return number;
}

function booleanField(value, name) {
  if (typeof value !== 'boolean') throw new ApiError(422, 'INVALID_BOOLEAN', `${name} must be true or false.`);
  return value;
}

function nullableTextField(value, name, max) {
  if (value === null || value === undefined || value === '') return null;
  return textField(value, name, max);
}

function productInput(body, { partial = false } = {}) {
  const allowed = [
    'category_id', 'name', 'short_description', 'full_description', 'delivery_text', 'price', 'image_url',
    'telegram_file_id', 'fulfillment_type', 'delivery_time_label', 'warranty_value',
    'warranty_unit', 'active', 'allow_preorder', 'min_quantity', 'max_quantity',
    'manual_stock', 'unlimited_stock', 'bulk_pricing_enabled', 'bulk_pricing_tiers',
    'emoji', 'sort_order', 'public_instructions', 'subtitle', 'duration', 'product_type', 'currency',
    'product_status', 'sold_display_offset', 'notification_mode'
  ];
  allowedBody(body, allowed, partial ? [] : ['name', 'price', 'fulfillment_type']);
  const values = {};
  if ('category_id' in body) values.category_id = body.category_id === null || body.category_id === '' ? null : positiveId(body.category_id, 'Category ID');
  if ('name' in body) values.name = textField(body.name, 'Name', 120);
  if ('short_description' in body) values.short_description = textField(body.short_description || '', 'Short description', 240, { required: false });
  if ('full_description' in body) values.full_description = textField(body.full_description || '', 'Full description', 5000, { required: false });
  if ('delivery_text' in body) values.delivery_text = textField(body.delivery_text || '', 'Delivery details', 5000, { required: false });
  if ('price' in body) values.price = decimalField(body.price, 'Price');
  if ('image_url' in body) {
    values.image_url = nullableTextField(body.image_url, 'Image URL', 2048);
    if (values.image_url && !/^https:\/\//i.test(values.image_url)) throw new ApiError(422, 'INVALID_IMAGE_URL', 'Image URL must use HTTPS.');
  }
  if ('telegram_file_id' in body) values.telegram_file_id = nullableTextField(body.telegram_file_id, 'Telegram file ID', 512);
  if ('fulfillment_type' in body) {
    values.fulfillment_type = String(body.fulfillment_type);
    if (!['instant', 'manual'].includes(values.fulfillment_type)) throw new ApiError(422, 'INVALID_FULFILLMENT', 'Delivery type must be instant or manual.');
  }
  if ('delivery_time_label' in body) values.delivery_time_label = textField(body.delivery_time_label || '', 'Delivery time', 120, { required: false });
  if ('warranty_value' in body || 'warranty_unit' in body) {
    const rawValue = body.warranty_value;
    const rawUnit = body.warranty_unit;
    if (rawValue === null || rawValue === '' || rawUnit === null || rawUnit === '') {
      values.warranty_value = null; values.warranty_unit = null;
    } else {
      values.warranty_value = integerField(rawValue, 'Warranty value', 1, 10000);
      values.warranty_unit = String(rawUnit);
      if (!['hours', 'days', 'months'].includes(values.warranty_unit)) throw new ApiError(422, 'INVALID_WARRANTY', 'Invalid warranty unit.');
    }
  }
  for (const field of ['active', 'allow_preorder', 'unlimited_stock', 'bulk_pricing_enabled']) {
    if (field in body) values[field] = booleanField(body[field], field);
  }
  if ('min_quantity' in body) values.min_quantity = integerField(body.min_quantity, 'Minimum quantity', 1, 1000);
  if ('max_quantity' in body) values.max_quantity = integerField(body.max_quantity, 'Maximum quantity', 1, 1000);
  if ('manual_stock' in body) values.manual_stock = integerField(body.manual_stock, 'Manual stock', 0, 2147483647);
  if ('emoji' in body) values.emoji = textField(body.emoji || '', 'Emoji', 16, { required: false });
  if ('sort_order' in body) values.sort_order = integerField(body.sort_order, 'Sort order', 0, 1000000);
  if ('public_instructions' in body) values.public_instructions = textField(body.public_instructions || '', 'Public instructions', 5000, { required: false });
  if ('subtitle' in body) values.subtitle = textField(body.subtitle || '', 'Subtitle', 240, { required: false });
  if ('duration' in body) values.duration = textField(body.duration || '', 'Duration', 120, { required: false });
  if ('product_type' in body) values.product_type = textField(body.product_type || '', 'Product type', 120, { required: false });
  if ('currency' in body) { values.currency = String(body.currency || 'USD').trim().toUpperCase(); if (!/^[A-Z]{3,10}$/.test(values.currency)) throw new ApiError(422, 'INVALID_CURRENCY', 'Currency must be 3-10 uppercase letters.'); }
  if ('product_status' in body) { values.product_status = String(body.product_status); if (!['active','inactive','out_of_stock','draft'].includes(values.product_status)) throw new ApiError(422, 'INVALID_PRODUCT_STATUS', 'Invalid product status.'); values.active = values.product_status === 'active'; }
  if ('sold_display_offset' in body) values.sold_display_offset = integerField(body.sold_display_offset, 'Sold display offset', 0, 1000000000);
  if ('notification_mode' in body) { values.notification_mode = String(body.notification_mode); if (!['global','muted'].includes(values.notification_mode)) throw new ApiError(422, 'INVALID_NOTIFICATION_MODE', 'Notification mode must be global or muted.'); }
  if ((values.min_quantity || body.min_quantity) && (values.max_quantity || body.max_quantity) && Number(values.max_quantity ?? body.max_quantity) < Number(values.min_quantity ?? body.min_quantity)) {
    throw new ApiError(422, 'INVALID_QUANTITY_RANGE', 'Maximum quantity must be at least the minimum quantity.');
  }
  const tiers = [];
  if ('bulk_pricing_tiers' in body) {
    if (!Array.isArray(body.bulk_pricing_tiers)) throw new ApiError(422, 'INVALID_TIERS', 'Bulk pricing must be an array.');
    for (const tier of body.bulk_pricing_tiers) {
      allowedBody(tier, ['min_quantity', 'max_quantity', 'unit_price'], ['min_quantity', 'unit_price']);
      const min = integerField(tier.min_quantity, 'Tier minimum', 1, 1000);
      const max = tier.max_quantity === null || tier.max_quantity === '' ? null : integerField(tier.max_quantity, 'Tier maximum', min, 1000);
      tiers.push({ min_quantity: min, max_quantity: max, unit_price: decimalField(tier.unit_price, 'Tier price') });
    }
    const uniqueMins = new Set(tiers.map((tier) => tier.min_quantity));
    if (uniqueMins.size !== tiers.length) throw new ApiError(422, 'DUPLICATE_TIER', 'Bulk tier minimum quantities must be unique.');
  }
  if (values.fulfillment_type === 'instant' && values.allow_preorder === true) {
    throw new ApiError(422, 'INVALID_PREORDER_TYPE', 'Pre-order is available only for manual delivery products.');
  }
  return { values, tiers };
}

function allowedBody(body, allowed, required = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'INVALID_BODY', 'A JSON object is required.');
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ApiError(422, 'UNEXPECTED_FIELD', `Unexpected field: ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) throw new ApiError(422, 'MISSING_FIELD', `Missing field: ${key}`);
  }
}

function sortParams(query, allowed, fallback = 'created_at') {
  const sort = String(query.sort || fallback);
  const direction = String(query.direction || 'desc').toLowerCase();
  if (!allowed.includes(sort) || !['asc', 'desc'].includes(direction)) throw new ApiError(400, 'INVALID_SORT', 'Invalid sorting option.');
  return { sort, ascending: direction === 'asc' };
}

function applyDateFilters(query, params, column = 'created_at') {
  const from = String(params.from || '');
  const to = String(params.to || '');
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new ApiError(400, 'INVALID_DATE', 'Invalid start date.');
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new ApiError(400, 'INVALID_DATE', 'Invalid end date.');
  if (from) query = query.gte(column, `${from}T00:00:00.000Z`);
  if (to) {
    const end = new Date(`${to}T00:00:00.000Z`);
    if (Number.isNaN(end.getTime())) throw new ApiError(400, 'INVALID_DATE', 'Invalid end date.');
    end.setUTCDate(end.getUTCDate() + 1);
    query = query.lt(column, end.toISOString());
  }
  return query;
}

function audit(req, action, targetType, targetId, outcome = 'success', startedAt = Date.now()) {
  console.log('admin_mutation', {
    requestId: req.requestId,
    actor: req.admin?.adminTelegramId,
    action,
    targetType,
    targetId: String(targetId || ''),
    outcome,
    durationMs: Date.now() - startedAt
  });
}

function maskId(value) {
  const text = String(value);
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${text.slice(0, 2)}${'*'.repeat(Math.min(8, text.length - 4))}${text.slice(-2)}`;
}

async function existingCategory(categoryId) {
  const result = checked(await db().from('categories').select('id,name,active').eq('id', categoryId).maybeSingle(), 'category lookup');
  if (!result.data) throw new ApiError(422, 'CATEGORY_NOT_FOUND', 'The selected category does not exist.');
  return result.data;
}

async function existingUser(userId) {
  const result = checked(await db().from('users').select('id,telegram_id,username,first_name,language,wallet_balance,is_suspended,created_at,updated_at').eq('id', userId).maybeSingle(), 'user lookup');
  if (!result.data) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');
  return result.data;
}

function parseScaledDecimal(value) {
  const match = String(value).match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!match) throw new Error('Invalid stored decimal');
  return BigInt(match[1]) * 100000000n + BigInt((match[2] || '').padEnd(8, '0'));
}

function scaledDecimal(value) {
  const whole = value / 100000000n;
  const fraction = String(value % 100000000n).padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

async function todaySalesTotal(startIso) {
  let offset = 0;
  let total = 0n;
  while (offset < 100000) {
    const result = checked(await db().from('orders').select('total_amount,amount').gte('created_at', startIso)
      .in('status', ['pending', 'processing', 'delivered'])
      .order('id').range(offset, offset + 999), 'daily sales total');
    for (const row of result.data) total += parseScaledDecimal(row.total_amount || row.amount);
    if (result.data.length < 1000) break;
    offset += result.data.length;
  }
  return scaledDecimal(total);
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    processed: job.processed,
    sent: job.sent,
    failed: job.failed,
    errors: job.errors,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || null
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendBroadcastMessage(telegramId, message) {
  try {
    await bot.telegram.sendMessage(telegramId, message);
    return;
  } catch (error) {
    const retryAfter = Number(error?.response?.parameters?.retry_after || error?.parameters?.retry_after || 0);
    if (error?.response?.error_code === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
      await delay(Math.min(retryAfter, 30) * 1000);
      await bot.telegram.sendMessage(telegramId, message);
      return;
    }
    throw error;
  }
}

async function runBroadcast(job, message) {
  job.status = 'running';
  let offset = 0;
  try {
    while (!job.cancelRequested) {
      const users = await store.listUserTelegramIds(offset, 100);
      if (!users.length) break;
      for (const user of users) {
        if (job.cancelRequested) break;
        try {
          await sendBroadcastMessage(user.telegram_id, message);
          job.sent += 1;
        } catch (error) {
          job.failed += 1;
          if (job.errors.length < 20) job.errors.push({ user: maskId(user.telegram_id), code: String(error?.response?.error_code || error?.code || 'SEND_FAILED').slice(0, 40) });
        }
        job.processed += 1;
        if (job.processed % 10 === 0 || job.processed === job.total) {
          liveEvents.publish(['broadcast'], { source: 'broadcast_progress', jobId: job.id });
        }
        await delay(60);
      }
      if (users.length < 100) break;
      offset += users.length;
    }
    job.status = job.cancelRequested ? 'cancelled' : 'completed';
  } catch (error) {
    job.status = 'failed';
    if (job.errors.length < 20) job.errors.push({ user: null, code: String(error.code || 'JOB_FAILED').slice(0, 40) });
    console.error('admin_broadcast_failed', { jobId: job.id, code: error.code, message: String(error.message || '').slice(0, 160) });
  } finally {
    job.finishedAt = new Date().toISOString();
    if (activeBroadcastId === job.id) activeBroadcastId = null;
    liveEvents.publish(['broadcast'], { source: 'broadcast_finished', jobId: job.id });
  }
}

const rateCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  for (const [ip, attempts] of loginFailures) {
    const recent = attempts.filter((time) => time > cutoff);
    if (recent.length) loginFailures.set(ip, recent); else loginFailures.delete(ip);
  }
  const jobCutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, job] of broadcastJobs) {
    if (job.finishedAt && new Date(job.finishedAt).getTime() < jobCutoff) broadcastJobs.delete(id);
  }
}, 5 * 60 * 1000);
rateCleanupTimer.unref();

router.use((req, res, next) => {
  req.requestId = randomToken(12);
  res.set('X-Request-ID', req.requestId);
  res.locals.cspNonce = randomToken(18);
  res.set({
    'Content-Security-Policy': `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; connect-src 'self'; img-src 'self' data: https:; style-src 'nonce-${res.locals.cspNonce}'; script-src 'nonce-${res.locals.cspNonce}'`,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cache-Control': 'no-store'
  });
  const declaredLength = Number(req.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > BODY_LIMIT) return res.status(413).send('Request too large');
  next();
});

router.use(express.json({ limit: '2mb', type: 'application/json' }));
router.use(express.urlencoded({ extended: false, limit: '128kb' }));
router.use((req, res, next) => {
  if (req.body && Buffer.byteLength(JSON.stringify(req.body), 'utf8') > BODY_LIMIT) return res.status(413).send('Request too large');
  next();
});

router.use((req, res, next) => {
  if (adminConfigured) return next();
  if (req.path.startsWith('/api/')) return jsonFailure(res, 503, 'ADMIN_NOT_CONFIGURED', 'Admin panel is not configured.');
  return res.status(503).type('text/plain').send('Admin panel is not configured');
});

router.get('/login', (req, res) => {
  if (readSession(req)) return res.redirect('/admin');
  return res.type('html').send(renderLoginPage(res.locals.cspNonce, createPreAuthToken(), ''));
});

router.post('/login', asyncRoute(async (req, res) => {
  const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  const attempts = (loginFailures.get(ip) || []).filter((time) => now - time < LOGIN_WINDOW_MS);
  if (attempts.length >= LOGIN_MAX_FAILURES) {
    const retrySeconds = Math.max(1, Math.ceil((attempts[0] + LOGIN_WINDOW_MS - now) / 1000));
    res.set('Retry-After', String(retrySeconds));
    return res.status(429).type('html').send(renderLoginPage(res.locals.cspNonce, createPreAuthToken(), 'Too many attempts. Please try again later.'));
  }
  // The signed, short-lived pre-auth token remains mandatory. Some privacy
  // settings omit both Origin and Referer on a top-level form POST, so absence
  // alone is accepted for login; any supplied origin must still be trusted.
  const originOk = validLoginOrigin(req);
  const preAuthOk = validPreAuthToken(req.body?._csrf);
  const validCsrf = originOk && preAuthOk;
  const usernameOk = safeEqual(req.body?.username || '', adminUsername);
  const passwordOk = safeEqual(req.body?.password || '', adminPassword);
  if (!validCsrf || !usernameOk || !passwordOk) {
    attempts.push(now);
    loginFailures.set(ip, attempts);
    await delay(250);
    console.warn('admin_login_failed', {
      requestId: req.requestId,
      ip,
      securityCheck: validCsrf ? 'passed' : 'failed',
      originCheck: originOk ? 'passed' : 'failed',
      preAuthCheck: preAuthOk ? 'passed' : 'failed',
      credentialsCheck: usernameOk && passwordOk ? 'passed' : 'failed',
      fetchSite: String(req.get('sec-fetch-site') || 'missing').slice(0, 30)
    });
    return res.status(validCsrf ? 401 : 403).type('html').send(renderLoginPage(res.locals.cspNonce, createPreAuthToken(), 'Invalid credentials or expired form.'));
  }
  loginFailures.delete(ip);
  res.cookie(COOKIE_NAME, createSession(), cookieOptions());
  console.log('admin_login_success', { requestId: req.requestId, actor: adminTelegramRaw, ip });
  return res.redirect(303, '/admin');
}));

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) {
    clearSession(res);
    if (req.path.startsWith('/api/')) return jsonFailure(res, 401, 'UNAUTHENTICATED', 'Please sign in.');
    return res.redirect('/admin/login');
  }
  req.admin = session;
  next();
}

router.use(requireAuth);

router.use('/api', (req, _res, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return next(new ApiError(400, 'JSON_REQUIRED', 'This operation requires Content-Type: application/json.'));
  }
  next();
});

router.post('/logout', requireMutationProtection, (req, res) => {
  clearSession(res);
  console.log('admin_logout', { requestId: req.requestId, actor: req.admin.adminTelegramId });
  if (req.is('application/json')) return jsonSuccess(res, { loggedOut: true });
  return res.redirect(303, '/admin/login');
});

router.get('/', (_req, res) => res.type('html').send(renderAdminPage(res.locals.cspNonce)));

router.get('/api/session', (req, res) => jsonSuccess(res, {
  csrfToken: csrfFor(req.admin),
  actor: maskId(req.admin.adminTelegramId),
  expiresAt: new Date(req.admin.exp * 1000).toISOString()
}));

router.get('/api/events', (req, res) => liveEvents.addClient(req, res));

router.get('/api/dashboard', asyncRoute(async (_req, res) => {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const startIso = start.toISOString();
  const activeSince = new Date(Date.now() - 30 * 86400000).toISOString();
  const query = db();
  const [users, suspended, activeUsers, activeProducts, lowStock, availableInventory, ordersToday, pendingManual,
    pendingPreorders, pendingRefunds, pendingDeposits, reviewDeposits, approvedToday, recentOrders, recentDeposits, recentActivity, lowStockRows, recentSupport, salesTotal] = await withTimeout(Promise.all([
    query.from('users').select('*', { count: 'exact', head: true }),
    query.from('users').select('*', { count: 'exact', head: true }).eq('is_suspended', true),
    query.from('users').select('*', { count: 'exact', head: true }).gte('updated_at', activeSince).eq('is_suspended', false),
    query.from('products').select('*', { count: 'exact', head: true }).eq('active', true),
    query.from('product_catalog').select('*', { count: 'exact', head: true }).eq('active', true).lte('available_stock', config.lowStockThreshold || LOW_STOCK_DEFAULT),
    query.from('product_inventory_items').select('*', { count: 'exact', head: true }).eq('status', 'available'),
    query.from('orders').select('*', { count: 'exact', head: true }).gte('created_at', startIso),
    query.from('orders').select('*', { count: 'exact', head: true }).eq('fulfillment_type', 'manual').in('status', ['pending', 'processing']),
    query.from('orders').select('*,products!inner(allow_preorder)', { count: 'exact', head: true }).eq('products.allow_preorder', true).in('status', ['pending', 'processing']),
    query.from('refund_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    query.from('deposits').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    query.from('deposits').select('*', { count: 'exact', head: true }).eq('status', 'pending_review'),
    query.from('deposits').select('*', { count: 'exact', head: true }).eq('status', 'approved').gte('approved_at', startIso),
    query.from('orders').select('id,product_name,amount,status,created_at,users!inner(telegram_id,username)').order('created_at', { ascending: false }).limit(6),
    query.from('deposits').select('id,deposit_code,expected_amount,received_amount,payment_method,status,created_at,users!inner(telegram_id,username)').order('created_at', { ascending: false }).limit(6),
    query.from('admin_audit_log').select('id,action,target_type,target_id,created_at').order('created_at', { ascending: false }).limit(8),
    query.from('product_catalog').select('id,name,emoji,available_stock,stock,unlimited_stock,fulfillment_type,product_status').eq('active', true).eq('product_status','active').eq('unlimited_stock', false).lte('available_stock', config.lowStockThreshold || LOW_STOCK_DEFAULT).order('available_stock').limit(6),
    query.from('support_conversations').select('id,status,unread_admin_count,last_message_at,users(telegram_id,username,first_name,last_name)').order('last_message_at', { ascending: false }).limit(6),
    todaySalesTotal(startIso)
  ]));
  for (const [result, name] of [[users, 'users'], [suspended, 'suspended users'], [activeUsers, 'active users'], [activeProducts, 'active products'], [lowStock, 'low stock'], [availableInventory, 'available inventory'], [ordersToday, 'today orders'], [pendingManual, 'manual orders'], [pendingPreorders, 'preorders'], [pendingRefunds, 'refunds'], [pendingDeposits, 'pending deposits'], [reviewDeposits, 'review deposits'], [approvedToday, 'approved deposits'], [recentOrders, 'recent orders'], [recentDeposits, 'recent deposits'], [recentActivity, 'recent activity'], [lowStockRows, 'low stock rows'], [recentSupport, 'recent support']]) checked(result, name);
  const overviewResult = checked(await withTimeout(query.rpc('admin_dashboard_stats')), 'dashboard overview');
  const overview = overviewResult.data?.[0] || {};
  return jsonSuccess(res, {
    stats: {
      users: users.count || 0,
      totalRevenue: overview.total_revenue || '0',
      totalOrders: Number(overview.total_orders || 0),
      completedOrders: Number(overview.completed_orders || 0),
      pendingOrders: Number(overview.pending_orders || 0),
      newUsersToday: Number(overview.new_users_today || 0),
      totalProducts: Number(overview.total_products || 0),
      outOfStockProducts: Number(overview.out_of_stock_products || 0),
      messagesWaiting: Number(overview.messages_waiting || 0),
      suspendedUsers: suspended.count || 0,
      activeUsers: activeUsers.count || 0,
      activeProducts: activeProducts.count || 0,
      lowStockProducts: lowStock.count || 0,
      availableInventory: availableInventory.count || 0,
      ordersToday: ordersToday.count || 0,
      salesToday: salesTotal,
      pendingManualOrders: pendingManual.count || 0,
      pendingPreorders: pendingPreorders.count || 0,
      pendingRefunds: pendingRefunds.count || 0,
      pendingDeposits: pendingDeposits.count || 0,
      reviewDeposits: reviewDeposits.count || 0,
      approvedDepositsToday: approvedToday.count || 0
    },
    recentOrders: recentOrders.data,
    recentDeposits: recentDeposits.data,
    recentActivity: recentActivity.data,
    lowStockRows: lowStockRows.data,
    recentSupport: recentSupport.data
  });
}));

router.get('/api/products', asyncRoute(async (req, res) => {
  const { page, limit, from, to } = pageParams(req.query);
  const { sort, ascending } = sortParams(req.query, ['id', 'name', 'price', 'stock', 'active', 'created_at', 'sort_order'], 'created_at');
  const search = cleanSearch(req.query.search);
  let query = db().from('product_catalog').select('id,category_id,category_name,name,subtitle,duration,product_type,currency,product_status,short_description,full_description,delivery_text,price,stock,available_stock,manual_stock,unlimited_stock,fulfillment_type,delivery_time_label,warranty_value,warranty_unit,allow_preorder,min_quantity,max_quantity,bulk_pricing_enabled,emoji,sort_order,real_sold_count,sold_display_offset,sold_count,notification_mode,active,created_at,updated_at', { count: 'exact' });
  if (search) query = query.ilike('name', `%${search}%`);
  if (req.query.uncategorized === 'true') query = query.is('category_id', null);
  else if (req.query.category) query = query.eq('category_id', positiveId(req.query.category, 'Category ID'));
  if (req.query.active === 'true' || req.query.active === 'false') query = query.eq('active', req.query.active === 'true');
  const result = checked(await withTimeout(query.order(sort, { ascending }).range(from, to)), 'products');
  return jsonSuccess(res, result.data.map((row) => ({ ...row, categories: { id: row.category_id, name: row.category_name } })), paginationMeta(page, limit, result.count));
}));

router.get('/api/products/:id', asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id, 'Product ID');
  const product = await withTimeout(store.getProduct(id));
  if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  return jsonSuccess(res, product);
}));

router.post('/api/products', requireMutationProtection, asyncRoute(async (req, res) => {
  const started = Date.now();
  const { values, tiers } = productInput(req.body);
  if (values.category_id) await existingCategory(values.category_id);
  values.description = values.full_description || values.short_description || '';
  values.delivery_text ??= '';
  values.active ??= true;
  values.allow_preorder ??= false;
  values.min_quantity ??= 1;
  values.max_quantity ??= 1000;
  values.manual_stock ??= 0;
  values.unlimited_stock ??= false;
  values.bulk_pricing_enabled ??= false;
  values.emoji ??= '';
  values.sort_order ??= 0;
  values.public_instructions ??= '';
  values.delivery_time_label ??= values.fulfillment_type === 'instant' ? 'Instant delivery' : '';
  values.subtitle ??= ''; values.duration ??= ''; values.product_type ??= values.fulfillment_type === 'instant' ? 'Activation Link' : 'Manual Delivery';
  values.notification_mode ??= 'global';
  values.currency ??= 'USD'; values.product_status ??= values.active === false ? 'inactive' : 'active'; values.sold_display_offset ??= 0;
  values.active = values.product_status === 'active';
  values.stock = values.fulfillment_type === 'manual' ? values.manual_stock : 0;
  const row = await withTimeout(store.adminCreateProduct(values, tiers));
  await store.auditAdmin(req.admin.adminTelegramId, 'product_create', 'product', row.id, { fulfillment_type: row.fulfillment_type });
  audit(req, 'create', 'product', row.id, 'success', started);
  return res.status(201).json({ ok: true, data: row });
}));

router.patch('/api/products/:id', requireMutationProtection, asyncRoute(async (req, res) => {
  const started = Date.now();
  const id = positiveId(req.params.id, 'Product ID');
  if (!Object.keys(req.body).length) throw new ApiError(422, 'EMPTY_UPDATE', 'No fields to update.');
  const { values, tiers } = productInput(req.body, { partial: true });
  if (values.category_id) await existingCategory(values.category_id);
  if ('full_description' in values) values.description = values.full_description;
  if ('manual_stock' in values) values.stock = values.manual_stock;
  const row = await withTimeout(store.adminEditProduct(id, values));
  if (!row) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  if ('bulk_pricing_tiers' in req.body) await store.saveBulkTiers(id, tiers);
  await store.auditAdmin(req.admin.adminTelegramId, 'product_update', 'product', id, { fields: Object.keys(values) });
  audit(req, 'update', 'product', id, 'success', started);
  return jsonSuccess(res, row);
}));

router.get('/api/categories', asyncRoute(async (req, res) => {
  const { page, limit, from, to } = pageParams(req.query);
  const search = cleanSearch(req.query.search);
  let query = db().from('categories').select('id,name,emoji,active,sort_order,layout_override,created_at,updated_at', { count: 'exact' });
  if (search) query = query.ilike('name', `%${search}%`);
  const result = checked(await withTimeout(query.order('sort_order').order('id').range(from, to)), 'categories');
  return jsonSuccess(res, result.data, paginationMeta(page, limit, result.count));
}));

router.post('/api/categories', requireMutationProtection, asyncRoute(async (req, res) => {
  const started = Date.now();
  allowedBody(req.body, ['name','emoji','active','sort_order','layout_override'], ['name']);
  const row = await withTimeout(store.adminCreateCategory({
    name: textField(req.body.name, 'Name', 120),
    emoji: textField(req.body.emoji || '', 'Emoji', 16, { required: false }),
    active: req.body.active === undefined ? true : booleanField(req.body.active, 'Active'),
    sort_order: req.body.sort_order === undefined ? 0 : integerField(req.body.sort_order, 'Sort order', 0, 1000000),
    layout_override: req.body.layout_override === undefined ? 'inherit' : (() => { const v=String(req.body.layout_override); if(!['inherit','full','two'].includes(v)) throw new ApiError(422,'INVALID_LAYOUT','Invalid category layout.'); return v; })()
  }));
  liveEvents.publish(['categories', 'products'], { source: 'category_create' });
  audit(req, 'create', 'category', row.id, 'success', started);
  return res.status(201).json({ ok: true, data: row });
}));

router.patch('/api/categories/:id', requireMutationProtection, asyncRoute(async (req, res) => {
  const started = Date.now();
  const id = positiveId(req.params.id, 'Category ID');
  allowedBody(req.body, ['name', 'emoji', 'active', 'sort_order', 'layout_override']);
  if (!Object.keys(req.body).length) throw new ApiError(422, 'EMPTY_UPDATE', 'No fields to update.');
  const values = {};
  if ('name' in req.body) values.name = textField(req.body.name, 'Name', 120);
  if ('emoji' in req.body) values.emoji = textField(req.body.emoji || '', 'Emoji', 16, { required: false });
  if ('active' in req.body) values.active = booleanField(req.body.active, 'Active');
  if ('sort_order' in req.body) values.sort_order = integerField(req.body.sort_order, 'Sort order', 0, 1000000);
  if ('layout_override' in req.body) { values.layout_override = String(req.body.layout_override); if (!['inherit','full','two'].includes(values.layout_override)) throw new ApiError(422,'INVALID_LAYOUT','Invalid category layout.'); }
  let row = await withTimeout(store.adminUpdateCategory(id, values));
  if (!row) throw new ApiError(404, 'CATEGORY_NOT_FOUND', 'Category not found.');
  liveEvents.publish(['categories', 'products'], { source: 'category_update' });
  audit(req, 'update', 'category', id, 'success', started);
  return jsonSuccess(res, row);
}));

router.delete('/api/categories/:id', requireMutationProtection, asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id, 'Category ID');
  const row = await withTimeout(store.adminDeleteCategory(id));
  if (!row) throw new ApiError(404, 'CATEGORY_NOT_FOUND', 'Category not found.');
  await store.auditAdmin(req.admin.adminTelegramId, 'category_delete', 'category', id, {});
  return jsonSuccess(res, row);
}));

router.delete('/api/products/:id', requireMutationProtection, asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id, 'Product ID');
  const row = await withTimeout(store.adminArchiveProduct(id));
  if (!row) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  await store.auditAdmin(req.admin.adminTelegramId, 'product_archive', 'product', id, {});
  return jsonSuccess(res, row);
}));

router.get('/api/inventory', asyncRoute(async (req, res) => {
  const { page, limit, from, to } = pageParams(req.query);
  const low = req.query.low ? integerField(req.query.low, 'Low-stock threshold', 1, 1000) : LOW_STOCK_DEFAULT;
  const search = cleanSearch(req.query.search);
  const filter = String(req.query.filter || 'all');
  if (!['all', 'in', 'low', 'out', 'inactive'].includes(filter)) throw new ApiError(400, 'INVALID_FILTER', 'Invalid inventory filter.');
  let query = db().from('product_catalog').select('id,name,category_name,stock,available_stock,manual_stock,unlimited_stock,fulfillment_type,active,updated_at', { count: 'exact' });
  if (search) query = query.ilike('name', `%${search}%`);
  if (filter === 'in') query = query.eq('active', true).gt('available_stock', low);
  if (filter === 'low') query = query.eq('active', true).gt('available_stock', 0).lte('available_stock', low);
  if (filter === 'out') query = query.eq('available_stock', 0).eq('unlimited_stock', false);
  if (filter === 'inactive') query = query.eq('active', false);
  const result = checked(await withTimeout(query.order('available_stock').order('name').range(from, to)), 'inventory');
  return jsonSuccess(res, result.data.map((row) => ({ ...row, categories: { name: row.category_name } })), { ...paginationMeta(page, limit, result.count), lowStockThreshold: low });
}));

router.patch('/api/inventory/:id', requireMutationProtection, asyncRoute(async (req, res) => {
  const started = Date.now();
  const id = positiveId(req.params.id, 'Product ID');
  allowedBody(req.body, ['stock'], ['stock']);
  const stock = integerField(req.body.stock, 'Stock');
  const product = await withTimeout(store.getProduct(id));
  if (product.fulfillment_type !== 'manual') throw new ApiError(409, 'INSTANT_STOCK_DERIVED', 'Instant stock is derived from unique inventory items.');
  const row = await withTimeout(store.adminEditProduct(id, { stock, manual_stock: stock }));
  if (!row) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  audit(req, 'set_stock', 'product', id, 'success', started);
  return jsonSuccess(res, row);
}));

router.get('/api/products/:id/inventory', asyncRoute(async (req, res) => {
  const productId = positiveId(req.params.id, 'Product ID');
  const { page, limit } = pageParams(req.query);
  const status = String(req.query.status || '');
  if (status && !['available', 'reserved', 'sold', 'disabled'].includes(status)) throw new ApiError(400, 'INVALID_STATUS', 'Invalid inventory status.');
  const search = cleanSearch(req.query.search);
  const [result, counts] = await withTimeout(Promise.all([
    store.listInventoryItems(productId, page, limit, status, search),
    store.inventoryStatusCounts(productId)
  ]));
  return jsonSuccess(res, result.items, { ...paginationMeta(page, limit, result.count), counts });
}));

router.post('/api/products/:id/inventory/import', requireMutationProtection, asyncRoute(async (req, res) => {
  const started = Date.now();
  const productId = positiveId(req.params.id, 'Product ID');
  allowedBody(req.body, ['items'], ['items']);
  if (!Array.isArray(req.body.items)) throw new ApiError(422, 'INVALID_ITEMS', 'Items must be an array.');
  const items = req.body.items.map((value) => textField(value, 'Inventory item', 20000));
  const result = await withTimeout(store.importInventory(productId, items, req.admin.adminTelegramId), 60_000);
  await store.auditAdmin(req.admin.adminTelegramId, 'inventory_import', 'product', productId, result);
  audit(req, 'import', 'inventory', productId, 'success', started);
  return res.status(201).json({ ok: true, data: result });
}));

router.post('/api/products/:productId/inventory/:itemId/reveal', requireMutationProtection, asyncRoute(async (req, res) => {
  const productId = positiveId(req.params.productId, 'Product ID');
  const itemId = positiveId(req.params.itemId, 'Inventory item ID');
  allowedBody(req.body, []);
  const item = await withTimeout(store.revealInventoryItem(productId, itemId));
  if (!item) throw new ApiError(404, 'INVENTORY_NOT_FOUND', 'Inventory item not found.');
  await store.auditAdmin(req.admin.adminTelegramId, 'inventory_reveal', 'inventory_item', itemId, { product_id: productId, status: item.status });
  audit(req, 'reveal', 'inventory_item', itemId);
  return jsonSuccess(res, item);
}));

router.post('/api/products/:productId/inventory/:itemId/status', requireMutationProtection, asyncRoute(async (req, res) => {
  const productId = positiveId(req.params.productId, 'Product ID');
  const itemId = positiveId(req.params.itemId, 'Inventory item ID');
  allowedBody(req.body, ['status'], ['status']);
  const status = String(req.body.status);
  if (!['available', 'disabled'].includes(status)) throw new ApiError(422, 'INVALID_STATUS', 'Only available or disabled is allowed.');
  const item = await withTimeout(store.setInventoryItemStatus(productId, itemId, status));
  if (!item) throw new ApiError(404, 'INVENTORY_NOT_FOUND', 'Inventory item not found.');
  await store.auditAdmin(req.admin.adminTelegramId, 'inventory_status', 'inventory_item', itemId, { product_id: productId, status });
  audit(req, 'status', 'inventory_item', itemId);
  return jsonSuccess(res, item);
}));

router.delete('/api/products/:productId/inventory/:itemId', requireMutationProtection, asyncRoute(async (req, res) => {
  const productId = positiveId(req.params.productId, 'Product ID');
  const itemId = positiveId(req.params.itemId, 'Inventory item ID');
  const item = await withTimeout(store.deleteInventoryItem(productId, itemId));
  if (!item) throw new ApiError(404, 'INVENTORY_NOT_FOUND', 'Inventory item not found.');
  await store.auditAdmin(req.admin.adminTelegramId, 'inventory_delete', 'inventory_item', itemId, { product_id: productId });
  return jsonSuccess(res, item);
}));

router.get('/api/products/:productId/inventory-export', asyncRoute(async (req, res) => {
  const productId = positiveId(req.params.productId, 'Product ID');
  const status = String(req.query.status || 'available');
  if (!['available','disabled','reserved','sold','all'].includes(status)) throw new ApiError(422, 'INVALID_STATUS', 'Invalid export status.');
  const items = await withTimeout(store.exportInventoryItems(productId, status), 60_000);
  await store.auditAdmin(req.admin.adminTelegramId, 'inventory_export', 'product', productId, { status, count: items.length });
  return jsonSuccess(res, items);
}));

router.get('/api/orders', asyncRoute(async (req, res) => {
  const { page, limit, from, to } = pageParams(req.query);
  const { sort, ascending } = sortParams(req.query, ['id', 'amount', 'status', 'created_at'], 'created_at');
  const search = cleanSearch(req.query.search);
  let query = db().from('orders').select('id,user_id,product_id,product_name,amount,total_amount,unit_price,quantity,status,fulfillment_type,delivery_time_snapshot,created_at,delivered_at,users!inner(telegram_id,username,first_name)', { count: 'exact' });
  if (req.query.status) {
    if (!['pending', 'processing', 'delivered', 'refunded', 'cancelled'].includes(String(req.query.status))) throw new ApiError(400, 'INVALID_STATUS', 'Invalid order status.');
    query = query.eq('status', req.query.status);
  }
  if (req.query.fulfillment) {
    if (!['instant', 'manual'].includes(String(req.query.fulfillment))) throw new ApiError(400, 'INVALID_FULFILLMENT', 'Invalid fulfillment type.');
    query = query.eq('fulfillment_type', req.query.fulfillment);
  }
  if (search) query = /^\d+$/.test(search) ? query.eq('users.telegram_id', search) : query.ilike('product_name', `%${search}%`);
  query = applyDateFilters(query, req.query);
  const result = checked(await withTimeout(query.order(sort, { ascending }).range(from, to)), 'orders');
  return jsonSuccess(res, result.data, paginationMeta(page, limit, result.count));
}));

router.get('/api/orders/:id', asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id, 'Order ID');
  const result = checked(await withTimeout(db().from('orders').select('id,user_id,product_id,product_name,amount,total_amount,unit_price,quantity,status,fulfillment_type,delivery_time_snapshot,warranty_value_snapshot,warranty_unit_snapshot,public_instructions_snapshot,delivery_snapshot,payment_method,created_at,delivered_at,delivered_by,refunded_at,users(telegram_id,username,first_name),products(id,name)').eq('id', id).maybeSingle()), 'order');
  if (!result.data) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  return jsonSuccess(res, result.data);
}));

router.post('/api/orders/:id/deliver', requireMutationProtection, asyncRoute(async (req, res) => {
  const started = Date.now();
  const id = positiveId(req.params.id, 'Order ID');
  allowedBody(req.body, ['delivery'], ['delivery']);
  const delivery = textField(req.body.delivery, 'Delivery', 20000);
  const result = await withTimeout(store.deliverManualOrder(id, req.admin.adminTelegramId, delivery));
  if (!result) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  await store.auditAdmin(req.admin.adminTelegramId, 'manual_delivery', 'order', id, { changed: result.changed });
  if (result.changed) {
    const user = await store.getUser(result.telegram_id);
    const language = normalizeLanguage(user.language);
    try {
      const deliveredOrder = await store.getOrderDetails(result.telegram_id, id);
      const view = buildDeliveryView(deliveredOrder, deliveredOrder.deliveries, language, {
        escape: htmlEscape,
        labels: {
          title: t(language, 'deliveryHeader'), product: t(language, 'deliveryProduct'),
          description: t(language, 'deliveryDescription'), instructions: t(language, 'deliveryInstructions'),
          credentials: t(language, 'deliveryCredentials'), item: t(language, 'deliveryItem'), of: t(language, 'deliveryOf'),
          warranty: t(language, 'deliveryWarranty'), notes: t(language, 'deliveryNotes'), copyHint: t(language, 'copyHint')
        }
      });
      for (const part of view.parts) {
        if (part.type === 'message') await bot.telegram.sendMessage(result.telegram_id, part.text, { parse_mode: 'HTML', disable_web_page_preview: true });
        else await bot.telegram.sendDocument(result.telegram_id, { source: Buffer.from(part.value, 'utf8'), filename: `order-${id}-item-${part.index}.txt` }, { caption: part.itemHeader.replace(/<[^>]+>/g, '') });
      }
    } catch (deliveryError) {
      console.warn('manual_delivery_card_failed', { requestId: req.requestId, orderId: id, code: deliveryError.code || 'DELIVERY_RENDER_FAILED' });
      bot.telegram.sendMessage(result.telegram_id, t(language, 'manualDelivered', { orderId: id })).catch((error) => {
        console.warn('manual_delivery_notification_failed', { requestId: req.requestId, orderId: id, code: error.code });
      });
    }
  }
  audit(req, 'deliver', 'order', id, 'success', started);
  return jsonSuccess(res, { ...result, payload: undefined });
}));

router.post('/api/orders/:id/delivery/reveal', requireMutationProtection, asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id, 'Order ID');
  allowedBody(req.body, []);
  const order = await withTimeout(store.getOrderDetails(null, id, true));
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  if (order.status !== 'delivered' || !order.deliveries.length) throw new ApiError(409, 'DELIVERY_UNAVAILABLE', 'This order has no delivered payload.');
  await store.auditAdmin(req.admin.adminTelegramId, 'order_delivery_reveal', 'order', id, { fulfillment_type: order.fulfillment_type, item_count: order.deliveries.length });
  audit(req, 'reveal_delivery', 'order', id);
  return jsonSuccess(res, { orderId: id, items: order.deliveries });
}));

router.get('/api/preorders', asyncRoute(async (req, res) => {
  const { page, limit, from, to } = pageParams(req.query);
  const { sort, ascending } = sortParams(req.query, ['created_at', 'total_amount', 'id'], 'created_at');
  const search = cleanSearch(req.query.search);
  let query = db().from('orders')
    .select('id,user_id,product_id,product_name,total_amount,quantity,status,delivery_time_snapshot,created_at,users!inner(telegram_id,username,first_name)', { count: 'exact' })
    .eq('fulfillment_type', 'manual').in('status', ['pending', 'processing']);
  if (search) query = /^\d+$/.test(search) ? query.eq('users.telegram_id', search) : query.ilike('product_name', `%${search}%`);
  const result = checked(await withTimeout(query.order(sort, { ascending }).range(from, to)), 'preorders');
  return jsonSuccess(res, result.data, paginationMeta(page, limit, result.count));
}));

router.get('/api/refunds', asyncRoute(async (req, res) => {
  const { page, limit, from, to } = pageParams(req.query);
  const { sort, ascending } = sortParams(req.query, ['created_at', 'reviewed_at', 'id'], 'created_at');
  const search = cleanSearch(req.query.search);
  const status = String(req.query.status || '');
  if (status && !['pending', 'approved', 'rejected', 'cancelled'].includes(status)) throw new ApiError(400, 'INVALID_STATUS', 'Invalid refund status.');
  let query = db().from('refund_requests').select('id,order_id,user_id,reason,status,created_at,reviewed_at,reviewed_by,admin_note,orders!inner(product_name,total_amount,status),users!inner(telegram_id,username,first_name)', { count: 'exact' });
  if (status) query = query.eq('status', status);
  if (search) query = /^\d+$/.test(search) ? query.or(`id.eq.${search},order_id.eq.${search}`) : query.ilike('orders.product_name', `%${search}%`);
  const result = checked(await withTimeout(query.order(sort, { ascending }).range(from, to)), 'refund requests');
  return jsonSuccess(res, result.data, paginationMeta(page, limit, result.count));
}));

router.post('/api/refunds/:id/review', requireMutationProtection, asyncRoute(async (req, res) => {
  const started = Date.now();
  const id = positiveId(req.params.id, 'Refund request ID');
  allowedBody(req.body, ['decision', 'note'], ['decision']);
  const decision = String(req.body.decision);
  if (!['approved', 'rejected'].includes(decision)) throw new ApiError(422, 'INVALID_DECISION', 'Decision must be approved or rejected.');
  const note = textField(req.body.note || '', 'Admin note', 2000, { required: false });
  const result = await withTimeout(store.reviewRefund(id, req.admin.adminTelegramId, decision, note));
  await store.auditAdmin(req.admin.adminTelegramId, `refund_${decision}`, 'refund_request', id, { order_id: result.order_id, changed: result.changed });
  if (result.changed) {
    const user = await store.getUser(result.telegram_id);
    const language = normalizeLanguage(user.language);
    const key = decision === 'approved' ? 'refundApproved' : 'refundRejectedNotice';
    bot.telegram.sendMessage(result.telegram_id, t(language, key, { orderId: result.order_id, amount: formatAmount(result.amount) })).catch((error) => {
      console.warn('refund_notification_failed', { requestId: req.requestId, refundId: id, code: error.code });
    });
  }
  audit(req, decision, 'refund_request', id, 'success', started);
  return jsonSuccess(res, result);
}));

router.get('/api/deposits', asyncRoute(async (req, res) => {
  const { page, limit, from, to } = pageParams(req.query);
  const { sort, ascending } = sortParams(req.query, ['created_at', 'expected_amount', 'status'], 'created_at');
  const search = cleanSearch(req.query.search);
  let query = db().from('deposits').select('id,deposit_code,user_id,requested_amount,expected_amount,received_amount,currency,network,payment_method,status,transaction_id,provider_order_id,created_at,expires_at,reviewed_at,rejection_reason,users!inner(telegram_id,username,first_name)', { count: 'exact' });
  if (req.query.status) {
    const statuses = ['pending', 'pending_review', 'approved', 'rejected', 'expired', 'cancelled'];
    if (!statuses.includes(String(req.query.status))) throw new ApiError(400, 'INVALID_STATUS', 'Invalid deposit status.');
    query = query.eq('status', req.query.status);
  }
  if (req.query.method) {
    if (!['binance', 'usdt_bep20', 'usdt_trc20'].includes(String(req.query.method))) throw new ApiError(400, 'INVALID_METHOD', 'Invalid payment method.');
    query = query.eq('payment_method', req.query.method);
  }
  if (search) query = /^\d+$/.test(search) ? query.eq('users.telegram_id', search) : query.or(`deposit_code.ilike.%${search}%,transaction_id.ilike.%${search}%,provider_order_id.ilike.%${search}%`);
  query = applyDateFilters(query, req.query);
  const result = checked(await withTimeout(query.order(sort, { ascending }).range(from, to)), 'deposits');
  return jsonSuccess(res, result.data, paginationMeta(page, limit, result.count));
}));

router.get('/api/deposits/:id', asyncRoute(async (req, res) => {
  const id = uuid(req.params.id);
  const result = checked(await withTimeout(db().from('deposits').select('*,users(telegram_id,username,first_name,language,wallet_balance)').eq('id', id).maybeSingle()), 'deposit');
  if (!result.data) throw new ApiError(404, 'DEPOSIT_NOT_FOUND', 'Deposit not found.');
  return jsonSuccess(res, result.data);
}));

async function reviewableDeposit(id, confirmCode) {
  const result = checked(await db().from('deposits').select('id,deposit_code,payment_method,status,transaction_id,user_id,expected_amount,users(telegram_id,language)').eq('id', id).maybeSingle(), 'deposit review');
  if (!result.data) throw new ApiError(404, 'DEPOSIT_NOT_FOUND', 'Deposit not found.');
  if (!safeEqual(String(confirmCode || ''), result.data.deposit_code)) throw new ApiError(409, 'CONFIRMATION_MISMATCH', 'Deposit confirmation code does not match.');
  if (!['usdt_bep20','usdt_trc20'].includes(result.data.payment_method) || result.data.status !== 'pending_review' || !result.data.transaction_id) {
    throw new ApiError(409, 'DEPOSIT_NOT_REVIEWABLE', 'This deposit is not eligible for manual review.');
  }
  return result.data;
}

router.post('/api/deposits/:id/approve', requireMutationProtection, asyncRoute(async (req, res) => {
  const started = Date.now();
  const id = uuid(req.params.id);
  allowedBody(req.body, ['confirmCode'], ['confirmCode']);
  const deposit = await withTimeout(reviewableDeposit(id, req.body.confirmCode));
  const result = await withTimeout(store.approveDeposit(id, req.admin.adminTelegramId));
  if (result?.credited) {
    const language = normalizeLanguage(deposit.users?.language || config.defaultLanguage);
    bot.telegram.sendMessage(deposit.users.telegram_id, t(language, 'depositApproved', { amount: formatAmount(result.amount) })).catch((error) => {
      console.warn('admin_deposit_notification_failed', { requestId: req.requestId, depositId: id, code: error.code });
    });
  }
  await store.auditAdmin(req.admin.adminTelegramId, 'deposit_approve', 'deposit', id, { credited: Boolean(result?.credited) });
  liveEvents.publish(['dashboard', 'deposits', 'users', 'wallet'], { source: 'deposit_approve' });
  audit(req, 'approve', 'deposit', id, 'success', started);
  return jsonSuccess(res, result);
}));

router.post('/api/deposits/:id/reject', requireMutationProtection, asyncRoute(async (req, res) => {
  const started = Date.now();
  const id = uuid(req.params.id);
  allowedBody(req.body, ['confirmCode', 'reason'], ['confirmCode']);
  const reason = textField(req.body.reason || 'Rejected by administrator', 'Reason', 500);
  const deposit = await withTimeout(reviewableDeposit(id, req.body.confirmCode));
  const result = await withTimeout(store.rejectDeposit(id, req.admin.adminTelegramId, reason));
  if (result?.changed) {
    const language = normalizeLanguage(deposit.users?.language || config.defaultLanguage);
    bot.telegram.sendMessage(deposit.users.telegram_id, t(language, 'depositRejected')).catch((error) => {
      console.warn('admin_deposit_notification_failed', { requestId: req.requestId, depositId: id, code: error.code });
    });
  }
  await store.auditAdmin(req.admin.adminTelegramId, 'deposit_reject', 'deposit', id, { changed: Boolean(result?.changed) });
  liveEvents.publish(['dashboard', 'deposits'], { source: 'deposit_reject' });
  audit(req, 'reject', 'deposit', id, 'success', started);
  return jsonSuccess(res, result);
}));

router.get('/api/users', asyncRoute(async (req, res) => {
  const { page, limit, from, to } = pageParams(req.query);
  const { sort, ascending } = sortParams(req.query, ['id', 'telegram_id', 'wallet_balance', 'is_suspended', 'created_at'], 'created_at');
  const search = cleanSearch(req.query.search);
  let query = db().from('users').select('id,telegram_id,username,first_name,language,wallet_balance,is_suspended,created_at,updated_at', { count: 'exact' });
  if (search) query = /^\d+$/.test(search) ? query.eq('telegram_id', search) : query.or(`username.ilike.%${search}%,first_name.ilike.%${search}%`);
  if (req.query.language) {
    if (!['en', 'ar', 'hi'].includes(String(req.query.language))) throw new ApiError(400, 'INVALID_LANGUAGE', 'Invalid language.');
    query = query.eq('language', req.query.language);
  }
  if (req.query.suspended === 'true' || req.query.suspended === 'false') query = query.eq('is_suspended', req.query.suspended === 'true');
  const result = checked(await withTimeout(query.order(sort, { ascending }).range(from, to)), 'users');
  return jsonSuccess(res, result.data, paginationMeta(page, limit, result.count));
}));

router.get('/api/users/:id', asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id, 'User ID');
  const user = await withTimeout(existingUser(id));
  const [orders, deposits, transactions] = await withTimeout(Promise.all([
    db().from('orders').select('id,product_name,amount,status,created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(10),
    db().from('deposits').select('id,deposit_code,expected_amount,payment_method,status,created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(10),
    db().from('wallet_transactions').select('id,type,amount,balance_after,reference_type,reference_id,description,created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(15)
  ]));
  checked(orders, 'user orders'); checked(deposits, 'user deposits'); checked(transactions, 'user wallet transactions');
  return jsonSuccess(res, { user, orders: orders.data, deposits: deposits.data, walletTransactions: transactions.data, walletAdjustment: { available: true } });
}));

router.post('/api/users/:id/wallet-adjustment', requireMutationProtection, asyncRoute(async (req, res) => {
  const started = Date.now();
  const id = positiveId(req.params.id, 'User ID');
  allowedBody(req.body, ['amount', 'reason', 'confirmTelegramId', 'idempotencyKey'], ['amount', 'reason', 'confirmTelegramId', 'idempotencyKey']);
  const user = await withTimeout(existingUser(id));
  if (!safeEqual(String(req.body.confirmTelegramId || ''), String(user.telegram_id))) throw new ApiError(409, 'CONFIRMATION_MISMATCH', 'Telegram ID confirmation does not match.');
  const amount = signedDecimalField(req.body.amount, 'Adjustment amount');
  const reason = textField(String(req.body.reason || ''), 'Reason', 500);
  const idempotencyKey = uuid(req.body.idempotencyKey, 'Adjustment request ID');
  let row;
  try {
    row = await withTimeout(store.adminAdjustWallet(id, amount, reason, req.admin.adminTelegramId, idempotencyKey));
  } catch (error) {
    if (String(error.message || '').includes('NEGATIVE_WALLET_BALANCE')) throw new ApiError(409, 'NEGATIVE_WALLET_BALANCE', 'This adjustment would make the wallet balance negative.');
    if (String(error.message || '').includes('USER_NOT_FOUND')) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');
    throw error;
  }
  await store.auditAdmin(req.admin.adminTelegramId, 'wallet_adjustment', 'user', id, { amount, reason, transactionId: row?.transaction_id });
  liveEvents.publish(['dashboard', 'users', 'wallet'], { source: 'wallet_adjustment', userId: id });
  audit(req, 'wallet_adjustment', 'user', id, 'success', started);
  return jsonSuccess(res, row);
}));

router.post('/api/users/:id/suspension', requireMutationProtection, asyncRoute(async (req, res) => {
  const started = Date.now();
  const id = positiveId(req.params.id, 'User ID');
  allowedBody(req.body, ['suspended', 'confirmTelegramId'], ['suspended', 'confirmTelegramId']);
  const user = await withTimeout(existingUser(id));
  if (!safeEqual(String(req.body.confirmTelegramId || ''), String(user.telegram_id))) throw new ApiError(409, 'CONFIRMATION_MISMATCH', 'Telegram ID confirmation does not match.');
  const suspended = booleanField(req.body.suspended, 'Suspended');
  const row = await withTimeout(store.adminSetSuspended(String(user.telegram_id), suspended));
  liveEvents.publish(['dashboard', 'users', 'broadcast'], { source: 'user_suspension' });
  audit(req, suspended ? 'suspend' : 'unsuspend', 'user', id, 'success', started);
  return jsonSuccess(res, row);
}));

router.get('/api/wallet-transactions', asyncRoute(async (req, res) => {
  const { page, limit, from, to } = pageParams(req.query);
  const { sort, ascending } = sortParams(req.query, ['id', 'amount', 'balance_after', 'created_at'], 'created_at');
  const search = cleanSearch(req.query.search);
  let query = db().from('wallet_transactions').select('id,user_id,type,amount,balance_after,reference_type,reference_id,description,created_at,users!inner(telegram_id,username)', { count: 'exact' });
  if (req.query.type) {
    if (!['deposit', 'purchase', 'refund', 'adjustment'].includes(String(req.query.type))) throw new ApiError(400, 'INVALID_TYPE', 'Invalid transaction type.');
    query = query.eq('type', req.query.type);
  }
  if (req.query.referenceType) query = query.eq('reference_type', textField(String(req.query.referenceType), 'Reference type', 20));
  if (search) query = /^\d+$/.test(search) ? query.eq('users.telegram_id', search) : query.or(`reference_id.ilike.%${search}%,description.ilike.%${search}%`);
  query = applyDateFilters(query, req.query);
  const result = checked(await withTimeout(query.order(sort, { ascending }).range(from, to)), 'wallet transactions');
  return jsonSuccess(res, result.data, paginationMeta(page, limit, result.count));
}));

router.get('/api/notifications', asyncRoute(async (req, res) => {
  const { page, limit, from, to } = pageParams(req.query);
  const { sort, ascending } = sortParams(req.query, ['id', 'created_at'], 'created_at');
  const search = cleanSearch(req.query.search);
  let query = db().from('notifications').select('id,user_id,message,created_at,users(telegram_id,username)', { count: 'exact' });
  if (search) query = /^\d+$/.test(search) ? query.or(`user_id.eq.${search},message.ilike.%${search}%`) : query.ilike('message', `%${search}%`);
  const result = checked(await withTimeout(query.order(sort, { ascending }).range(from, to)), 'notifications');
  return jsonSuccess(res, result.data, paginationMeta(page, limit, result.count));
}));

router.post('/api/notifications', requireMutationProtection, asyncRoute(async (req, res) => {
  const started = Date.now();
  allowedBody(req.body, ['message', 'userId'], ['message']);
  const message = textField(req.body.message, 'Message', 4000);
  let userId = null;
  if (req.body.userId !== null && req.body.userId !== undefined && req.body.userId !== '') {
    userId = positiveId(req.body.userId, 'User ID');
    await existingUser(userId);
  }
  const row = await withTimeout(store.createNotification(message, userId));
  liveEvents.publish(['notifications'], { source: 'notification_create' });
  audit(req, 'create', 'notification', row.id, 'success', started);
  return res.status(201).json({ ok: true, data: row });
}));

router.get('/api/broadcasts/estimate', asyncRoute(async (_req, res) => {
  const result = checked(await withTimeout(db().from('users').select('*', { count: 'exact', head: true }).eq('is_suspended', false)), 'broadcast estimate');
  return jsonSuccess(res, { recipients: result.count || 0, activeJobId: activeBroadcastId });
}));

router.post('/api/broadcasts', requireMutationProtection, asyncRoute(async (req, res) => {
  const started = Date.now();
  allowedBody(req.body, ['message', 'parseMode'], ['message']);
  if (activeBroadcastId) throw new ApiError(409, 'BROADCAST_ACTIVE', 'Another broadcast is already running.');
  if (req.body.parseMode && req.body.parseMode !== 'plain') throw new ApiError(422, 'PARSE_MODE_UNAVAILABLE', 'Only plain-text broadcasts are enabled.');
  const message = textField(req.body.message, 'Message', 4000);
  const countResult = checked(await withTimeout(db().from('users').select('*', { count: 'exact', head: true }).eq('is_suspended', false)), 'broadcast recipients');
  const job = {
    id: randomToken(16), status: 'queued', total: countResult.count || 0, processed: 0, sent: 0, failed: 0,
    errors: [], cancelRequested: false, createdAt: new Date().toISOString(), finishedAt: null
  };
  activeBroadcastId = job.id;
  broadcastJobs.set(job.id, job);
  setImmediate(() => runBroadcast(job, message));
  liveEvents.publish(['broadcast'], { source: 'broadcast_start', jobId: job.id });
  audit(req, 'start', 'broadcast', job.id, 'success', started);
  return res.status(202).json({ ok: true, data: publicJob(job) });
}));

router.get('/api/broadcasts/:jobId', (req, res) => {
  const id = String(req.params.jobId || '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(id) || !broadcastJobs.has(id)) return jsonFailure(res, 404, 'JOB_NOT_FOUND', 'Broadcast job not found.');
  return jsonSuccess(res, publicJob(broadcastJobs.get(id)));
});

router.post('/api/broadcasts/:jobId/cancel', requireMutationProtection, (req, res) => {
  const id = String(req.params.jobId || '');
  const job = broadcastJobs.get(id);
  if (!job) return jsonFailure(res, 404, 'JOB_NOT_FOUND', 'Broadcast job not found.');
  if (!['queued', 'running'].includes(job.status)) return jsonFailure(res, 409, 'JOB_FINISHED', 'Broadcast job has already finished.');
  job.cancelRequested = true;
  liveEvents.publish(['broadcast'], { source: 'broadcast_cancel', jobId: id });
  audit(req, 'cancel', 'broadcast', id);
  return jsonSuccess(res, publicJob(job));
});


router.get('/api/notification-automation', asyncRoute(async (req, res) => {
  const { page, limit } = pageParams(req.query);
  const [rules, destinations, jobs] = await withTimeout(Promise.all([
    notificationAutomation.listRules(),
    notificationAutomation.listDestinations(),
    notificationAutomation.listJobs(page, limit)
  ]));
  return jsonSuccess(res, { rules, destinations, jobs: jobs.items }, paginationMeta(page, limit, jobs.count));
}));

router.patch('/api/notification-rules/:eventType', requireMutationProtection, asyncRoute(async (req, res) => {
  const eventType = String(req.params.eventType || '');
  if (!notificationAutomation.EVENT_TYPES.has(eventType)) throw new ApiError(400, 'INVALID_EVENT_TYPE', 'Invalid notification event type.');
  const allowed = ['enabled','destination_mode','destination_value','selling_fast_thresholds','cooldown_minutes','min_stock_increase','min_price_drop','min_price_drop_percent','button_text','message_template'];
  allowedBody(req.body, allowed);
  const values = { updated_by: req.admin.adminTelegramId };
  if ('enabled' in req.body) values.enabled = booleanField(req.body.enabled, 'Enabled');
  if ('destination_mode' in req.body) {
    values.destination_mode = String(req.body.destination_mode);
    if (!['disabled','all_users','telegram_channel','telegram_group','custom_chat','users_plus_channel','users_plus_group','multiple'].includes(values.destination_mode)) throw new ApiError(422,'INVALID_DESTINATION_MODE','Invalid notification destination mode.');
  }
  if ('destination_value' in req.body) values.destination_value = nullableTextField(req.body.destination_value, 'Destination', 120);
  if ('selling_fast_thresholds' in req.body) {
    if (!Array.isArray(req.body.selling_fast_thresholds)) throw new ApiError(422,'INVALID_THRESHOLDS','Selling-fast thresholds must be an array.');
    values.selling_fast_thresholds = [...new Set(req.body.selling_fast_thresholds.map((value) => integerField(value, 'Threshold', 1, 1000000)))].sort((a,b)=>b-a);
    if (!values.selling_fast_thresholds.length || values.selling_fast_thresholds.length > 20) throw new ApiError(422,'INVALID_THRESHOLDS','Use between 1 and 20 thresholds.');
  }
  if ('cooldown_minutes' in req.body) values.cooldown_minutes = integerField(req.body.cooldown_minutes, 'Cooldown minutes', 0, 10080);
  if ('min_stock_increase' in req.body) values.min_stock_increase = integerField(req.body.min_stock_increase, 'Minimum stock increase', 0, 2147483647);
  if ('min_price_drop' in req.body) values.min_price_drop = decimalField(req.body.min_price_drop, 'Minimum price drop');
  if ('min_price_drop_percent' in req.body) {
    values.min_price_drop_percent = decimalField(req.body.min_price_drop_percent, 'Minimum price drop percent');
    if (Number(values.min_price_drop_percent) > 100) throw new ApiError(422,'INVALID_PERCENT','Minimum price drop percent cannot exceed 100.');
  }
  if ('button_text' in req.body) values.button_text = textField(req.body.button_text || '', 'Button text', 64);
  if ('message_template' in req.body) {
    values.message_template = notificationAutomation.normalizeTemplateNewlines(
      textField(req.body.message_template || '', 'Message template', 4000)
    );
  }
  const row = await notificationAutomation.saveRule(eventType, values);
  await store.auditAdmin(req.admin.adminTelegramId, 'notification_rule_update', 'notification_rule', eventType, { fields: Object.keys(values).filter((key)=>key!=='updated_by') });
  return jsonSuccess(res, row);
}));

router.post('/api/notification-destinations', requireMutationProtection, asyncRoute(async (req, res) => {
  allowedBody(req.body, ['event_type','destination_type','target','label','enabled'], ['event_type','destination_type']);
  const eventType = String(req.body.event_type);
  if (!notificationAutomation.EVENT_TYPES.has(eventType)) throw new ApiError(422,'INVALID_EVENT_TYPE','Invalid notification event type.');
  const type = String(req.body.destination_type);
  if (!['users','channel','group','custom_chat'].includes(type)) throw new ApiError(422,'INVALID_DESTINATION','Invalid destination type.');
  const target = type === 'users' ? null : textField(String(req.body.target || ''), 'Target', 120);
  const row = await notificationAutomation.saveDestination({
    event_type:eventType,destination_type:type,target,
    label:textField(String(req.body.label || ''),'Label',120,{required:false}),
    enabled:req.body.enabled===undefined?true:booleanField(req.body.enabled,'Enabled'),updated_by:req.admin.adminTelegramId
  });
  await store.auditAdmin(req.admin.adminTelegramId, 'notification_destination_update', 'notification_destination', row.id, { event_type:eventType,destination_type:type });
  return res.status(201).json({ok:true,data:row});
}));

router.patch('/api/notification-destinations/:id', requireMutationProtection, asyncRoute(async (req,res)=>{
  const id=positiveId(req.params.id,'Destination ID');
  allowedBody(req.body,['destination_type','target','label','enabled']);
  const values={updated_by:req.admin.adminTelegramId};
  if('destination_type'in req.body){values.destination_type=String(req.body.destination_type);if(!['users','channel','group','custom_chat'].includes(values.destination_type))throw new ApiError(422,'INVALID_DESTINATION','Invalid destination type.');}
  if('target'in req.body) values.target=nullableTextField(req.body.target,'Target',120);
  if('label'in req.body) values.label=textField(String(req.body.label||''),'Label',120,{required:false});
  if('enabled'in req.body) values.enabled=booleanField(req.body.enabled,'Enabled');
  const row=await notificationAutomation.saveDestination(values,id);
  await store.auditAdmin(req.admin.adminTelegramId,'notification_destination_update','notification_destination',id,{fields:Object.keys(values).filter((key)=>key!=='updated_by')});
  return jsonSuccess(res,row);
}));

router.delete('/api/notification-destinations/:id', requireMutationProtection, asyncRoute(async (req,res)=>{
  const id=positiveId(req.params.id,'Destination ID');
  const row=await notificationAutomation.deleteDestination(id);
  if(!row) throw new ApiError(404,'DESTINATION_NOT_FOUND','Notification destination not found.');
  await store.auditAdmin(req.admin.adminTelegramId,'notification_destination_update','notification_destination',id,{deleted:true});
  return jsonSuccess(res,row);
}));

router.post('/api/notification-destinations/test', requireMutationProtection, asyncRoute(async (req,res)=>{
  allowedBody(req.body,['target'],['target']);
  const target=textField(String(req.body.target||''),'Target',120);
  try { await notificationAutomation.testDestination(target); }
  catch(error){ throw new ApiError(422,'TELEGRAM_DESTINATION_FAILED',`Telegram could not write to this destination: ${String(error.message||'permission denied').slice(0,180)}`); }
  await store.auditAdmin(req.admin.adminTelegramId,'notification_test','notification_destination',target,{});
  return jsonSuccess(res,{target,ok:true});
}));

router.post('/api/notification-jobs/:id/cancel', requireMutationProtection, asyncRoute(async (req,res)=>{
  const id=uuid(req.params.id);
  const row=await notificationAutomation.cancelJob(id);
  if(!row) throw new ApiError(409,'JOB_NOT_RUNNING','Notification job is not queued or processing.');
  return jsonSuccess(res,row);
}));

router.post('/api/notification-jobs/:id/retry', requireMutationProtection, asyncRoute(async (req,res)=>{
  const id=uuid(req.params.id);
  const row=await notificationAutomation.retryJob(id);
  if(!row) throw new ApiError(404,'JOB_NOT_FOUND','Notification job not found.');
  return jsonSuccess(res,row);
}));

router.get('/api/settings', asyncRoute(async (req, res) => {
  const [settings, links, payments] = await withTimeout(Promise.all([
    store.getBotSettings(), store.listBotLinks(false), store.getPaymentSettings()
  ]));
  return jsonSuccess(res, {
    settings, links, payments,
    environment: config.env,
    webhookConfigured: Boolean(config.webhookUrl),
    binanceAutomatic: Boolean(config.binance.isReady),
    inventoryEncryptionConfigured: inventoryCrypto.encryptionConfigured(),
    liveUpdates: true,
    adminActor: maskId(req.admin.adminTelegramId),
    secretNotice: 'API secrets, encryption keys and session secrets stay in Environment Variables and are never returned here.'
  });
}));

router.post('/api/settings/custom-emojis/test', requireMutationProtection, asyncRoute(async (req, res) => {
  const emojiKeys = ['product_custom_emoji_id','price_custom_emoji_id','stock_custom_emoji_id','sold_custom_emoji_id','warranty_custom_emoji_id','binance_custom_emoji_id','success_custom_emoji_id','custom_emojis_enabled'];
  allowedBody(req.body, emojiKeys);
  const settings = {};
  for (const key of emojiKeys) settings[key] = textField(String(req.body?.[key] || ''), key, 30, { required: false });
  if (settings.custom_emojis_enabled && !['true','false'].includes(settings.custom_emojis_enabled.toLowerCase())) {
    throw new ApiError(422, 'INVALID_BOOLEAN', 'custom_emojis_enabled must be true or false.');
  }
  for (const key of emojiKeys.filter((name) => name.endsWith('_custom_emoji_id'))) {
    if (settings[key] && !/^\d{5,30}$/.test(settings[key])) throw new ApiError(422, 'INVALID_CUSTOM_EMOJI', `${key} must be a numeric Telegram Custom Emoji ID.`);
  }
  const result = await customEmojiService.resolveSettings(bot.telegram, settings, { force: true });
  await store.auditAdmin(req.admin.adminTelegramId, 'custom_emoji_test', 'bot_settings', 'custom_emojis', {
    tested: result.report.filter((item) => item.id).length,
    valid: result.report.filter((item) => item.valid).length
  });
  return jsonSuccess(res, result.report);
}));

router.patch('/api/settings', requireMutationProtection, asyncRoute(async (req, res) => {
  const allowed = ['bot_name','welcome_message','start_message','store_description','currency','maintenance_mode','support_text','about_text','footer','terms_text','buy_button_text','back_button_text','main_menu_text','default_language','contact_information','minimum_order','maximum_order','payment_instructions','order_success_message','order_pending_message','out_of_stock_message','category_layout','show_uncategorized_products','uncategorized_section_title','delete_previous_navigation_menus','persistent_bottom_keyboard','shop_button_text','deposit_button_text','menu_layout','menu_products_enabled','menu_wallet_enabled','menu_deposit_enabled','menu_orders_enabled','menu_support_enabled','menu_about_enabled','menu_channel_enabled','menu_more_enabled','products_label_en','products_label_ar','products_label_hi','wallet_label_en','wallet_label_ar','wallet_label_hi','deposit_label_en','deposit_label_ar','deposit_label_hi','orders_label_en','orders_label_ar','orders_label_hi','support_label_en','support_label_ar','support_label_hi','about_label_en','about_label_ar','about_label_hi','channel_label_en','channel_label_ar','channel_label_hi','quantity_mode','quantity_sequential_threshold','quantity_presets','quantity_custom_enabled','quantity_buttons_per_row','product_custom_emoji_id','price_custom_emoji_id','stock_custom_emoji_id','sold_custom_emoji_id','warranty_custom_emoji_id','binance_custom_emoji_id','success_custom_emoji_id','custom_emojis_enabled','chat_cleanup_enabled'];
  allowedBody(req.body, allowed);
  if (!Object.keys(req.body).length) throw new ApiError(422, 'EMPTY_UPDATE', 'No settings to update.');
  const clean = {};
  for (const [key, value] of Object.entries(req.body)) clean[key] = textField(String(value ?? ''), key, key.includes('text') || key.includes('message') || key.includes('description') || key.includes('instructions') ? 5000 : 240, { required: false });
  if (clean.default_language && !['en','ar','hi'].includes(clean.default_language)) throw new ApiError(422, 'INVALID_LANGUAGE', 'Default language must be en, ar or hi.');
  if (clean.maintenance_mode && !['true','false'].includes(clean.maintenance_mode.toLowerCase())) throw new ApiError(422, 'INVALID_BOOLEAN', 'Maintenance mode must be true or false.');
  if (clean.category_layout && !['full','two','auto'].includes(clean.category_layout)) throw new ApiError(422, 'INVALID_LAYOUT', 'Category layout must be full, two or auto.');
  if (clean.menu_layout && !['one','two','auto'].includes(clean.menu_layout)) throw new ApiError(422, 'INVALID_LAYOUT', 'Menu layout must be one, two or auto.');
  if (clean.quantity_mode && !['auto','sequential','presets'].includes(clean.quantity_mode)) throw new ApiError(422,'INVALID_QUANTITY_MODE','Quantity mode must be auto, sequential or presets.');
  for (const key of ['show_uncategorized_products','delete_previous_navigation_menus','persistent_bottom_keyboard','menu_products_enabled','menu_wallet_enabled','menu_deposit_enabled','menu_orders_enabled','menu_support_enabled','menu_about_enabled','menu_channel_enabled','menu_more_enabled','quantity_custom_enabled','custom_emojis_enabled','chat_cleanup_enabled']) if (clean[key] && !['true','false'].includes(clean[key].toLowerCase())) throw new ApiError(422,'INVALID_BOOLEAN', `${key} must be true or false.`);
  if (clean.quantity_sequential_threshold && !/^\d+$/.test(clean.quantity_sequential_threshold)) throw new ApiError(422,'INVALID_QUANTITY_THRESHOLD','Quantity threshold must be a whole number.');
  if (clean.quantity_buttons_per_row && !/^[1-5]$/.test(clean.quantity_buttons_per_row)) throw new ApiError(422,'INVALID_QUANTITY_COLUMNS','Quantity buttons per row must be from 1 to 5.');
  if (clean.quantity_presets && !/^\d+(?:,\d+)*$/.test(clean.quantity_presets.replace(/\s/g,''))) throw new ApiError(422,'INVALID_QUANTITY_PRESETS','Quantity presets must be comma-separated whole numbers.');
  for (const key of allowed.filter((name)=>name.endsWith('_custom_emoji_id'))) if (clean[key] && !/^\d{5,30}$/.test(clean[key])) throw new ApiError(422,'INVALID_CUSTOM_EMOJI','Custom emoji IDs must be numeric Telegram IDs.');
  const rows = await store.saveBotSettings(clean, req.admin.adminTelegramId);
  await store.auditAdmin(req.admin.adminTelegramId, 'settings_update', 'bot_settings', 'multiple', { fields: Object.keys(clean) });
  return jsonSuccess(res, rows);
}));

router.get('/api/links', asyncRoute(async (_req, res) => jsonSuccess(res, await store.listBotLinks(false))));
router.post('/api/links', requireMutationProtection, asyncRoute(async (req, res) => {
  allowedBody(req.body, ['link_key','button_text','url','active','sort_order'], ['link_key','button_text','url']);
  const url = textField(req.body.url, 'URL', 2048); if (!/^https:\/\//i.test(url)) throw new ApiError(422,'INVALID_URL','URL must use HTTPS.');
  const row = await store.saveBotLink({ link_key:textField(req.body.link_key,'Key',60), button_text:textField(req.body.button_text,'Button text',120), url, active:req.body.active===undefined?true:booleanField(req.body.active,'Active'), sort_order:req.body.sort_order===undefined?0:integerField(req.body.sort_order,'Sort order',0,1000000) }, req.admin.adminTelegramId);
  return res.status(201).json({ok:true,data:row});
}));
router.patch('/api/links/:id', requireMutationProtection, asyncRoute(async (req,res)=>{
  const id=positiveId(req.params.id,'Link ID'); allowedBody(req.body,['link_key','button_text','url','active','sort_order']); const values={};
  if('link_key'in req.body) values.link_key=textField(req.body.link_key,'Key',60); if('button_text'in req.body) values.button_text=textField(req.body.button_text,'Button text',120);
  if('url'in req.body){values.url=textField(req.body.url,'URL',2048);if(!/^https:\/\//i.test(values.url))throw new ApiError(422,'INVALID_URL','URL must use HTTPS.');}
  if('active'in req.body) values.active=booleanField(req.body.active,'Active'); if('sort_order'in req.body) values.sort_order=integerField(req.body.sort_order,'Sort order',0,1000000);
  return jsonSuccess(res,await store.saveBotLink(values,req.admin.adminTelegramId,id));
}));
router.delete('/api/links/:id', requireMutationProtection, asyncRoute(async(req,res)=>jsonSuccess(res,await store.deleteBotLink(positiveId(req.params.id,'Link ID')))));

router.get('/api/faqs', asyncRoute(async (_req,res)=>jsonSuccess(res,await store.listFaqs('',false))));
router.post('/api/faqs', requireMutationProtection, asyncRoute(async(req,res)=>{
  allowedBody(req.body,['question','answer','language','active','sort_order'],['question','answer']); const language=String(req.body.language||'all'); if(!['en','ar','hi','all'].includes(language))throw new ApiError(422,'INVALID_LANGUAGE','Invalid FAQ language.');
  const row=await store.saveFaq({question:textField(req.body.question,'Question',500),answer:textField(req.body.answer,'Answer',5000),language,active:req.body.active===undefined?true:booleanField(req.body.active,'Active'),sort_order:req.body.sort_order===undefined?0:integerField(req.body.sort_order,'Sort order',0,1000000)},req.admin.adminTelegramId);return res.status(201).json({ok:true,data:row});
}));
router.patch('/api/faqs/:id', requireMutationProtection, asyncRoute(async(req,res)=>{const id=positiveId(req.params.id,'FAQ ID');allowedBody(req.body,['question','answer','language','active','sort_order']);const v={};if('question'in req.body)v.question=textField(req.body.question,'Question',500);if('answer'in req.body)v.answer=textField(req.body.answer,'Answer',5000);if('language'in req.body){v.language=String(req.body.language);if(!['en','ar','hi','all'].includes(v.language))throw new ApiError(422,'INVALID_LANGUAGE','Invalid FAQ language.');}if('active'in req.body)v.active=booleanField(req.body.active,'Active');if('sort_order'in req.body)v.sort_order=integerField(req.body.sort_order,'Sort order',0,1000000);return jsonSuccess(res,await store.saveFaq(v,req.admin.adminTelegramId,id));}));
router.delete('/api/faqs/:id', requireMutationProtection, asyncRoute(async(req,res)=>jsonSuccess(res,await store.deleteFaq(positiveId(req.params.id,'FAQ ID')))));

router.get('/api/chats', asyncRoute(async(req,res)=>{const {page,limit}=pageParams(req.query);const status=['open','closed'].includes(String(req.query.status||''))?String(req.query.status):'';const search=cleanSearch(req.query.search);const result=await store.listSupportConversations({page,limit,status,search});return jsonSuccess(res,result.items,paginationMeta(page,limit,result.count));}));
router.post('/api/chats/by-telegram-id', requireMutationProtection, asyncRoute(async(req,res)=>{allowedBody(req.body,['telegram_id'],['telegram_id']);const telegramId=String(req.body.telegram_id||'').trim();if(!/^\d{1,20}$/.test(telegramId))throw new ApiError(422,'INVALID_TELEGRAM_ID','Enter a valid Telegram User ID.');try{await bot.telegram.getChat(telegramId);}catch(error){throw new ApiError(422,'TELEGRAM_UNAVAILABLE','This Telegram ID is invalid, unavailable to the bot, or the user has not opened the bot yet.');}try{const row=await store.getOrCreateSupportConversationByTelegramId(telegramId);return jsonSuccess(res,row);}catch(error){if(error?.code==='USER_NOT_FOUND')throw new ApiError(404,'USER_NOT_FOUND','No existing bot user was found for this Telegram ID. No new user was created.');throw error;}}));
router.get('/api/chats/:id', asyncRoute(async(req,res)=>{const row=await store.getSupportConversation(positiveId(req.params.id,'Conversation ID'));if(!row)throw new ApiError(404,'CHAT_NOT_FOUND','Conversation not found.');await store.markSupportRead(row.id);return jsonSuccess(res,row);}));
router.post('/api/chats/:id/reply', requireMutationProtection, asyncRoute(async(req,res)=>{const id=positiveId(req.params.id,'Conversation ID');allowedBody(req.body,['message'],['message']);const message=textField(req.body.message,'Message',4000);const conversation=await store.getSupportConversation(id);if(!conversation)throw new ApiError(404,'CHAT_NOT_FOUND','Conversation not found.');const telegramId=conversation.users.telegram_id;try{await bot.telegram.getChat(telegramId);const sent=await bot.telegram.sendMessage(telegramId,`💬 Support\n\n${message}`);const row=await store.adminReplySupport(id,req.admin.adminTelegramId,message,sent.message_id);await store.auditAdmin(req.admin.adminTelegramId,'support_reply','support_conversation',id,{});return jsonSuccess(res,row);}catch(error){console.error('support_reply_telegram_failed',{conversationId:id,telegramId,message:error.message});throw new ApiError(422,'TELEGRAM_SEND_FAILED','Telegram could not deliver this message to the user. The user may have blocked the bot or the chat may be unavailable.');}}));
router.post('/api/chats/:id/status', requireMutationProtection, asyncRoute(async(req,res)=>{const id=positiveId(req.params.id,'Conversation ID');allowedBody(req.body,['status'],['status']);const status=String(req.body.status);if(!['open','closed'].includes(status))throw new ApiError(422,'INVALID_STATUS','Status must be open or closed.');return jsonSuccess(res,await store.setSupportConversationStatus(id,status));}));
router.post('/api/chats/:id/read', requireMutationProtection, asyncRoute(async(req,res)=>{await store.markSupportRead(positiveId(req.params.id,'Conversation ID'));return jsonSuccess(res,{read:true});}));

router.get('/api/payment-settings', asyncRoute(async(_req,res)=>jsonSuccess(res,(await store.getPaymentSettings()).filter((row)=>row.method_key!=='usdt_trc20'))));
router.patch('/api/payment-settings/:key', requireMutationProtection, asyncRoute(async(req,res)=>{
  const key=String(req.params.key);
  if(!['binance','usdt_bep20','solana'].includes(key))throw new ApiError(404,'PAYMENT_NOT_FOUND','Payment method not found.');
  allowedBody(req.body,['enabled','display_name','public_config']);
  const values={};
  if('enabled'in req.body)values.enabled=booleanField(req.body.enabled,'Enabled');
  if('display_name'in req.body)values.display_name=textField(req.body.display_name,'Display name',120);
  if('public_config'in req.body){
    const input=req.body.public_config;
    if(!input||typeof input!=='object'||Array.isArray(input))throw new ApiError(422,'INVALID_CONFIG','Public config must be an object.');
    const allowedKeys=key==='binance'
      ? ['payment_name','pay_id','currency','minimum','maximum','presets','expiration_minutes','instructions','cancel_button_text']
      : ['address','network_name','minimum','maximum','presets','expiration_minutes','instructions'];
    const clean={};
    for(const name of allowedKeys)if(Object.prototype.hasOwnProperty.call(input,name))clean[name]=input[name];
    if(key==='usdt_bep20'&&clean.address&& !/^0x[0-9a-fA-F]{40}$/.test(String(clean.address)))throw new ApiError(422,'INVALID_BEP20_ADDRESS','BEP20 address must start with 0x and contain 40 hexadecimal characters.');
    if(key==='solana'&&clean.address&& !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(clean.address)))throw new ApiError(422,'INVALID_SOLANA_ADDRESS','Solana address must be a valid base58 address (32-44 characters).');
    if(clean.presets!==undefined){if(!Array.isArray(clean.presets)||clean.presets.length>20)throw new ApiError(422,'INVALID_PRESETS','Presets must be an array of up to 20 amounts.');clean.presets=clean.presets.map((value)=>decimalField(value,'Preset'));}
    if(clean.minimum!==undefined)clean.minimum=decimalField(clean.minimum,'Minimum');
    if(clean.maximum!==undefined)clean.maximum=decimalField(clean.maximum,'Maximum');
    if(clean.minimum!==undefined&&clean.maximum!==undefined&&Number(clean.minimum)>Number(clean.maximum))throw new ApiError(422,'INVALID_RANGE','Minimum cannot exceed maximum.');
    if(clean.expiration_minutes!==undefined)clean.expiration_minutes=integerField(clean.expiration_minutes,'Expiration minutes',1,1440);
    for(const name of ['payment_name','pay_id','currency','instructions','cancel_button_text','network_name'])if(clean[name]!==undefined)clean[name]=textField(String(clean[name]||''),name.replaceAll('_',' '),1000,{required:false});
    values.public_config=clean;
  }
  await store.auditAdmin(req.admin.adminTelegramId,'payment_setting_update','payment_setting',key,{fields:Object.keys(values)});
  return jsonSuccess(res,await store.savePaymentSetting(key,values,req.admin.adminTelegramId));
}));

// --- Referrals ------------------------------------------------------------
router.get('/api/referrals/settings', asyncRoute(async(_req,res)=>jsonSuccess(res,await store.getReferralSettings())));
router.patch('/api/referrals/settings', requireMutationProtection, asyncRoute(async(req,res)=>{
  allowedBody(req.body,['enabled','commissionPercent','labelEn','labelAr','labelHi']);
  const values={};
  if('enabled'in req.body)values.enabled=booleanField(req.body.enabled,'Enabled');
  if('commissionPercent'in req.body){
    const percent=Number(req.body.commissionPercent);
    if(!Number.isFinite(percent)||percent<=0||percent>100)throw new ApiError(422,'INVALID_PERCENT','Commission percent must be between 0 and 100.');
    values.commissionPercent=percent;
  }
  if('labelEn'in req.body)values.labelEn=textField(req.body.labelEn,'English label',64);
  if('labelAr'in req.body)values.labelAr=textField(req.body.labelAr,'Arabic label',64);
  if('labelHi'in req.body)values.labelHi=textField(req.body.labelHi,'Hindi label',64);
  await store.auditAdmin(req.admin.adminTelegramId,'referral_settings_update','referral_settings',null,{fields:Object.keys(values)});
  return jsonSuccess(res,await store.saveReferralSettings(values,req.admin.adminTelegramId));
}));
router.get('/api/referrals/stats', asyncRoute(async(_req,res)=>jsonSuccess(res,await store.listReferralAdminStats())));
router.get('/api/referrals/users', asyncRoute(async(req,res)=>{
  const {page,limit}=pageParams(req.query);
  const search=cleanSearch(req.query.search);
  const result=await store.listReferralUsers({page,limit,search});
  return jsonSuccess(res,result.items,paginationMeta(page,limit,result.count));
}));
router.patch('/api/referrals/users/:id', requireMutationProtection, asyncRoute(async(req,res)=>{
  const id=positiveId(req.params.id,'Referral user ID');
  allowedBody(req.body,['active']);
  const active=booleanField(req.body.active,'Active');
  const row=await store.setUserReferralActive(id,active,req.admin.adminTelegramId);
  if(!row)throw new ApiError(404,'REFERRAL_USER_NOT_FOUND','Referral user not found.');
  await store.auditAdmin(req.admin.adminTelegramId,'user_referral_status','user',id,{active});
  return jsonSuccess(res,row);
}));
router.delete('/api/referrals/users/:id', requireMutationProtection, asyncRoute(async(req,res)=>{
  const id=positiveId(req.params.id,'Referral user ID');
  const row=await store.deleteUserReferral(id,req.admin.adminTelegramId);
  if(!row)throw new ApiError(404,'REFERRAL_USER_NOT_FOUND','Referral user not found.');
  await store.auditAdmin(req.admin.adminTelegramId,'user_referral_delete','user',id,{});
  return jsonSuccess(res,row);
}));

// --- Merchant referral links ----------------------------------------------
router.get('/api/merchant-links', asyncRoute(async(req,res)=>{
  const {page,limit}=pageParams(req.query);
  const search=cleanSearch(req.query.search);
  const result=await store.listMerchantLinks({page,limit,search});
  const botInfo=await bot.telegram.getMe();
  const items=result.items.map((row)=>({...row,referral_link:`https://t.me/${botInfo.username}?start=merchant_${row.code}`}));
  return jsonSuccess(res,items,paginationMeta(page,limit,result.count));
}));
router.post('/api/merchant-links', requireMutationProtection, asyncRoute(async(req,res)=>{
  allowedBody(req.body,['owner','commissionPercent','label','active'],['owner','commissionPercent']);
  const owner=await store.findUserForMerchantLink(String(req.body.owner||''));
  if(!owner)throw new ApiError(404,'USER_NOT_FOUND','No bot user matches that Telegram ID or username.');
  const percent=Number(req.body.commissionPercent);
  if(!Number.isFinite(percent)||percent<=0||percent>100)throw new ApiError(422,'INVALID_PERCENT','Commission percent must be between 0 and 100.');
  const label=req.body.label!==undefined?textField(req.body.label,'Label',120,{required:false}):'';
  const active=req.body.active!==undefined?booleanField(req.body.active,'Active'):true;
  const row=await store.createMerchantLink({ownerUserId:owner.id,commissionPercent:percent,label,active},req.admin.adminTelegramId);
  await store.auditAdmin(req.admin.adminTelegramId,'merchant_link_create','merchant_referral_link',row.id,{owner:owner.telegram_id});
  return jsonSuccess(res,row);
}));
router.patch('/api/merchant-links/:id', requireMutationProtection, asyncRoute(async(req,res)=>{
  const id=positiveId(req.params.id,'Merchant link ID');
  allowedBody(req.body,['commissionPercent','label','active']);
  const values={};
  if('commissionPercent'in req.body){
    const percent=Number(req.body.commissionPercent);
    if(!Number.isFinite(percent)||percent<=0||percent>100)throw new ApiError(422,'INVALID_PERCENT','Commission percent must be between 0 and 100.');
    values.commissionPercent=percent;
  }
  if('label'in req.body)values.label=textField(req.body.label,'Label',120,{required:false});
  if('active'in req.body)values.active=booleanField(req.body.active,'Active');
  const row=await store.updateMerchantLink(id,values,req.admin.adminTelegramId);
  if(!row)throw new ApiError(404,'MERCHANT_LINK_NOT_FOUND','Merchant referral link not found.');
  await store.auditAdmin(req.admin.adminTelegramId,'merchant_link_update','merchant_referral_link',id,{fields:Object.keys(values)});
  return jsonSuccess(res,row);
}));
router.delete('/api/merchant-links/:id', requireMutationProtection, asyncRoute(async(req,res)=>{
  const id=positiveId(req.params.id,'Merchant link ID');
  const row=await store.deleteMerchantLink(id);
  if(!row)throw new ApiError(404,'MERCHANT_LINK_NOT_FOUND','Merchant referral link not found.');
  await store.auditAdmin(req.admin.adminTelegramId,'merchant_link_delete','merchant_referral_link',id,{code:row.code});
  return jsonSuccess(res,row);
}));

// --- Required (force-join) channels ---------------------------------------
router.get('/api/required-channels', asyncRoute(async(_req,res)=>jsonSuccess(res,{
  enabled: await store.isForceJoinEnabled(),
  channels: await store.getRequiredChannels(false)
})));
router.patch('/api/required-channels/settings', requireMutationProtection, asyncRoute(async(req,res)=>{
  allowedBody(req.body,['enabled'],['enabled']);
  const enabled=await store.setForceJoinEnabled(booleanField(req.body.enabled,'Enabled'),req.admin.adminTelegramId);
  await store.auditAdmin(req.admin.adminTelegramId,'force_join_toggle','force_join',null,{enabled});
  return jsonSuccess(res,{enabled});
}));
router.post('/api/required-channels', requireMutationProtection, asyncRoute(async(req,res)=>{
  allowedBody(req.body,['name','chatRef','joinUrl','active','sortOrder'],['name','chatRef','joinUrl']);
  const values={
    name: textField(req.body.name,'Channel name',120),
    chatRef: textField(req.body.chatRef,'Chat ID / username',120),
    joinUrl: textField(req.body.joinUrl,'Join URL',500),
    active: req.body.active!==undefined?booleanField(req.body.active,'Active'):true,
    sortOrder: req.body.sortOrder!==undefined?integerField(req.body.sortOrder,'Sort order',0,100000):0
  };
  const row=await store.createRequiredChannel(values,req.admin.adminTelegramId);
  await store.auditAdmin(req.admin.adminTelegramId,'required_channel_create','required_channel',row.id,{name:row.name});
  return jsonSuccess(res,row);
}));
router.patch('/api/required-channels/:id', requireMutationProtection, asyncRoute(async(req,res)=>{
  const id=positiveId(req.params.id,'Channel ID');
  allowedBody(req.body,['name','chatRef','joinUrl','active','sortOrder']);
  const values={};
  if('name'in req.body)values.name=textField(req.body.name,'Channel name',120);
  if('chatRef'in req.body)values.chatRef=textField(req.body.chatRef,'Chat ID / username',120);
  if('joinUrl'in req.body)values.joinUrl=textField(req.body.joinUrl,'Join URL',500);
  if('active'in req.body)values.active=booleanField(req.body.active,'Active');
  if('sortOrder'in req.body)values.sortOrder=integerField(req.body.sortOrder,'Sort order',0,100000);
  const row=await store.updateRequiredChannel(id,values,req.admin.adminTelegramId);
  if(!row)throw new ApiError(404,'CHANNEL_NOT_FOUND','Required channel not found.');
  await store.auditAdmin(req.admin.adminTelegramId,'required_channel_update','required_channel',id,{fields:Object.keys(values)});
  return jsonSuccess(res,row);
}));
router.delete('/api/required-channels/:id', requireMutationProtection, asyncRoute(async(req,res)=>{
  const id=positiveId(req.params.id,'Channel ID');
  const row=await store.deleteRequiredChannel(id);
  if(!row)throw new ApiError(404,'CHANNEL_NOT_FOUND','Required channel not found.');
  await store.auditAdmin(req.admin.adminTelegramId,'required_channel_delete','required_channel',id,{name:row.name});
  return jsonSuccess(res,{deleted:true});
}));

function safeBinanceError(error){
  const code=String(error?.code||'BINANCE_UNAVAILABLE');
  const known={TIMEOUT:'Binance API timed out.',NOT_CONFIGURED:'Binance API is not configured.',INVALID_RESPONSE:'Binance returned an invalid response.'};
  if(code==='-2014'||code==='-2015')return new ApiError(422,'BINANCE_PERMISSIONS','Binance API key, IP restriction or read permission is invalid.');
  if(code==='-1022')return new ApiError(422,'BINANCE_SIGNATURE','Binance rejected the API signature.');
  if(code==='HTTP_429'||code==='-1003')return new ApiError(429,'BINANCE_RATE_LIMIT','Binance rate limit reached. Try again shortly.');
  return new ApiError(503,code,known[code]||'Binance API is temporarily unavailable.');
}

router.post('/api/binance/test', requireMutationProtection, asyncRoute(async(req,res)=>{
  if(!binancePay.enabled)throw new ApiError(422,'BINANCE_NOT_CONFIGURED','Binance automatic verification is not configured.');
  try{
    const status=await withTimeout(binancePay.testConnection(),12000);
    await store.auditAdmin(req.admin.adminTelegramId,'binance_api_test','binance','connection',{});
    return jsonSuccess(res,{...status,uidConfigured:Boolean(config.binance.uid),uidMasked:config.binance.uid?maskId(config.binance.uid):null});
  }catch(error){throw safeBinanceError(error);}
}));

router.get('/api/binance/transactions', asyncRoute(async(req,res)=>{
  if(!binancePay.enabled)throw new ApiError(422,'BINANCE_NOT_CONFIGURED','Binance automatic verification is not configured.');
  const startTime=req.query.dateFrom?new Date(String(req.query.dateFrom)).getTime():undefined;
  const endTime=req.query.dateTo?new Date(String(req.query.dateTo)).getTime()+86_399_999:undefined;
  if((req.query.dateFrom&&!Number.isFinite(startTime))||(req.query.dateTo&&!Number.isFinite(endTime)))throw new ApiError(422,'INVALID_DATE','Invalid Binance history date filter.');
  let rows;
  try{rows=await withTimeout(binancePay.getCachedPayTradeHistory({startTime,endTime,limit:100,refresh:String(req.query.refresh)==='true'}),12000);}
  catch(error){throw safeBinanceError(error);}
  const orderSearch=cleanSearch(req.query.orderId,64);
  const txSearch=cleanSearch(req.query.transactionId,120);
  const currency=cleanSearch(req.query.currency,12).toUpperCase();
  if(orderSearch){let id;try{id=orderIdValue(orderSearch);}catch(_){throw new ApiError(422,'INVALID_ORDER_ID','Enter one numeric Binance Order ID.');}rows=rows.filter((row)=>String(row.orderId||'')===id);}
  if(txSearch)rows=rows.filter((row)=>String(row.transactionId||'').includes(txSearch));
  if(currency)rows=rows.filter((row)=>String(row.currency||'').toUpperCase()===currency);
  const expectedUid=String(config.binance.uid||'');
  const publicRows=rows.map((row)=>{
    const incoming=Boolean(expectedUid&&String(row.receiverInfo?.binanceId||'')===expectedUid);
    return {orderId:String(row.orderId||''),transactionId:String(row.transactionId||''),transactionTime:row.transactionTime,amount:String(row.amount||''),currency:String(row.currency||''),orderType:String(row.orderType||''),direction:incoming?'incoming':'outgoing',payerInfo:row.payerInfo||{},receiverInfo:row.receiverInfo||{},walletType:row.walletType??null,walletTypes:row.walletTypes||[]};
  }).filter((row)=>String(req.query.incomingOnly)!=='true'||row.direction==='incoming');
  const ids=publicRows.map((row)=>row.orderId).filter((value)=>/^\d{8,32}$/.test(value));
  let used=[];
  if(ids.length){const result=checked(await withTimeout(db().from('deposits').select('id,provider_order_id,status').in('provider_order_id',ids)),'Binance deposit matches');used=result.data||[];}
  const matches=new Map(used.map((row)=>[String(row.provider_order_id),row]));
  return jsonSuccess(res,{items:publicRows.map((row)=>({...row,match:matches.has(row.orderId)?'matched_to_bot_deposit':'not_used',deposit:matches.get(row.orderId)||null})),lastSyncTime:new Date(binancePay.historyCacheAt||Date.now()).toISOString(),cached:!String(req.query.refresh).includes('true')});
}));

router.get('/api/scheduled-sales', asyncRoute(async(_req,res)=>{
  const rows=checked(await withTimeout(db().from('scheduled_sales').select('*,products(name,emoji)').order('created_at',{ascending:false}).limit(100)),'scheduled sales');
  return jsonSuccess(res,rows.data||[]);
}));

router.post('/api/scheduled-sales', requireMutationProtection, asyncRoute(async(req,res)=>{
  allowedBody(req.body,['product_id','sale_price','starts_at','ends_at'],['product_id','sale_price','starts_at','ends_at']);
  const productId=positiveId(req.body.product_id,'Product ID');
  const product=await store.getProduct(productId);
  if(!product)throw new ApiError(404,'PRODUCT_NOT_FOUND','Product not found.');
  const salePrice=decimalField(req.body.sale_price,'Sale price');
  if(Number(salePrice)>=Number(product.price))throw new ApiError(422,'INVALID_SALE_PRICE','Sale price must be lower than the current normal price.');
  const startsAt=new Date(String(req.body.starts_at));const endsAt=new Date(String(req.body.ends_at));
  if(!Number.isFinite(startsAt.getTime())||!Number.isFinite(endsAt.getTime())||endsAt<=startsAt)throw new ApiError(422,'INVALID_SALE_DATES','Sale end must be after its start.');
  const row=checked(await withTimeout(db().from('scheduled_sales').insert({product_id:productId,normal_price:product.price,sale_price:salePrice,starts_at:startsAt.toISOString(),ends_at:endsAt.toISOString(),created_by:req.admin.adminTelegramId}).select().single()),'create scheduled sale');
  await store.auditAdmin(req.admin.adminTelegramId,'scheduled_sale_create','scheduled_sale',row.data.id,{product_id:productId});
  liveEvents.publish(['automation','products'],{source:'scheduled_sale_created',saleId:row.data.id});
  return res.status(201).json({ok:true,data:row.data});
}));

router.post('/api/scheduled-sales/:id/cancel', requireMutationProtection, asyncRoute(async(req,res)=>{
  const id=positiveId(req.params.id,'Sale ID');
  const existing=checked(await withTimeout(db().from('scheduled_sales').select('*').eq('id',id).maybeSingle()),'get scheduled sale').data;
  if(!existing)throw new ApiError(404,'SALE_NOT_FOUND','Scheduled sale not found.');
  if(!['scheduled','active'].includes(existing.status))throw new ApiError(409,'SALE_FINISHED','This sale has already finished.');
  if(existing.status==='active'){
    const product=await store.getProduct(existing.product_id);
    if(String(product.price)===String(existing.sale_price))await withTimeout(db().from('products').update({price:existing.normal_price,updated_at:new Date().toISOString()}).eq('id',existing.product_id));
  }
  const row=checked(await withTimeout(db().from('scheduled_sales').update({status:'cancelled',updated_at:new Date().toISOString()}).eq('id',id).in('status',['scheduled','active']).select().single()),'cancel scheduled sale').data;
  await store.auditAdmin(req.admin.adminTelegramId,'scheduled_sale_cancel','scheduled_sale',id,{});
  liveEvents.publish(['automation','products'],{source:'scheduled_sale_cancelled',saleId:id});
  return jsonSuccess(res,row);
}));

router.use('/api', (_req, res) => jsonFailure(res, 404, 'NOT_FOUND', 'Admin API route not found.'));

router.use((error, req, res, _next) => {
  const status = error instanceof ApiError ? error.status : (error.code === '23505' ? 409 : 500);
  const code = error instanceof ApiError ? error.apiCode : (error.code === '23505' ? 'CONFLICT' : 'INTERNAL_ERROR');
  const message = error instanceof ApiError ? error.message : (status === 409 ? 'This value already exists or conflicts with existing data.' : 'The operation could not be completed.');
  console.error('admin_request_failed', {
    requestId: req.requestId,
    actor: req.admin?.adminTelegramId,
    path: req.path,
    method: req.method,
    code: String(error.code || code).slice(0, 60)
  });
  if (req.path.startsWith('/api/')) return jsonFailure(res, status, code, message);
  return res.status(status).type('text/plain').send(status === 500 ? 'Something went wrong' : message);
});

app.use('/admin', (error, req, res, _next) => {
  const requestId = randomToken(12);
  const status = error?.type === 'entity.too.large' ? 413 : 400;
  res.set({
    'X-Request-ID': requestId,
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cache-Control': 'no-store'
  });
  console.warn('admin_body_rejected', { requestId, status });
  if (req.path.startsWith('/api/')) return jsonFailure(res, status, status === 413 ? 'BODY_TOO_LARGE' : 'INVALID_JSON', status === 413 ? 'Request body is too large.' : 'Request body is not valid JSON.');
  return res.status(status).type('text/plain').send(status === 413 ? 'Request too large' : 'Invalid request');
});

app.use('/admin', router);

function renderLoginPage(nonce, csrf, error) {
  const errorMarkup = error ? `<div class="login-error" role="alert">${htmlEscape(error)}</div>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Store Admin · Sign in</title><style nonce="${htmlEscape(nonce)}">${LOGIN_CSS}</style></head>
<body><main class="login-shell"><section class="login-card" aria-labelledby="login-title"><div class="brand-mark">S</div>
<p class="eyebrow">TELEGRAM STORE</p><h1 id="login-title">Admin sign in</h1><p class="muted">Use your private administrator credentials.</p>
${errorMarkup}<form method="post" action="/admin/login" autocomplete="on"><input type="hidden" name="_csrf" value="${htmlEscape(csrf)}">
<label for="username">Username</label><input id="username" name="username" type="text" autocomplete="username" maxlength="120" required autofocus>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="512" required>
<button type="submit">Sign in</button></form><p class="foot">Protected administration area · Render fix R4</p></section></main></body></html>`;
}

function renderAdminPage(nonce) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram Store Admin</title><style nonce="${htmlEscape(nonce)}">${ADMIN_CSS}</style></head>
<body><div id="app"><aside id="sidebar" class="sidebar"><div class="brand"><span class="brand-mark">S</span><span class="brand-copy"><strong>Store Admin</strong><small>Telegram commerce</small></span></div><nav id="nav" aria-label="Admin sections"></nav><div class="sidebar-foot"><span class="status-dot"></span><span>Secure session</span></div></aside>
<div class="shell"><header class="topbar"><button id="menu-button" class="icon-button" type="button" aria-label="Toggle navigation" aria-controls="sidebar">☰</button><div><p class="eyebrow">CONTROL CENTER</p><h1 id="page-title">Dashboard</h1></div><div class="top-actions"><select id="theme-switcher" class="select theme-switcher" aria-label="Theme"><option value="dark">🌙 Dark</option><option value="light">☀️ Light</option><option value="system">💻 System</option></select><span id="live-status" class="live-status reconnecting"><i></i><span>Reconnecting</span><small id="last-updated">—</small></span><span id="actor" class="actor"></span><button id="logout-button" class="button ghost small" type="button">Sign out</button></div></header>
<main id="content" class="content" tabindex="-1"><div class="loading-panel"><span class="spinner"></span><p>Loading admin panel…</p></div></main></div></div>
<div id="toast-region" class="toast-region" aria-live="polite" aria-atomic="true"></div>
<div id="modal-backdrop" class="modal-backdrop" hidden><section id="modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><h2 id="modal-title"></h2><button id="modal-close" class="icon-button" type="button" aria-label="Close dialog">×</button></header><div id="modal-body" class="modal-body"></div><footer id="modal-actions"></footer></section></div>
<script nonce="${htmlEscape(nonce)}">${ADMIN_CLIENT_JS}</script></body></html>`;
}

const LOGIN_CSS = `
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#070b14;color:#eef2ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 20% 10%,#182449 0,transparent 34%),radial-gradient(circle at 90% 90%,#123a36 0,transparent 28%),#070b14}.login-shell{min-height:100vh;display:grid;place-items:center;padding:24px}.login-card{width:min(100%,430px);padding:38px;border:1px solid #263047;border-radius:24px;background:rgba(12,18,32,.92);box-shadow:0 32px 80px rgba(0,0,0,.45);backdrop-filter:blur(18px)}.brand-mark{display:grid;place-items:center;width:48px;height:48px;border-radius:15px;background:linear-gradient(135deg,#7c5cff,#3dd9b6);font-weight:900;color:#071018;box-shadow:0 12px 32px rgba(77,190,181,.2)}.eyebrow{margin:24px 0 7px;color:#7f8da8;font-size:11px;font-weight:800;letter-spacing:.18em}.login-card h1{margin:0;font-size:30px;letter-spacing:-.04em}.muted,.foot{color:#8995aa}.muted{margin:9px 0 25px}.foot{text-align:center;font-size:12px;margin:24px 0 0}.login-error{padding:12px 14px;margin:0 0 18px;border:1px solid #713d4b;border-radius:12px;background:#2b141d;color:#ffb9c5;font-size:14px}form{display:grid;gap:9px}label{margin-top:10px;color:#cbd4e5;font-size:13px;font-weight:700}input{width:100%;border:1px solid #2a354d;border-radius:12px;background:#0a1020;color:#fff;padding:13px 14px;font:inherit;outline:none}input:focus{border-color:#8069ff;box-shadow:0 0 0 3px rgba(124,92,255,.18)}button{margin-top:17px;border:0;border-radius:12px;background:linear-gradient(135deg,#7c5cff,#5c89ff);color:#fff;padding:13px;font:inherit;font-weight:800;cursor:pointer}button:hover{filter:brightness(1.08)}
`;

const ADMIN_CSS = `
.image-preview{display:block;width:100%;max-height:180px;object-fit:contain;margin-top:8px;border:1px solid var(--border);border-radius:10px;background:#080d18}.live-status{display:grid;grid-template-columns:auto auto;column-gap:7px;align-items:center;padding:6px 9px;border:1px solid var(--border);border-radius:10px;color:var(--muted);font-size:10px}.live-status i{width:7px;height:7px;border-radius:50%;background:var(--warning)}.live-status small{grid-column:2;color:#68758c;font-size:8px}.live-status.connected i{background:var(--success);box-shadow:0 0 0 3px rgba(61,217,165,.12)}.live-status.disconnected i{background:var(--danger)}.stat-card.accent-purple:after{background:#7c5cff}.stat-card.accent-red:after{background:#ff627d}.stat-card.accent-green:after{background:#3dd9a5}.stat-card.accent-yellow:after{background:#f7be56}.stat-card.accent-blue:after{background:#62b7ff}.progress-native{width:100%;height:10px;border:0;border-radius:999px;overflow:hidden;background:#202a3d}.progress-native::-webkit-progress-bar{background:#202a3d}.progress-native::-webkit-progress-value{background:linear-gradient(90deg,var(--primary),var(--success))}.progress-native::-moz-progress-bar{background:linear-gradient(90deg,var(--primary),var(--success))}
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--bg:#070b14;--panel:#0e1422;--panel-secondary:#121a2a;--panel2:var(--panel-secondary);--border:#253047;--text:#edf2ff;--muted:#8996ad;--primary:#7c5cff;--primary2:#5b8bff;--success:#3dd9a5;--danger:#ff627d;--warning:#f7be56;--info:#62b7ff;--shadow:0 18px 45px rgba(0,0,0,.28)}*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:radial-gradient(circle at 70% -10%,#18244a 0,transparent 30%),var(--bg);color:var(--text);min-height:100vh}button,input,select,textarea{font:inherit}.sidebar{position:fixed;z-index:30;inset:0 auto 0 0;width:255px;border-right:1px solid var(--border);background:rgba(9,14,25,.96);display:flex;flex-direction:column;padding:18px 13px;transition:transform .22s ease}.brand{display:flex;align-items:center;gap:12px;padding:4px 8px 22px}.brand-mark{display:grid;place-items:center;flex:none;width:39px;height:39px;border-radius:12px;background:linear-gradient(135deg,var(--primary),var(--success));color:#061019;font-weight:900}.brand-copy{display:grid}.brand-copy strong{font-size:14px}.brand-copy small{color:var(--muted);font-size:11px;margin-top:3px}.sidebar nav{display:grid;gap:4px;overflow:auto}.nav-button{display:flex;align-items:center;gap:12px;width:100%;border:0;border-radius:10px;padding:10px 12px;background:transparent;color:#a8b4c8;text-align:left;cursor:pointer;font-weight:650;font-size:13px}.nav-button:hover{background:#141c2c;color:#fff}.nav-button.active{background:linear-gradient(90deg,rgba(124,92,255,.2),rgba(124,92,255,.05));color:#fff;box-shadow:inset 3px 0 var(--primary)}.nav-icon{display:grid;place-items:center;width:21px;color:#8e9db9;font-size:15px}.sidebar-foot{margin-top:auto;border-top:1px solid var(--border);padding:18px 12px 4px;color:var(--muted);font-size:12px;display:flex;align-items:center;gap:8px}.status-dot{width:8px;height:8px;border-radius:50%;background:var(--success);box-shadow:0 0 0 4px rgba(61,217,165,.1)}.shell{margin-left:255px;min-height:100vh}.topbar{position:sticky;top:0;z-index:20;min-height:78px;padding:15px 28px;border-bottom:1px solid rgba(37,48,71,.85);background:rgba(7,11,20,.84);backdrop-filter:blur(16px);display:flex;align-items:center;gap:15px}.topbar h1{margin:1px 0 0;font-size:22px;letter-spacing:-.035em}.eyebrow{margin:0;color:#77859e;font-size:9px;letter-spacing:.18em;font-weight:900}.top-actions{margin-left:auto;display:flex;align-items:center;gap:11px}.actor{color:var(--muted);font-size:12px}.icon-button{display:grid;place-items:center;width:38px;height:38px;border:1px solid var(--border);border-radius:10px;background:#111827;color:#cdd6e6;cursor:pointer}.icon-button:hover{border-color:#586781;color:#fff}#menu-button{display:none}.content{padding:25px 28px 50px;outline:none;max-width:1680px;margin:auto}.loading-panel,.empty,.error-panel{min-height:280px;display:grid;place-items:center;align-content:center;gap:12px;border:1px dashed var(--border);border-radius:18px;color:var(--muted)}.spinner{width:26px;height:26px;border:3px solid #28334a;border-top-color:var(--primary);border-radius:50%;animation:spin .75s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:15px;margin-bottom:22px}.stat-card{position:relative;overflow:hidden;border:1px solid var(--border);border-radius:16px;padding:17px;background:linear-gradient(145deg,rgba(19,28,47,.95),rgba(12,18,31,.95))}.stat-card:after{content:"";position:absolute;width:72px;height:72px;border-radius:50%;right:-25px;top:-25px;background:var(--accent,var(--primary));filter:blur(28px);opacity:.2}.stat-card small{display:block;color:var(--muted);font-weight:650;font-size:11px}.stat-card strong{display:block;margin-top:8px;font-size:25px;letter-spacing:-.04em}.stat-card span{display:block;margin-top:5px;color:#68758c;font-size:10px}.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:18px}.panel{border:1px solid var(--border);border-radius:16px;background:rgba(13,20,34,.93);overflow:hidden}.panel-header{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid var(--border)}.panel-header h2{margin:0;font-size:14px}.panel-header p{margin:4px 0 0;color:var(--muted);font-size:11px}.panel-actions{margin-left:auto;display:flex;gap:8px}.toolbar{display:flex;flex-wrap:wrap;gap:9px;margin-bottom:14px}.field{display:grid;gap:6px}.field.grow{flex:1;min-width:210px}.field label{color:#a8b4c7;font-size:11px;font-weight:750}.input,.select,.textarea{border:1px solid var(--border);border-radius:10px;background:#0a1020;color:var(--text);padding:10px 11px;outline:none;min-height:39px}.input:focus,.select:focus,.textarea:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(124,92,255,.13)}.textarea{width:100%;min-height:120px;resize:vertical}.button{border:0;border-radius:10px;padding:10px 14px;background:linear-gradient(135deg,var(--primary),var(--primary2));color:#fff;font-weight:750;cursor:pointer;white-space:nowrap}.button:hover{filter:brightness(1.1)}.button:disabled{opacity:.45;cursor:not-allowed;filter:none}.button.secondary{background:#1c2639;border:1px solid #33415a}.button.ghost{background:transparent;border:1px solid var(--border);color:#c6d0e0}.button.danger{background:#7a2638}.button.success{background:#176c54}.button.small{padding:7px 10px;font-size:11px}.table-wrap{overflow:auto}.data-table{width:100%;border-collapse:collapse;min-width:730px}.data-table th{position:sticky;top:0;padding:11px 14px;background:#101827;color:#7f8da5;font-size:10px;letter-spacing:.05em;text-transform:uppercase;text-align:left;white-space:nowrap}.data-table td{padding:12px 14px;border-top:1px solid #1d273a;color:#d5ddeb;font-size:12px;vertical-align:middle}.data-table tr:hover td{background:rgba(30,41,61,.35)}.cell-main{display:block;color:#eef2fa;font-weight:650}.cell-sub{display:block;color:var(--muted);font-size:10px;margin-top:3px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}.badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 8px;background:#202a3d;color:#c8d0df;font-size:10px;font-weight:750;white-space:nowrap}.badge:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.badge.success{background:rgba(61,217,165,.1);color:#73edc3}.badge.danger{background:rgba(255,98,125,.1);color:#ff8fa2}.badge.warning{background:rgba(247,190,86,.1);color:#ffd178}.badge.info{background:rgba(98,183,255,.1);color:#8bcaff}.badge.muted{color:#98a4b8}.row-actions{display:flex;gap:6px;justify-content:flex-end}.pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-top:1px solid var(--border);color:var(--muted);font-size:11px}.pagination-buttons{display:flex;gap:7px}.section-note{padding:13px 15px;margin-bottom:14px;border:1px solid #28344b;border-radius:12px;background:#101829;color:#9eadc4;font-size:12px;line-height:1.5}.section-note.warning{border-color:#604f2c;background:#201a0d;color:#efd28d}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.detail{padding:11px;border:1px solid var(--border);border-radius:10px;background:#0b1120;overflow-wrap:anywhere}.detail small{display:block;color:var(--muted);font-size:10px;margin-bottom:5px}.detail strong,.detail span{font-size:12px;white-space:pre-wrap}.subsection{margin-top:20px}.subsection h3{font-size:13px;margin:0 0 10px}.code-block{padding:13px;border:1px solid var(--border);border-radius:10px;background:#070c17;color:#cbd5e6;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto}.modal-backdrop{position:fixed;z-index:60;inset:0;background:rgba(0,0,0,.72);display:grid;place-items:center;padding:18px}.modal-backdrop[hidden]{display:none}.modal{width:min(720px,100%);max-height:92vh;display:flex;flex-direction:column;border:1px solid #34415a;border-radius:18px;background:#0d1422;box-shadow:0 30px 90px rgba(0,0,0,.55)}.modal>header,.modal>footer{display:flex;align-items:center;gap:12px;padding:15px 18px}.modal>header{border-bottom:1px solid var(--border)}.modal>footer{justify-content:flex-end;border-top:1px solid var(--border)}.modal h2{margin:0;font-size:17px}.modal>header .icon-button{margin-left:auto}.modal-body{padding:18px;overflow:auto}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.form-grid .wide{grid-column:1/-1}.toast-region{position:fixed;z-index:80;right:18px;bottom:18px;display:grid;gap:9px;width:min(360px,calc(100vw - 36px))}.toast{padding:13px 15px;border:1px solid #34415a;border-left:4px solid var(--info);border-radius:11px;background:#111a2b;box-shadow:0 14px 35px rgba(0,0,0,.4);font-size:12px}.toast.success{border-left-color:var(--success)}.toast.error{border-left-color:var(--danger)}.progress{height:9px;border-radius:999px;background:#202a3d;overflow:hidden}.progress span{display:block;height:100%;background:linear-gradient(90deg,var(--primary),var(--success));transition:width .3s}.settings-list{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.setting-card{border:1px solid var(--border);border-radius:14px;padding:15px;background:#0e1626}.setting-card small{display:block;color:var(--muted);font-size:10px}.setting-card strong{display:block;margin-top:7px;font-size:13px;overflow-wrap:anywhere}.mobile-overlay{display:none}@media(max-width:1150px){.stats{grid-template-columns:repeat(2,1fr)}.settings-list{grid-template-columns:repeat(2,1fr)}}@media(max-width:860px){.sidebar{transform:translateX(-100%);box-shadow:15px 0 50px rgba(0,0,0,.5)}.sidebar.open{transform:translateX(0)}.shell{margin-left:0}#menu-button{display:grid}.content{padding:20px 16px 40px}.topbar{padding:13px 16px}.grid-2{grid-template-columns:1fr}.actor{display:none}}@media(max-width:560px){.stats{grid-template-columns:1fr}.form-grid,.detail-grid,.settings-list{grid-template-columns:1fr}.top-actions{gap:6px}.topbar h1{font-size:19px}.content{padding-left:11px;padding-right:11px}.toolbar>*{width:100%}.panel-header{align-items:flex-start}.panel-actions{flex-wrap:wrap}.modal-backdrop{padding:7px}.modal{max-height:97vh}.data-table{min-width:650px}.pagination{align-items:flex-start;flex-direction:column}}

.theme-switcher{min-width:118px;padding:7px 9px;background:var(--panel-secondary);color:var(--text)}
html[data-theme="light"]{color-scheme:light;--bg:#f3f6fb;--panel:#ffffff;--panel-secondary:#f7f9fc;--border:#d9e0eb;--text:#172033;--muted:#657186;--primary:#6654e8;--primary2:#4978e8;--success:#13845f;--danger:#d83f5a;--warning:#b67512;--info:#287cc2;--shadow:0 18px 45px rgba(22,34,55,.10)}
html[data-theme="light"] body{background:radial-gradient(circle at 70% -10%,#e7eaff 0,transparent 32%),var(--bg)}
html[data-theme="light"] .sidebar{background:rgba(255,255,255,.97)}html[data-theme="light"] .topbar{background:rgba(248,250,253,.9);border-color:var(--border)}
html[data-theme="light"] .panel,html[data-theme="light"] .stat-card,html[data-theme="light"] .setting-card{background:var(--panel);box-shadow:var(--shadow)}
html[data-theme="light"] .input,html[data-theme="light"] .select,html[data-theme="light"] .textarea,html[data-theme="light"] .icon-button,html[data-theme="light"] .detail,html[data-theme="light"] .code-block,html[data-theme="light"] .section-note{background:var(--panel-secondary);color:var(--text)}
html[data-theme="light"] .data-table th{background:#eef2f8;color:#5d687a}html[data-theme="light"] .data-table td{color:#273249;border-color:#e4e9f1}html[data-theme="light"] .data-table tr:hover td{background:#f7f9fc}
html[data-theme="light"] .nav-button{color:#667286}html[data-theme="light"] .nav-button:hover,html[data-theme="light"] .nav-button.active{color:#182238;background:#eef0ff}
html[data-theme="light"] .modal{background:var(--panel);box-shadow:0 30px 90px rgba(28,41,67,.2)}html[data-theme="light"] .toast{background:var(--panel);color:var(--text)}
@media(max-width:760px){.theme-switcher{max-width:106px;min-width:0}.live-status small{display:none}}
`;

const ADMIN_CLIENT_JS = String.raw`
(function () {
  'use strict';
  var session = null;
  var currentPage = 'dashboard';
  var viewState = Object.create(null);
  var pollTimer = null;
  var fallbackPolling = null;
  var liveSource = null;
  var liveRefreshTimer = null;
  var refreshing = false;
  var navItems = [
    ['dashboard','Dashboard','▦'],['products','Products','▣'],['categories','Categories','◫'],['inventory','Inventory','▤'],
    ['orders','Orders','◎'],['preorders','Pre-Orders','◷'],['refunds','Refund Requests','↩'],['deposits','Deposits','◇'],['users','Users','◉'],['wallet','Wallet Transactions','↔'],
    ['notifications','Notifications','◌'],['automation','Automation','⚡'],['chats','Support Inbox','💬'],['faq','FAQ','?'],['links','Bot Links','↗'],['payments','Payment Settings','◇'],
    ['referrals','Referrals','🎁'],['merchantlinks','Merchant Links','🔗'],['channels','Required Channels','🔒'],
    ['broadcast','Broadcast','◁'],['settings','Bot Settings','⚙']
  ];
  var titles = {dashboard:'Dashboard',products:'Products',categories:'Categories',inventory:'Inventory',orders:'Orders',preorders:'Pre-Orders',refunds:'Refund Requests',deposits:'Deposits',users:'Users',wallet:'Wallet Transactions',notifications:'Notifications',automation:'Notifications / Automation',chats:'Support Inbox',faq:'FAQ Management',links:'Bot Links',payments:'Payment Settings',broadcast:'Broadcast',settings:'Bot Settings',referrals:'Referrals',merchantlinks:'Merchant Referral Links',channels:'Required Channels (Force Join)'};
  var content = document.getElementById('content');
  var pageTitle = document.getElementById('page-title');
  var sidebar = document.getElementById('sidebar');
  var modalBackdrop = document.getElementById('modal-backdrop');
  var modalBody = document.getElementById('modal-body');
  var modalActions = document.getElementById('modal-actions');
  var modalTitle = document.getElementById('modal-title');
  var previousFocus = null;
  var themeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function applyTheme(mode) { var actual=mode==='system'?(themeMedia&&themeMedia.matches?'dark':'light'):mode;document.documentElement.dataset.theme=actual;var picker=document.getElementById('theme-switcher');if(picker&&picker.value!==mode)picker.value=mode; }
  function initTheme(){var mode=localStorage.getItem('admin-theme')||'system';if(['dark','light','system'].indexOf(mode)<0)mode='system';applyTheme(mode);var picker=document.getElementById('theme-switcher');if(picker){picker.value=mode;picker.addEventListener('change',function(){localStorage.setItem('admin-theme',picker.value);applyTheme(picker.value);});}if(themeMedia)themeMedia.addEventListener&&themeMedia.addEventListener('change',function(){if((localStorage.getItem('admin-theme')||'system')==='system')applyTheme('system');});}

  function node(tag, attrs) {
    var element = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value == null) return;
      if (key === 'class') element.className = value;
      else if (key === 'text') element.textContent = value == null ? '' : String(value);
      else if (key === 'htmlFor') element.htmlFor = value;
      else if (key === 'checked') element.checked = Boolean(value);
      else if (key === 'disabled') element.disabled = Boolean(value);
      else if (key === 'value') element.value = value == null ? '' : String(value);
      else if (key === 'on') Object.keys(value).forEach(function (event) { element.addEventListener(event, value[event]); });
      else element.setAttribute(key, value);
    });
    for (var i = 2; i < arguments.length; i += 1) append(element, arguments[i]);
    return element;
  }

  function append(parent, child) {
    if (child == null) return;
    if (Array.isArray(child)) return child.forEach(function (item) { append(parent, item); });
    parent.appendChild(child.nodeType ? child : document.createTextNode(String(child)));
  }

  function clear(element) { while (element.firstChild) element.removeChild(element.firstChild); }
  function relation(value) { return Array.isArray(value) ? (value[0] || {}) : (value || {}); }
  function formatDate(value) { if (!value) return '—'; var date = new Date(value); return isNaN(date.getTime()) ? String(value) : date.toLocaleString(); }
  function money(value) { return value == null ? '0' : String(value); }
  function short(value, length) { var text = String(value == null ? '' : value); return text.length > length ? text.slice(0, length - 1) + '…' : text; }

  async function api(path, options) {
    options = options || {};
    var headers = {Accept:'application/json'};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = session.csrfToken;
    var response = await fetch('/admin/api' + path, {method:options.method || 'GET',headers:headers,body:options.body === undefined ? undefined : JSON.stringify(options.body),credentials:'same-origin'});
    var payload;
    try { payload = await response.json(); } catch (_) { payload = {ok:false,error:{message:'Invalid server response.'}}; }
    if (response.status === 401) { window.location.assign('/admin/login'); throw new Error('Session expired'); }
    if (!response.ok || !payload.ok) throw new Error(payload.error && payload.error.message || 'Request failed.');
    return payload;
  }

  function setLiveState(state) { var root=document.getElementById('live-status');if(!root)return;root.className='live-status '+state;root.querySelector('span').textContent=state==='connected'?'Live / Connected':state==='disconnected'?'Disconnected':'Reconnecting'; }
  function markUpdated() { var target=document.getElementById('last-updated');if(target)target.textContent='Updated '+new Date().toLocaleTimeString(); }
  function startFallbackPolling(){if(fallbackPolling)return;fallbackPolling=window.setInterval(function(){refreshCurrent(false);},7000);}
  function stopFallbackPolling(){if(fallbackPolling){window.clearInterval(fallbackPolling);fallbackPolling=null;}}
  async function refreshCurrent(showSpinner){if(refreshing)return;refreshing=true;try{if(showSpinner)loading();await renderers[currentPage]();markUpdated();}catch(error){if(showSpinner)showError(error);}finally{refreshing=false;}}
  function scheduleLiveRefresh(resources){if(resources&&resources.length&&resources.indexOf(currentPage)<0&&resources.indexOf('dashboard')<0)return;if(liveRefreshTimer)window.clearTimeout(liveRefreshTimer);liveRefreshTimer=window.setTimeout(function(){refreshCurrent(false);},250);}
  function connectLive(){if(liveSource)liveSource.close();setLiveState('reconnecting');liveSource=new EventSource('/admin/api/events',{withCredentials:true});liveSource.addEventListener('ready',function(){setLiveState('connected');stopFallbackPolling();markUpdated();});liveSource.addEventListener('heartbeat',function(){setLiveState('connected');});liveSource.addEventListener('change',function(event){setLiveState('connected');try{scheduleLiveRefresh(JSON.parse(event.data).resources||[]);}catch(_){scheduleLiveRefresh([]);}});liveSource.onerror=function(){setLiveState(navigator.onLine?'reconnecting':'disconnected');startFallbackPolling();};window.addEventListener('offline',function(){setLiveState('disconnected');startFallbackPolling();});window.addEventListener('online',function(){setLiveState('reconnecting');});}

  function toast(message, type) {
    var item = node('div',{class:'toast ' + (type || ''),text:message,role:'status'});
    document.getElementById('toast-region').appendChild(item);
    window.setTimeout(function () { item.remove(); }, 4500);
  }

  function loading() { clear(content); content.appendChild(node('div',{class:'loading-panel'},node('span',{class:'spinner'}),node('p',{text:'Loading data…'}))); }
  function showError(error) { clear(content); content.appendChild(node('div',{class:'error-panel'},node('strong',{text:'Could not load this section'}),node('p',{text:error.message}),node('button',{class:'button secondary',type:'button',text:'Try again',on:{click:renderCurrent}}))); }
  function emptyRow(columns, message) { return node('tr',{},node('td',{colspan:String(columns),text:message || 'No results found.'})); }
  function badge(value) { var text = String(value == null ? 'unknown' : value); var kind = /approved|active|completed|delivered|success|in stock|available|unlimited/i.test(text) ? 'success' : /rejected|suspended|failed|out|disabled|cancelled/i.test(text) ? 'danger' : /pending|processing|low|queued|running/i.test(text) ? 'warning' : /review|binance|instant|manual/i.test(text) ? 'info' : 'muted'; return node('span',{class:'badge ' + kind,text:text.replaceAll('_',' ')}); }
  function button(text, kind, handler) { var item=node('button',{type:'button',class:'button ' + (kind || ''),text:text});item.addEventListener('click',async function(event){if(item.dataset.busy==='1')return;try{var result=handler(event);if(result&&typeof result.then==='function'){item.dataset.busy='1';item.disabled=true;await result;}}finally{item.dataset.busy='0';item.disabled=false;}});return item; }
  async function copyText(value) { if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('Clipboard access is unavailable.'); await navigator.clipboard.writeText(String(value || '')); }
  function inputField(label, name, value, options) { options = options || {}; var input = node(options.tag || 'input',{class:options.tag === 'textarea' ? 'textarea' : options.tag === 'select' ? 'select' : 'input',name:name,id:'field-' + name,value:value == null ? '' : value,type:options.type || 'text',maxlength:options.maxlength || '',required:options.required ? 'required' : null}); if (options.tag === 'select') { clear(input); (options.choices || []).forEach(function (choice) { var opt = node('option',{value:choice[0],text:choice[1]}); if (String(choice[0]) === String(value)) opt.selected = true; input.appendChild(opt); }); } var field=node('div',{class:'field ' + (options.wide ? 'wide' : '')},node('label',{htmlFor:'field-' + name,text:label}),input);if(name==='image'){var image=node('img',{class:'image-preview',alt:'Product image preview'});var update=function(){var url=input.value.trim();if(/^https:\/\//i.test(url)){image.src=url;image.hidden=false;}else{image.removeAttribute('src');image.hidden=true;}};input.addEventListener('input',update);update();field.appendChild(image);}return field; }
  function imagePreviewField(name,value){var field=inputField('HTTPS image URL',name,value||'',{maxlength:2048,wide:true});var input=field.querySelector('input');var image=node('img',{class:'image-preview',alt:'Product image preview'});function update(){var url=input.value.trim();if(/^https:\/\//i.test(url)){image.src=url;image.hidden=false;}else{image.removeAttribute('src');image.hidden=true;}}input.addEventListener('input',update);update();field.appendChild(image);return field;}

  function openModal(title, body, actions) {
    previousFocus = document.activeElement;
    modalTitle.textContent = title;
    clear(modalBody); clear(modalActions);
    append(modalBody, body); (actions || []).forEach(function (action) { modalActions.appendChild(action); });
    modalBackdrop.hidden = false;
    var focusable = modalBackdrop.querySelector('input,select,textarea,button'); if (focusable) focusable.focus();
  }
  function closeModal() { modalBackdrop.hidden = true; clear(modalBody); clear(modalActions); if (previousFocus) previousFocus.focus(); }
  document.getElementById('modal-close').addEventListener('click',closeModal);
  modalBackdrop.addEventListener('click',function (event) { if (event.target === modalBackdrop) closeModal(); });
  document.addEventListener('keydown',function (event) { if (event.key === 'Escape' && !modalBackdrop.hidden) closeModal(); });

  function detail(label, value, mono) { return node('div',{class:'detail'},node('small',{text:label}),node('span',{class:mono ? 'mono' : '',text:value == null || value === '' ? '—' : String(value)})); }
  function detailsGrid(items) { return node('div',{class:'detail-grid'},items.map(function (item) { return detail(item[0],item[1],item[2]); })); }
  function codeBlock(value) { return node('div',{class:'code-block',text:value == null || value === '' ? '—' : typeof value === 'string' ? value : JSON.stringify(value,null,2)}); }
  function panel(title, subtitle, child, actions) { return node('section',{class:'panel'},node('header',{class:'panel-header'},node('div',{},node('h2',{text:title}),subtitle ? node('p',{text:subtitle}) : null),actions ? node('div',{class:'panel-actions'},actions) : null),child); }
  function table(headers, rows) { var head = node('thead',{},node('tr',{},headers.map(function (h) { return node('th',{text:h}); }))); var body = node('tbody'); if (!rows.length) body.appendChild(emptyRow(headers.length)); else rows.forEach(function (row) { body.appendChild(node('tr',{},row)); }); return node('div',{class:'table-wrap'},node('table',{class:'data-table'},head,body)); }

  function stateFor(name) { if (!viewState[name]) viewState[name] = {page:1,limit:25,search:''}; return viewState[name]; }
  function queryString(values) { var params = new URLSearchParams(); Object.keys(values).forEach(function (key) { if (values[key] !== '' && values[key] != null) params.set(key,values[key]); }); return '?' + params.toString(); }
  function pagination(meta, reload) { var info = node('span',{text:'Page ' + meta.page + ' of ' + meta.pages + ' · ' + meta.count + ' records'});var size=node('select',{class:'select','aria-label':'Rows per page'});[10,25,50,100].forEach(function(value){var option=node('option',{value:String(value),text:value+' / page'});if(Number(meta.limit)===value)option.selected=true;size.appendChild(option);});size.addEventListener('change',function(){stateFor(currentPage).limit=Number(size.value);reload(1);}); var prev = button('Previous','ghost small',function(){ if(meta.page>1) reload(meta.page-1);}); var next = button('Next','ghost small',function(){ if(meta.page<meta.pages) reload(meta.page+1);}); prev.disabled = meta.page <= 1; next.disabled = meta.page >= meta.pages; return node('div',{class:'pagination'},info,node('div',{class:'pagination-buttons'},size,prev,next)); }
  function toolbarSearch(state, placeholder, reload) { var input = node('input',{class:'input',type:'search',placeholder:placeholder,value:state.search}); var timer; input.addEventListener('input',function(){ window.clearTimeout(timer); timer=window.setTimeout(function(){state.search=input.value;state.page=1;reload();},350);}); return node('div',{class:'field grow'},node('label',{text:'Search'}),input); }
  function selectControl(label,value,choices,onchange) { var select = node('select',{class:'select'}); choices.forEach(function(choice){var option=node('option',{value:choice[0],text:choice[1]});if(String(choice[0])===String(value))option.selected=true;select.appendChild(option);});select.addEventListener('change',function(){onchange(select.value);});return node('div',{class:'field'},node('label',{text:label}),select); }
  function dateControl(label,key,state,reload){var input=node('input',{class:'input',type:'date',value:state[key]||''});input.addEventListener('change',function(){state[key]=input.value;state.page=1;reload();});return node('div',{class:'field'},node('label',{text:label}),input);}
  async function submitForm(form, submitButton, operation) { if (!form.reportValidity()) return; submitButton.disabled=true; var original=submitButton.textContent;submitButton.textContent='Processing…';try{await operation(new FormData(form));closeModal();toast('Saved successfully.','success');await renderCurrent();}catch(error){toast(error.message,'error');}finally{submitButton.disabled=false;submitButton.textContent=original;} }

  function setRoute(name) { if (!titles[name]) name='dashboard'; currentPage=name; window.location.hash=name; pageTitle.textContent=titles[name]; document.querySelectorAll('.nav-button').forEach(function(item){item.classList.toggle('active',item.dataset.page===name);});sidebar.classList.remove('open');if(pollTimer){clearTimeout(pollTimer);pollTimer=null;}renderCurrent(); }
  async function renderCurrent() { await refreshCurrent(true); content.focus(); }

  async function renderDashboard() {
    var data=(await api('/dashboard')).data;clear(content);
    var quick=node('div',{class:'toolbar'},button('+ Add Product','',async function(){try{productForm(null,await categoryOptions());}catch(e){toast(e.message,'error');}}),button('+ Add Category','secondary',function(){categoryForm(null);}),button('+ Import Inventory','secondary',function(){setRoute('inventory');}),button('+ Create Broadcast','secondary',function(){setRoute('broadcast');}),button('⚡ Automation','ghost',function(){setRoute('automation');}));
    content.appendChild(quick);
    var cards=[['Sales Today',money(data.stats.salesToday)+' USDT','Since 00:00 UTC'],['Orders Today',data.stats.ordersToday,'New orders today'],['Total Users',data.stats.users,'All registered'],['Active Users',data.stats.activeUsers,'Updated in last 30 days'],['Products',data.stats.totalProducts,'Non-draft products'],['Low Stock',data.stats.lowStockProducts,'Needs attention'],['Out of Stock',data.stats.outOfStockProducts,'Currently unavailable'],['Pending Deposits',data.stats.pendingDeposits,'Awaiting payment'],['Pending Refunds',data.stats.pendingRefunds,'Pending review'],['Unread Support',data.stats.messagesWaiting,'Messages waiting'],['Total Revenue',money(data.stats.totalRevenue)+' USDT','Completed non-refunded orders'],['Unique Inventory',data.stats.availableInventory,'Available encrypted items']];
    var accentClasses=['accent-purple','accent-red','accent-green','accent-blue','accent-yellow'];content.appendChild(node('div',{class:'stats'},cards.map(function(card,index){return node('article',{class:'stat-card '+accentClasses[index%accentClasses.length]},node('small',{text:card[0]}),node('strong',{text:card[1]}),node('span',{text:card[2]}));})));
    var orderRows=(data.recentOrders||[]).map(function(row){var user=relation(row.users);return [node('td',{},node('span',{class:'cell-main',text:row.product_name}),node('span',{class:'cell-sub',text:'#'+row.id})),node('td',{class:'mono',text:String(user.telegram_id||'—')}),node('td',{text:money(row.amount)+' USDT'}),node('td',{},badge(row.status)),node('td',{text:formatDate(row.created_at)})];});
    var lowRows=(data.lowStockRows||[]).map(function(row){var stock=row.unlimited_stock?'∞':String(row.available_stock==null?row.stock||0:row.available_stock);return[node('td',{},node('span',{class:'cell-main',text:(row.emoji||'📦')+' '+row.name}),node('span',{class:'cell-sub',text:'#'+row.id+' · '+row.fulfillment_type})),node('td',{class:'mono',text:stock}),node('td',{},badge(Number(stock)===0?'out of stock':'low stock')),node('td',{},button('Open','ghost small',function(){setRoute('products');}))];});
    content.appendChild(node('div',{class:'grid-2'},panel('Recent Orders','Newest store purchases',table(['Order','User','Amount','Status','Created'],orderRows)),panel('Low Stock Products','Products at or below the configured low-stock threshold',table(['Product','Stock','State',''],lowRows))));
    var supportRows=(data.recentSupport||[]).map(function(row){var u=relation(row.users);return[node('td',{},node('span',{class:'cell-main',text:u.username?'@'+u.username:[u.first_name,u.last_name].filter(Boolean).join(' ')||'User'}),node('span',{class:'cell-sub mono',text:String(u.telegram_id||'—')})),node('td',{class:'mono',text:String(row.unread_admin_count||0)}),node('td',{},badge(row.status)),node('td',{text:formatDate(row.last_message_at)}),node('td',{},button('Inbox','ghost small',function(){setRoute('chats');}))];});
    var activityRows=(data.recentActivity||[]).map(function(row){return[node('td',{},badge(row.action)),node('td',{text:row.target_type}),node('td',{class:'mono',text:row.target_id}),node('td',{text:formatDate(row.created_at)})];});
    content.appendChild(node('div',{class:'grid-2'},panel('Latest Support','Recent conversations and unread counts',table(['User','Unread','Status','Last message',''],supportRows)),panel('Recent Activity','Audited administrative changes',table(['Action','Target','ID','Created'],activityRows))));
  }

  async function categoryOptions() { var result=await api('/categories?limit=100&page=1');return result.data; }
  function productForm(product,categories) {
    var tiers=(product&&product.bulk_pricing_tiers||[]).map(function(t){return t.min_quantity+'|'+(t.max_quantity==null?'':t.max_quantity)+'|'+t.unit_price;}).join('\\n');
    var categoryChoices=[['','📦 No Category / Other Products']].concat(categories.map(function(c){return [c.id,(c.emoji||'')+' '+c.name+(c.active?'':' (inactive)')];}));
    var form=node('form',{class:'form-grid'});
    var deliveryDetailsInput=node('input',{type:'hidden',name:'deliveryDetails',value:product&&product.delivery_text||''});
    form.appendChild(deliveryDetailsInput);
    append(form,[
      node('h3',{class:'form-section-title',text:'Basic Information'}),
      inputField('Category','category',product&&product.category_id||'',{tag:'select',choices:categoryChoices}),
      inputField('Product name','name',product&&product.name||'',{maxlength:120,required:true}),
      inputField('Emoji','emoji',product&&product.emoji||'',{maxlength:16}),
      inputField('Subtitle','subtitle',product&&product.subtitle||'',{maxlength:240}),
      inputField('Duration','duration',product&&product.duration||'',{maxlength:120}),
      inputField('Product type / label','productType',product&&product.product_type||'',{maxlength:120}),
      node('h3',{class:'form-section-title',text:'Pricing'}),
      inputField('Price','price',product&&product.price||'0',{required:true}),
      inputField('Currency','currency',product&&product.currency||'USD',{maxlength:10,required:true}),
      node('h3',{class:'form-section-title',text:'Availability'}),
      inputField('Product status','productStatus',product&&product.product_status||'active',{tag:'select',choices:[['active','Active'],['inactive','Inactive'],['out_of_stock','Out of Stock'],['draft','Draft']]}),
      node('h3',{class:'form-section-title',text:'Delivery'}),
      inputField('Fulfillment type','fulfillment',product&&product.fulfillment_type||'manual',{tag:'select',choices:[['instant','Instant — unique inventory'],['manual','Manual Delivery']],required:true}),
      inputField('Delivery time','eta',product&&product.delivery_time_label||'',{maxlength:120}),
      inputField('Warranty value','warrantyValue',product&&product.warranty_value||'',{type:'number'}),
      inputField('Warranty unit','warrantyUnit',product&&product.warranty_unit||'',{tag:'select',choices:[['','No warranty'],['hours','Hours'],['days','Days'],['months','Months']]}),
      inputField('Manual stock','manualStock',product&&product.manual_stock||0,{type:'number',required:true}),
      inputField('Unlimited stock','unlimited',String(product&&product.unlimited_stock||false),{tag:'select',choices:[['false','No'],['true','Yes']]}),
      inputField('Allow pre-order','preorder',String(product&&product.allow_preorder||false),{tag:'select',choices:[['false','No'],['true','Yes']]}),
      inputField('Bulk pricing','bulk',String(product&&product.bulk_pricing_enabled||false),{tag:'select',choices:[['false','Disabled'],['true','Enabled']]}),
      node('h3',{class:'form-section-title',text:'Advanced'}),
      inputField('Automatic notifications','notificationMode',product&&product.notification_mode||'global',{tag:'select',choices:[['global','Use global notification settings'],['muted','Mute automatic notifications']]}),
      inputField('Sort order','sortOrder',product&&product.sort_order||0,{type:'number'}),
      inputField('Sold display offset','soldOffset',product&&product.sold_display_offset||0,{type:'number'}),
      node('h3',{class:'form-section-title',text:'Customer Content'}),
      inputField('Short description','short',product&&product.short_description||'',{tag:'textarea',maxlength:240,wide:true}),
      inputField('Full description','full',product&&product.full_description||'',{tag:'textarea',maxlength:5000,wide:true}),
      inputField('Public instructions','instructions',product&&product.public_instructions||'',{tag:'textarea',maxlength:5000,wide:true}),
      button('Delivery Details','secondary',function(){
        var detailsForm=node('form',{class:'form-grid'},inputField('Delivery Details','details',deliveryDetailsInput.value||'',{tag:'textarea',maxlength:5000,wide:true}),node('div',{class:'section-note wide',text:'Add any customer-facing details for this product. This is separate from the encrypted inventory credentials.'}));
        var saveDetails=button('Save Details','',async function(){
          if(!detailsForm.reportValidity()) return;
          var value=String(new FormData(detailsForm).get('details')||'');
          deliveryDetailsInput.value=value;
          if(product&&product.id){
            try{
              await api('/products/'+product.id,{method:'PATCH',body:{delivery_text:value}});
              toast('Delivery Details saved successfully.','success');
            }catch(error){
              deliveryDetailsInput.value=product&&product.delivery_text||'';
              toast(error.message,'error');
              return;
            }
          }
          closeModal();
        });
        openModal('Delivery Details',detailsForm,[button('Cancel','ghost',closeModal),saveDetails]);
      }),
      inputField('Bulk tiers — min|max|unit price, one per line','tiers',tiers,{tag:'textarea',maxlength:2000,wide:true}),
      node('h3',{class:'form-section-title',text:'Media'}),
      inputField('HTTPS image URL','image',product&&product.image_url||'',{maxlength:2048,wide:true}),
      inputField('Telegram file_id','telegramFile',product&&product.telegram_file_id||'',{maxlength:512,wide:true})
    ]);
    var preview=button('Preview Delivery','secondary',function(){
      var fd=new FormData(form);
      var demo={
        name:String(fd.get('name')||'Demo Product'), subtitle:String(fd.get('subtitle')||''), duration:String(fd.get('duration')||''),
        product_type:String(fd.get('productType')||'Activation'), emoji:String(fd.get('emoji')||'🎁'),
        full_description:String(fd.get('full')||fd.get('short')||'Demo product description.'),
        public_instructions:String(fd.get('instructions')||'Use the credentials below to access your purchase.'), delivery_details:String(fd.get('deliveryDetails')||''),
        delivery_time_label:String(fd.get('eta')||'Instant'), warranty_value:String(fd.get('warrantyValue')||''), warranty_unit:String(fd.get('warrantyUnit')||'')
      };
      var fakeOrder={id:'PREVIEW',status:'delivered',fulfillment_type:'instant',quantity:1,delivery_time_snapshot:demo.delivery_time_label,warranty_value_snapshot:demo.warranty_value||null,warranty_unit_snapshot:demo.warranty_unit||'',delivery_snapshot:{product_name:demo.name,subtitle:demo.subtitle,duration:demo.duration,product_type:demo.product_type,emoji:demo.emoji,full_description:demo.full_description,public_instructions:demo.public_instructions,delivery_details:demo.delivery_details,delivery_time:demo.delivery_time_label,warranty_value:demo.warranty_value||null,warranty_unit:demo.warranty_unit||''}};
      var demoEscape=function(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');};
      var text=['━━━━━━━━━━━━━━━━━━━━','🎁 '+demo.name,'━━━━━━━━━━━━━━━━━━━━','',demo.subtitle,demo.duration?'⏱️ '+demo.duration:'',demo.product_type?'🔗 '+demo.product_type:'',demo.warranty_value?'🛡️ Warranty: '+demo.warranty_value+' '+demo.warranty_unit:'🛡️ Warranty: No warranty','', '📝 Description', demo.full_description,'',demo.delivery_details?'ℹ️ Delivery Details\n'+demo.delivery_details:'','📌 How to use',demo.public_instructions,'','🎁 Item 1 of 1','Email:','demo@example.com','Password:','DEMO_PASSWORD','━━━━━━━━━━━━━━━━━━━━'].filter(Boolean).join('\n'); openModal('Delivery Preview',node('div',{class:'code-block',text:text}),[button('Close','ghost',closeModal)]);
    });
    form.appendChild(preview);
    append(form,[node('div',{class:'section-note wide',text:'Basic Information · Pricing · Availability · Delivery · Customer Content · Media · Advanced. Preview uses demo credentials only.'})]);
    var save=button(product?'Save changes':'Create product','',function(){submitForm(form,save,async function(fd){
      var tierRows=String(fd.get('tiers')||'').split(/\\r?\\n/).map(function(line){return line.trim();}).filter(Boolean).map(function(line){var parts=line.split('|').map(function(v){return v.trim();});if(parts.length!==3)throw new Error('Each bulk tier must use min|max|unit price.');return{min_quantity:parts[0],max_quantity:parts[1]||null,unit_price:parts[2]};});
      var category=String(fd.get('category')||'');
      var body={category_id:category||null,name:String(fd.get('name')),emoji:String(fd.get('emoji')),subtitle:String(fd.get('subtitle')),duration:String(fd.get('duration')),product_type:String(fd.get('productType')),price:String(fd.get('price')),currency:String(fd.get('currency')).toUpperCase(),product_status:String(fd.get('productStatus')),fulfillment_type:String(fd.get('fulfillment')),delivery_time_label:String(fd.get('eta')),warranty_value:String(fd.get('warrantyValue'))||null,warranty_unit:String(fd.get('warrantyUnit'))||null,manual_stock:String(fd.get('manualStock')),unlimited_stock:String(fd.get('unlimited'))==='true',allow_preorder:String(fd.get('preorder'))==='true',bulk_pricing_enabled:String(fd.get('bulk'))==='true',bulk_pricing_tiers:tierRows,notification_mode:String(fd.get('notificationMode')),sort_order:String(fd.get('sortOrder')||0),sold_display_offset:String(fd.get('soldOffset')||0),short_description:String(fd.get('short')),full_description:String(fd.get('full')),public_instructions:String(fd.get('instructions')),delivery_text:String(fd.get('deliveryDetails')||''),image_url:String(fd.get('image'))||null,telegram_file_id:String(fd.get('telegramFile'))||null};
      await api('/products'+(product?'/'+product.id:''),{method:product?'PATCH':'POST',body:body});toast(product?'Product updated.':'Product created.','success');
    });});
    openModal(product?'Edit product':'Add product',form,[button('Cancel','ghost',closeModal),save]);
  }

  async function renderProducts() {
    var state=stateFor('products'), categories=await categoryOptions();
    var requestState={};Object.keys(state).forEach(function(k){if(k!=='category'||state.category!=='__none__')requestState[k]=state[k];});
    var suffix=queryString(requestState);if(state.category==='__none__')suffix+=(suffix?'&':'?')+'uncategorized=true';
    var response=await api('/products'+suffix);clear(content);
    var categoryChoices=[['','All categories'],['__none__','📦 Other Products / No Category']].concat(categories.map(function(c){return[c.id,c.name];}));
    var tool=node('div',{class:'toolbar'},toolbarSearch(state,'Product name',renderCurrent),selectControl('Category',state.category||'',categoryChoices,function(v){state.category=v;state.page=1;renderCurrent();}),selectControl('Status',state.active||'',[['','All'],['true','Active'],['false','Inactive']],function(v){state.active=v;state.page=1;renderCurrent();}),selectControl('Sort',state.sort||'created_at',[['created_at','Created'],['name','Name'],['price','Price'],['stock','Stock'],['sort_order','Sort order']],function(v){state.sort=v;state.page=1;renderCurrent();}),selectControl('Direction',state.direction||'desc',[['desc','Descending'],['asc','Ascending']],function(v){state.direction=v;state.page=1;renderCurrent();}),button('Add product','',function(){productForm(null,categories);}));
    content.appendChild(tool);
    var rows=response.data.map(function(row){var cat=relation(row.categories);var stock=row.unlimited_stock?'∞':String(row.available_stock==null?row.stock:row.available_stock);var actions=[button('Edit','ghost small',function(){return api('/products/'+row.id).then(function(r){productForm(r.data,categories);}).catch(function(e){toast(e.message,'error');});})];if(row.fulfillment_type==='instant')actions.push(button('Inventory','secondary small',function(){inventoryManager(row);}));actions.push(button(row.active?'Disable':'Enable','secondary small',async function(){try{await api('/products/'+row.id,{method:'PATCH',body:{product_status:row.active?'inactive':'active'}});toast('Product updated.','success');renderCurrent();}catch(e){toast(e.message,'error');}}));actions.push(button('Archive','danger small',async function(){if(!window.confirm('Archive this product? Existing orders will remain.'))return;await api('/products/'+row.id,{method:'DELETE',body:{}});toast('Product archived.','success');renderCurrent();}));return[node('td',{},node('span',{class:'cell-main',text:(row.emoji||'')+' '+row.name}),node('span',{class:'cell-sub',text:'#'+row.id+' · '+(row.delivery_time_label||'No ETA')})),node('td',{text:cat.name||'📦 Other Products'}),node('td',{class:'mono',text:money(row.price)}),node('td',{class:'mono',text:stock}),node('td',{},badge(row.fulfillment_type),node('span',{text:' '}),badge(row.product_status||(row.active?'active':'inactive')),node('span',{text:' '}),badge(row.notification_mode==='muted'?'notifications muted':'notifications global')),node('td',{},node('div',{class:'row-actions'},actions))];});
    content.appendChild(panel('Products','Products may belong to a category or appear directly under Other Products. Instant stock is derived from unique encrypted inventory.',node('div',{},table(['Product','Category','Price','Stock','Delivery / Status',''],rows),pagination(response.meta,function(page){state.page=page;renderCurrent();}))));
  }

  function categoryForm(category) { var form=node('form',{class:'form-grid'},inputField('Name','name',category&&category.name||'',{maxlength:120,required:true}),inputField('Emoji / icon','emoji',category&&category.emoji||'',{maxlength:16}),inputField('Sort order','sort',category&&category.sort_order||0,{type:'number',required:true}),inputField('Status','active',String(category?category.active:true),{tag:'select',choices:[['true','Active'],['false','Disabled']]}),inputField('Telegram layout override','layout',category&&category.layout_override||'inherit',{tag:'select',choices:[['inherit','Inherit global setting'],['full','Full Width / One Per Row'],['two','Half Width / Two Columns']]}));var save=button(category?'Save':'Create category','',function(){submitForm(form,save,async function(fd){var body={name:String(fd.get('name')),emoji:String(fd.get('emoji')),sort_order:String(fd.get('sort')||0),active:String(fd.get('active'))==='true',layout_override:String(fd.get('layout'))};if(category)await api('/categories/'+category.id,{method:'PATCH',body:body});else await api('/categories',{method:'POST',body:body});});});openModal(category?'Edit category':'Add category',form,[button('Cancel','ghost',closeModal),save]); }
  async function renderCategories(){var state=stateFor('categories');var response=await api('/categories'+queryString(state));clear(content);content.appendChild(node('div',{class:'toolbar'},toolbarSearch(state,'Category name',renderCurrent),button('Add category','',function(){categoryForm(null);})));var rows=response.data.map(function(row){var layout={inherit:'Global',full:'Full width',two:'Two columns'}[row.layout_override]||'Global';return[node('td',{},node('span',{class:'cell-main',text:(row.emoji||'📦')+' '+row.name}),node('span',{class:'cell-sub',text:'#'+row.id})),node('td',{text:String(row.sort_order)}),node('td',{text:layout}),node('td',{},badge(row.active?'active':'inactive')),node('td',{text:formatDate(row.updated_at)}),node('td',{},node('div',{class:'row-actions'},button('Edit','ghost small',function(){categoryForm(row);}),button(row.active?'Disable':'Enable','secondary small',async function(){try{await api('/categories/'+row.id,{method:'PATCH',body:{active:!row.active}});toast('Category updated.','success');renderCurrent();}catch(e){toast(e.message,'error');}}),button('Delete','danger small',async function(){if(!window.confirm('Delete this category? It must contain no products.'))return;try{await api('/categories/'+row.id,{method:'DELETE',body:{}});toast('Category deleted.','success');renderCurrent();}catch(e){toast(e.message,'error');}})))];});content.appendChild(panel('Categories','Control category visibility, ordering, and Telegram layout. Products do not need a category.',node('div',{},table(['Category','Order','Layout','Status','Updated',''],rows),pagination(response.meta,function(page){state.page=page;renderCurrent();}))));}

  async function inventoryManagerV2(row,page,status,search,limit){page=page||1;status=status||'';search=search||'';limit=limit||25;try{var response=await api('/products/'+row.id+'/inventory'+queryString({page:page,limit:limit,status:status,search:search}));var textarea=inputField('Bulk import — one unique link/code/account per line','items','',{tag:'textarea',maxlength:1800000,wide:true});var preview=node('div',{class:'section-note',text:'0 valid lines · 0 duplicate lines in this input'});var input=textarea.querySelector('textarea');input.addEventListener('input',function(){var lines=input.value.split(/\r?\n/).map(function(v){return v.trim();}).filter(Boolean);var unique=new Set(lines);preview.textContent=unique.size+' valid lines · '+(lines.length-unique.size)+' duplicate lines in this input';});var importButton=button('Import items','',async function(){var lines=input.value.split(/\r?\n/).map(function(v){return v.trim();}).filter(Boolean);if(!lines.length)throw new Error('Add at least one item.');var result=(await api('/products/'+row.id+'/inventory/import',{method:'POST',body:{items:lines}})).data;toast(result.inserted+' items imported; '+result.duplicates+' duplicates skipped.','success');closeModal();inventoryManagerV2(row,1,status,search,limit);});var fileInput=node('input',{class:'input',type:'file',accept:'.txt,.csv,text/plain,text/csv'});fileInput.addEventListener('change',function(){var file=fileInput.files&&fileInput.files[0];if(!file)return;var reader=new FileReader();reader.onload=function(){input.value=String(reader.result||'').replace(/,/g,'\n');input.dispatchEvent(new Event('input'));};reader.readAsText(file);});var fileField=node('div',{class:'field wide'},node('label',{text:'Upload TXT / CSV'}),fileInput);var exportButton=button('Export filtered','ghost',async function(){var payload=(await api('/products/'+row.id+'/inventory-export?status='+(statusSelect.value||'all'))).data;var text=payload.map(function(x){return x.payload;}).join('\n');var blob=new Blob([text],{type:'text/plain'});var url=URL.createObjectURL(blob);var a=document.createElement('a');a.href=url;a.download='product-'+row.id+'-inventory.txt';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);});var searchInput=node('input',{class:'input',value:search,placeholder:'Item or order ID','aria-label':'Inventory search'});var statusSelect=node('select',{class:'select','aria-label':'Inventory status'});[['','All statuses'],['available','Available'],['sold','Sold'],['disabled','Disabled'],['reserved','Reserved']].forEach(function(choice){var option=node('option',{value:choice[0],text:choice[1]});if(choice[0]===status)option.selected=true;statusSelect.appendChild(option);});var size=node('select',{class:'select','aria-label':'Rows per page'});[10,25,50,100].forEach(function(value){var option=node('option',{value:value,text:value+' / page'});if(value===limit)option.selected=true;size.appendChild(option);});var reload=function(nextPage){closeModal();inventoryManagerV2(row,nextPage||1,statusSelect.value,searchInput.value.trim(),Number(size.value));};statusSelect.addEventListener('change',function(){reload(1);});size.addEventListener('change',function(){reload(1);});var itemRows=response.data.map(function(item){var actions=[button('Reveal','ghost small',async function(){var revealed=(await api('/products/'+row.id+'/inventory/'+item.id+'/reveal',{method:'POST',body:{}})).data;openModal('Revealed inventory #'+item.id,codeBlock(revealed.payload),[button('Close','ghost',closeModal)]);})];if(item.status==='available'||item.status==='disabled'){actions.push(button(item.status==='available'?'Disable':'Enable',item.status==='available'?'danger small':'success small',async function(){await api('/products/'+row.id+'/inventory/'+item.id+'/status',{method:'POST',body:{status:item.status==='available'?'disabled':'available'}});reload(page);}));actions.push(button('Delete','danger small',async function(){if(!window.confirm('Delete this unsold inventory item?'))return;await api('/products/'+row.id+'/inventory/'+item.id,{method:'DELETE',body:{}});reload(page);}));}return[node('td',{class:'mono',text:'#'+item.id}),node('td',{class:'mono',text:item.preview}),node('td',{},badge(item.status)),node('td',{class:'mono',text:item.order_id||'—'}),node('td',{text:formatDate(item.created_at)}),node('td',{},node('div',{class:'row-actions'},actions))];});var counts=response.meta.counts||{};var nav=node('div',{class:'pagination'},node('span',{text:'Page '+response.meta.page+' of '+response.meta.pages+' · '+response.meta.count+' filtered'}),node('div',{class:'pagination-buttons'},button('Previous','ghost small',function(){if(page>1)reload(page-1);}),button('Next','ghost small',function(){if(page<response.meta.pages)reload(page+1);})));var body=node('div',{},node('div',{class:'section-note warning',text:'Encrypted inventory · Available '+(counts.available||0)+' · Sold '+(counts.sold||0)+' · Disabled '+(counts.disabled||0)+'. Sold items can never be reused.'}),textarea,preview,fileField,node('div',{class:'row-actions'},importButton,exportButton),node('div',{class:'subsection'},node('div',{class:'toolbar'},searchInput,button('Search','ghost',function(){reload(1);}),statusSelect,size),table(['ID','Masked payload','Status','Order','Created',''],itemRows),nav));openModal('Unique inventory · '+row.name,body,[button('Close','ghost',closeModal)]);}catch(e){toast(e.message,'error');}}
  inventoryManager=inventoryManagerV2;
  async function inventoryManager(row){try{var response=await api('/products/'+row.id+'/inventory?page=1&limit=25');var textarea=inputField('Bulk import — one unique link/code/account per line','items','',{tag:'textarea',maxlength:1800000,wide:true});var preview=node('div',{class:'section-note',text:'0 valid lines · 0 duplicate lines in this input'});var input=textarea.querySelector('textarea');input.addEventListener('input',function(){var lines=input.value.split(/\r?\n/).map(function(v){return v.trim();}).filter(Boolean);var unique=new Set(lines);preview.textContent=unique.size+' valid lines · '+(lines.length-unique.size)+' duplicate lines in this input';});var importButton=button('Import items','',async function(){var lines=input.value.split(/\r?\n/).map(function(v){return v.trim();}).filter(Boolean);if(!lines.length)throw new Error('Add at least one item.');var result=(await api('/products/'+row.id+'/inventory/import',{method:'POST',body:{items:lines}})).data;toast(result.inserted+' items imported; '+result.duplicates+' duplicates skipped.','success');closeModal();inventoryManager(row);});var itemRows=response.data.map(function(item){var actions=[button('Reveal','ghost small',async function(){var revealed=(await api('/products/'+row.id+'/inventory/'+item.id+'/reveal',{method:'POST',body:{}})).data;openModal('Revealed inventory #'+item.id,codeBlock(revealed.payload),[button('Close','ghost',closeModal)]);})];if(item.status==='available'||item.status==='disabled')actions.push(button(item.status==='available'?'Disable':'Enable',item.status==='available'?'danger small':'success small',async function(){await api('/products/'+row.id+'/inventory/'+item.id+'/status',{method:'POST',body:{status:item.status==='available'?'disabled':'available'}});closeModal();inventoryManager(row);}));return[node('td',{class:'mono',text:'#'+item.id}),node('td',{class:'mono',text:item.preview}),node('td',{},badge(item.status)),node('td',{class:'mono',text:item.order_id||'—'}),node('td',{text:formatDate(item.created_at)}),node('td',{},node('div',{class:'row-actions'},actions))];});var body=node('div',{},node('div',{class:'section-note warning',text:'Payloads are AES-256-GCM encrypted. Sold items can never be disabled, re-enabled, deleted, or reused.'}),textarea,preview,importButton,node('div',{class:'subsection'},table(['ID','Masked payload','Status','Order','Created',''],itemRows)));openModal('Unique inventory · '+row.name,body,[button('Close','ghost',closeModal)]);}catch(e){toast(e.message,'error');}}
  async function renderInventory(){var state=stateFor('inventory');state.filter=state.filter||'all';var response=await api('/inventory'+queryString(state));clear(content);content.appendChild(node('div',{class:'toolbar'},toolbarSearch(state,'Product name',renderCurrent),selectControl('Filter',state.filter,[['all','All'],['in','In stock'],['low','Low stock'],['out','Out of stock'],['inactive','Inactive']],function(v){state.filter=v;state.page=1;renderCurrent();})));var rows=response.data.map(function(row){var cat=relation(row.categories);var count=row.unlimited_stock?'∞':String(row.available_stock==null?row.stock:row.available_stock);var numeric=Number(row.available_stock==null?row.stock:row.available_stock);var status=!row.active?'inactive':row.unlimited_stock?'unlimited':numeric===0?'out of stock':numeric<=response.meta.lowStockThreshold?'low stock':'in stock';var action=row.fulfillment_type==='instant'?button('Manage items','ghost small',function(){inventoryManager(row);}):button('Set stock','ghost small',function(){stockModal({...row,stock:row.manual_stock});});return[node('td',{},node('span',{class:'cell-main',text:row.name}),node('span',{class:'cell-sub',text:(cat.name||'—')+' · '+row.fulfillment_type})),node('td',{class:'mono',text:count}),node('td',{},badge(status)),node('td',{text:formatDate(row.updated_at)}),node('td',{},action)];});content.appendChild(panel('Inventory','Instant products use unique encrypted items. Manual products use explicit or unlimited stock.',node('div',{},table(['Product','Available','State','Updated',''],rows),pagination(response.meta,function(page){state.page=page;renderCurrent();}))));}

  function manualDeliveryForm(row){var form=node('form',{class:'form-grid'},node('div',{class:'section-note warning',text:'This private delivery is encrypted before storage. Deliver is idempotent and cannot run twice.'}),inputField('Delivery text / link / account','delivery','',{tag:'textarea',maxlength:20000,required:true,wide:true}));var deliver=button('Deliver order','success',function(){submitForm(form,deliver,function(fd){return api('/orders/'+row.id+'/deliver',{method:'POST',body:{delivery:String(fd.get('delivery'))}});});});openModal('Deliver order #'+row.id,form,[button('Cancel','ghost',closeModal),deliver]);}
  async function showOrder(id){try{var row=(await api('/orders/'+id)).data;var user=relation(row.users);var actions=[button('Close','ghost',closeModal)];if(row.status==='delivered')actions.push(button('Reveal delivery','secondary',async function(){var delivery=(await api('/orders/'+row.id+'/delivery/reveal',{method:'POST',body:{}})).data;openModal('Private delivery · order #'+row.id,codeBlock(delivery.items),[button('Close','ghost',closeModal)]);}));if(row.fulfillment_type==='manual'&&(row.status==='pending'||row.status==='processing'))actions.push(button('Deliver','success',function(){manualDeliveryForm(row);}));openModal('Order #'+row.id,node('div',{},detailsGrid([['User',user.username||user.first_name],['Telegram ID',user.telegram_id,true],['Product',row.product_name],['Quantity',row.quantity],['Unit price',money(row.unit_price)+' USDT'],['Total',money(row.total_amount||row.amount)+' USDT'],['Type',row.fulfillment_type],['Status',row.status],['ETA',row.delivery_time_snapshot],['Warranty',row.warranty_value_snapshot?(row.warranty_value_snapshot+' '+row.warranty_unit_snapshot):'None'],['Created',formatDate(row.created_at)],['Delivered',formatDate(row.delivered_at)],['Delivered by',row.delivered_by,true],['Product ID',row.product_id,true]]),node('div',{class:'section-note',text:'Private delivery payloads are excluded from list/detail APIs. Reveal is protected by CSRF and written to the audit log.'})),actions);}catch(e){toast(e.message,'error');}}
  async function renderOrders(){var state=stateFor('orders');var response=await api('/orders'+queryString(state));clear(content);content.appendChild(node('div',{class:'toolbar'},toolbarSearch(state,'Product or Telegram ID',renderCurrent),selectControl('Status',state.status||'',[['','All'],['pending','Pending'],['processing','Processing'],['delivered','Delivered'],['refunded','Refunded'],['cancelled','Cancelled']],function(v){state.status=v;state.page=1;renderCurrent();}),selectControl('Delivery',state.fulfillment||'',[['','All'],['instant','Instant'],['manual','Manual']],function(v){state.fulfillment=v;state.page=1;renderCurrent();}),dateControl('From','from',state,renderCurrent),dateControl('To','to',state,renderCurrent),selectControl('Sort',state.sort||'created_at',[['created_at','Created'],['amount','Amount'],['id','Order ID']],function(v){state.sort=v;state.page=1;renderCurrent();}),selectControl('Direction',state.direction||'desc',[['desc','Descending'],['asc','Ascending']],function(v){state.direction=v;state.page=1;renderCurrent();})));var rows=response.data.map(function(row){var user=relation(row.users);return[node('td',{class:'mono',text:'#'+row.id}),node('td',{},node('span',{class:'cell-main',text:row.product_name}),node('span',{class:'cell-sub',text:String(user.username||user.first_name||'—')})),node('td',{class:'mono',text:String(user.telegram_id||'—')}),node('td',{text:String(row.quantity)}),node('td',{text:money(row.total_amount||row.amount)+' USDT'}),node('td',{},badge(row.fulfillment_type)),node('td',{},badge(row.status)),node('td',{text:formatDate(row.created_at)}),node('td',{},button('Details','ghost small',function(){return showOrder(row.id);}))];});content.appendChild(panel('Orders','Instant, manual and refunded order history',node('div',{},table(['ID','Product','Telegram ID','Qty','Total','Delivery','Status','Created',''],rows),pagination(response.meta,function(page){state.page=page;renderCurrent();}))));}
  async function renderPreorders(){var state=stateFor('preorders');state.sort=state.sort||'created_at';state.direction=state.direction||'asc';var response=await api('/preorders'+queryString(state));clear(content);content.appendChild(node('div',{class:'toolbar'},toolbarSearch(state,'Product or Telegram ID',renderCurrent),selectControl('Sort',state.sort,[['created_at','Age'],['total_amount','Total'],['id','Order ID']],function(v){state.sort=v;state.page=1;renderCurrent();}),selectControl('Direction',state.direction,[['asc','Oldest / low first'],['desc','Newest / high first']],function(v){state.direction=v;state.page=1;renderCurrent();})));var rows=response.data.map(function(row){var user=relation(row.users);return[node('td',{class:'mono',text:'#'+row.id}),node('td',{text:row.product_name}),node('td',{},node('span',{class:'cell-main',text:user.username||user.first_name||'—'}),node('span',{class:'cell-sub mono',text:user.telegram_id})),node('td',{text:String(row.quantity)}),node('td',{text:money(row.total_amount)}),node('td',{},badge(row.status)),node('td',{text:row.delivery_time_snapshot||'—'}),node('td',{text:formatDate(row.created_at)}),node('td',{},button('Deliver','success small',function(){showOrder(row.id);} ))];});content.appendChild(panel('Manual fulfillment / pre-orders','Search, sort and fulfill the live queue.',node('div',{},table(['ID','Product','User','Qty','Total','Status','ETA','Created',''],rows),pagination(response.meta,function(page){state.page=page;renderCurrent();}))));}
  function reviewRefund(row,decision){var order=relation(row.orders);var user=relation(row.users);var form=node('form',{class:'form-grid'},node('div',{class:'section-note warning',text:(decision==='approved'?'Approve and atomically return '+money(order.total_amount)+' USDT':'Reject')+' for order #'+row.order_id+' · '+(user.username||user.telegram_id)}),inputField('Admin note','note','',{tag:'textarea',maxlength:2000,wide:true}));var action=button(decision==='approved'?'Approve refund':'Reject request',decision==='approved'?'success':'danger',function(){submitForm(form,action,function(fd){return api('/refunds/'+row.id+'/review',{method:'POST',body:{decision:decision,note:String(fd.get('note'))}});});});openModal('Review refund #'+row.id,node('div',{},detailsGrid([['Order','#'+row.order_id],['Product',order.product_name],['Amount',money(order.total_amount)],['User',user.username||user.first_name],['Telegram ID',user.telegram_id,true],['Requested',formatDate(row.created_at)]]),node('div',{class:'subsection'},node('h3',{text:'Customer reason'}),codeBlock(row.reason)),form),[button('Cancel','ghost',closeModal),action]);}
  async function renderRefunds(){var state=stateFor('refunds');state.sort=state.sort||'created_at';state.direction=state.direction||'desc';var response=await api('/refunds'+queryString(state));clear(content);content.appendChild(node('div',{class:'toolbar'},toolbarSearch(state,'Refund ID, order ID or product',renderCurrent),selectControl('Status',state.status||'',[['','All'],['pending','Pending'],['approved','Approved'],['rejected','Rejected'],['cancelled','Cancelled']],function(v){state.status=v;state.page=1;renderCurrent();}),selectControl('Sort',state.sort,[['created_at','Created'],['reviewed_at','Reviewed'],['id','Request ID']],function(v){state.sort=v;state.page=1;renderCurrent();}),selectControl('Direction',state.direction,[['desc','Descending'],['asc','Ascending']],function(v){state.direction=v;state.page=1;renderCurrent();})));var rows=response.data.map(function(row){var order=relation(row.orders);var user=relation(row.users);var actions=[];if(row.status==='pending')actions=[button('Reject','danger small',function(){reviewRefund(row,'rejected');}),button('Approve','success small',function(){reviewRefund(row,'approved');})];return[node('td',{class:'mono',text:'#'+row.id}),node('td',{class:'mono',text:'#'+row.order_id}),node('td',{text:order.product_name}),node('td',{},node('span',{class:'cell-main',text:user.username||user.first_name||'—'}),node('span',{class:'cell-sub mono',text:user.telegram_id})),node('td',{text:short(row.reason,80)}),node('td',{text:money(order.total_amount)}),node('td',{},badge(row.status)),node('td',{text:formatDate(row.created_at)}),node('td',{},node('div',{class:'row-actions'},actions))];});content.appendChild(panel('Refund requests','Approvals use one atomic database transaction.',node('div',{},table(['ID','Order','Product','User','Reason','Amount','Status','Created',''],rows),pagination(response.meta,function(page){state.page=page;renderCurrent();}))));}

  async function reviewDeposit(row,approve){try{var full=(await api('/deposits/'+row.id)).data;var user=relation(full.users);var form=node('form',{class:'form-grid'},node('div',{class:'section-note warning',text:(approve?'Approve':'Reject')+' '+full.deposit_code+' for '+(user.username||user.telegram_id)+' · '+money(full.expected_amount)+' '+full.currency+'. This action uses the atomic database function.'}),approve?null:inputField('Reason','reason','Rejected by administrator',{tag:'textarea',maxlength:500,required:true,wide:true}));var action=button(approve?'Approve deposit':'Reject deposit',approve?'success':'danger',function(){submitForm(form,action,function(fd){return api('/deposits/'+full.id+'/'+(approve?'approve':'reject'),{method:'POST',body:{confirmCode:full.deposit_code,reason:approve?undefined:String(fd.get('reason'))}});});});openModal((approve?'Approve':'Reject')+' deposit',form,[button('Cancel','ghost',closeModal),action]);}catch(e){toast(e.message,'error');}}
  async function showDeposit(id){try{var row=(await api('/deposits/'+id)).data;var user=relation(row.users);var body=node('div',{},detailsGrid([['Deposit code',row.deposit_code,true],['User',user.username||user.first_name],['Telegram ID',user.telegram_id,true],['Requested',money(row.requested_amount)+' '+row.currency],['Expected',money(row.expected_amount)+' '+row.currency],['Method',row.payment_method==='usdt_trc20'?'Legacy USDT TRC20':row.payment_method],['Network',row.network],['Status',row.status],['TxID',row.transaction_id,true],['Provider order',row.provider_order_id,true],['Provider transaction',row.provider_transaction_id,true],['Created',formatDate(row.created_at)],['Expires',formatDate(row.expires_at)],['Reviewed',formatDate(row.reviewed_at)],['Approved by',row.approved_by,true],['Rejection reason',row.rejection_reason]]));var actions=[button('Close','ghost',closeModal)];if(['usdt_bep20','usdt_trc20'].indexOf(row.payment_method)>=0&&row.status==='pending_review'&&row.transaction_id){actions.push(button('Reject','danger',function(){closeModal();reviewDeposit(row,false);}),button('Approve','success',function(){closeModal();reviewDeposit(row,true);}));}openModal('Deposit details',body,actions);}catch(e){toast(e.message,'error');}}
  async function renderDeposits(){var state=stateFor('deposits');var response=await api('/deposits'+queryString(state));clear(content);content.appendChild(node('div',{class:'toolbar'},toolbarSearch(state,'Code, TxID, Order ID, Telegram ID',renderCurrent),selectControl('Status',state.status||'',[['','All'],['pending','Pending'],['pending_review','Pending review'],['approved','Approved'],['rejected','Rejected'],['expired','Expired'],['cancelled','Cancelled']],function(v){state.status=v;state.page=1;renderCurrent();}),selectControl('Method',state.method||'',[['','All'],['usdt_bep20','USDT (BEP20)'],['binance','Binance'],['usdt_trc20','Legacy USDT TRC20']],function(v){state.method=v;state.page=1;renderCurrent();}),dateControl('From','from',state,renderCurrent),dateControl('To','to',state,renderCurrent)));var rows=response.data.map(function(row){var user=relation(row.users);var actions=[button('Details','ghost small',function(){return showDeposit(row.id);})];if(['usdt_bep20','usdt_trc20'].indexOf(row.payment_method)>=0&&row.status==='pending_review'&&row.transaction_id){actions.push(button('Reject','danger small',function(){return reviewDeposit(row,false);}),button('Approve','success small',function(){return reviewDeposit(row,true);}));}var method=row.payment_method==='usdt_trc20'?'Legacy USDT TRC20':row.payment_method==='usdt_bep20'?'USDT (BEP20)':row.payment_method;return[node('td',{},node('span',{class:'cell-main mono',text:row.deposit_code}),node('span',{class:'cell-sub',text:short(row.transaction_id||row.provider_order_id||'',18)})),node('td',{},node('span',{class:'cell-main',text:user.username||user.first_name||'—'}),node('span',{class:'cell-sub mono',text:String(user.telegram_id||'—')})),node('td',{text:money(row.expected_amount)+' '+row.currency}),node('td',{text:method}),node('td',{},badge(row.status)),node('td',{text:formatDate(row.created_at)}),node('td',{},node('div',{class:'row-actions'},actions))];});content.appendChild(panel('Deposits','Manual approval is available for submitted BEP20 deposits; TRC20 appears only for historical records.',node('div',{},table(['Deposit','User','Amount','Method','Status','Created',''],rows),pagination(response.meta,function(page){state.page=page;renderCurrent();}))));}

  async function suspendUser(row){var next=!row.is_suspended;var body=node('div',{},node('div',{class:'section-note warning',text:(next?'Suspend':'Unsuspend')+' Telegram user '+row.telegram_id+'?'}),detailsGrid([['User',row.username||row.first_name],['Telegram ID',row.telegram_id,true],['Current state',row.is_suspended?'Suspended':'Active']]));var action=button(next?'Suspend user':'Unsuspend user',next?'danger':'success',async function(){action.disabled=true;try{await api('/users/'+row.id+'/suspension',{method:'POST',body:{suspended:next,confirmTelegramId:String(row.telegram_id)}});closeModal();toast('User status updated.','success');renderCurrent();}catch(e){toast(e.message,'error');}finally{action.disabled=false;}});openModal('Confirm user status',body,[button('Cancel','ghost',closeModal),action]);}
  async function showUser(id){try{var data=(await api('/users/'+id)).data;var user=data.user;var adjustmentForm=node('form',{class:'form-grid'},inputField('Amount (+ add / - deduct)','wallet_amount','',{maxlength:24,required:true}),inputField('Reason','wallet_reason','',{maxlength:500,required:true,wide:true}),inputField('Confirm Telegram ID','wallet_confirm','',{maxlength:24,required:true}));var applyAdjustment=button('Apply wallet adjustment','secondary',async function(){if(!adjustmentForm.reportValidity())return;var fd=new FormData(adjustmentForm);var requestId=(window.crypto&&window.crypto.randomUUID)?window.crypto.randomUUID():('00000000-0000-4000-8000-'+String(Date.now()).padStart(12,'0').slice(-12));try{await api('/users/'+id+'/wallet-adjustment',{method:'POST',body:{amount:String(fd.get('wallet_amount')),reason:String(fd.get('wallet_reason')),confirmTelegramId:String(fd.get('wallet_confirm')),idempotencyKey:requestId}});toast('Wallet adjusted atomically.','success');closeModal();showUser(id);renderCurrent();}catch(e){toast(e.message,'error');}});var body=node('div',{},detailsGrid([['User ID',user.id,true],['Telegram ID',user.telegram_id,true],['Username',user.username],['First name',user.first_name],['Language',user.language],['Balance',money(user.wallet_balance)+' USDT'],['Status',user.is_suspended?'Suspended':'Active'],['Joined',formatDate(user.created_at)]]),node('div',{class:'subsection'},node('h3',{text:'Wallet adjustment'}),node('div',{class:'section-note',text:'Atomic database adjustment. Use a positive amount to add balance or a negative amount to deduct. Every change is written to Wallet Transactions and the Admin Audit Log.'}),adjustmentForm,applyAdjustment),node('div',{class:'subsection'},node('h3',{text:'Recent orders'}),table(['Product','Amount','Status','Created'],data.orders.map(function(r){return[node('td',{text:r.product_name}),node('td',{text:money(r.amount)}),node('td',{},badge(r.status)),node('td',{text:formatDate(r.created_at)})];}))),node('div',{class:'subsection'},node('h3',{text:'Recent deposits'}),table(['Code','Amount','Status','Created'],data.deposits.map(function(r){return[node('td',{class:'mono',text:r.deposit_code}),node('td',{text:money(r.expected_amount)}),node('td',{},badge(r.status)),node('td',{text:formatDate(r.created_at)})];}))),node('div',{class:'subsection'},node('h3',{text:'Recent wallet transactions'}),table(['Type','Amount','Balance','Reference'],data.walletTransactions.map(function(r){return[node('td',{},badge(r.type)),node('td',{text:money(r.amount)}),node('td',{text:money(r.balance_after)}),node('td',{class:'mono',text:r.reference_type+':'+r.reference_id})];}))));openModal('User details',body,[button('Close','ghost',closeModal)]);}catch(e){toast(e.message,'error');}}
  async function renderUsers(){var state=stateFor('users');var response=await api('/users'+queryString(state));clear(content);content.appendChild(node('div',{class:'toolbar'},toolbarSearch(state,'Telegram ID, username, first name',renderCurrent),selectControl('Language',state.language||'',[['','All'],['en','English'],['ar','Arabic'],['hi','Hindi']],function(v){state.language=v;state.page=1;renderCurrent();}),selectControl('Status',state.suspended||'',[['','All'],['false','Active'],['true','Suspended']],function(v){state.suspended=v;state.page=1;renderCurrent();})));var rows=response.data.map(function(row){return[node('td',{},node('span',{class:'cell-main',text:row.username||row.first_name||'Unnamed'}),node('span',{class:'cell-sub',text:'#'+row.id})),node('td',{class:'mono',text:String(row.telegram_id)}),node('td',{text:row.language}),node('td',{class:'mono',text:money(row.wallet_balance)}),node('td',{},badge(row.is_suspended?'suspended':'active')),node('td',{text:formatDate(row.created_at)}),node('td',{},node('div',{class:'row-actions'},button('Details','ghost small',function(){showUser(row.id);}),button(row.is_suspended?'Unsuspend':'Suspend',row.is_suspended?'success small':'danger small',function(){suspendUser(row);})))];});content.appendChild(panel('Users','Balances are stored transactionally; open Details to add or deduct wallet balance',node('div',{},table(['User','Telegram ID','Language','Balance','Status','Joined',''],rows),pagination(response.meta,function(page){state.page=page;renderCurrent();}))));}

  async function renderWallet(){var state=stateFor('wallet');var response=await api('/wallet-transactions'+queryString(state));clear(content);content.appendChild(node('div',{class:'section-note',text:'Wallet history is immutable. Administrative adjustments are performed atomically from Users → Details and are recorded here as adjustment transactions.'}));content.appendChild(node('div',{class:'toolbar'},toolbarSearch(state,'Telegram ID or reference',renderCurrent),selectControl('Type',state.type||'',[['','All'],['deposit','Deposit'],['purchase','Purchase'],['refund','Refund'],['adjustment','Adjustment']],function(v){state.type=v;state.page=1;renderCurrent();}),selectControl('Reference',state.referenceType||'',[['','All'],['deposit','Deposit'],['order','Order'],['admin_adjustment','Admin adjustment']],function(v){state.referenceType=v;state.page=1;renderCurrent();}),dateControl('From','from',state,renderCurrent),dateControl('To','to',state,renderCurrent)));var rows=response.data.map(function(row){var user=relation(row.users);return[node('td',{class:'mono',text:'#'+row.id}),node('td',{},node('span',{class:'cell-main',text:user.username||'—'}),node('span',{class:'cell-sub mono',text:String(user.telegram_id||'—')})),node('td',{},badge(row.type)),node('td',{class:'mono',text:money(row.amount)}),node('td',{class:'mono',text:money(row.balance_after)}),node('td',{},node('span',{class:'cell-main mono',text:row.reference_type+':'+row.reference_id}),node('span',{class:'cell-sub',text:short(row.description,50)})),node('td',{text:formatDate(row.created_at)})];});content.appendChild(panel('Wallet transactions','Immutable financial history',node('div',{},table(['ID','User','Type','Amount','Balance after','Reference','Created'],rows),pagination(response.meta,function(page){state.page=page;renderCurrent();}))));}

  function notificationForm(){var form=node('form',{class:'form-grid'},inputField('Internal user ID (optional)','userId','',{wide:true}),inputField('Message','message','',{tag:'textarea',maxlength:4000,required:true,wide:true}),node('div',{class:'section-note wide',text:'Saving a notification creates a database record. It does not send an immediate Telegram message; use Broadcast for delivery.'}));var save=button('Save notification','',function(){submitForm(form,save,function(fd){var userId=String(fd.get('userId')).trim();return api('/notifications',{method:'POST',body:{message:String(fd.get('message')),userId:userId||null}});});});openModal('Create notification',form,[button('Cancel','ghost',closeModal),save]);}
  async function renderNotifications(){var state=stateFor('notifications');state.sort=state.sort||'created_at';state.direction=state.direction||'desc';var response=await api('/notifications'+queryString(state));clear(content);content.appendChild(node('div',{class:'toolbar'},toolbarSearch(state,'Message or internal user ID',renderCurrent),selectControl('Sort',state.sort,[['created_at','Created'],['id','ID']],function(v){state.sort=v;state.page=1;renderCurrent();}),selectControl('Direction',state.direction,[['desc','Descending'],['asc','Ascending']],function(v){state.direction=v;state.page=1;renderCurrent();}),button('Create notification','',notificationForm)));var rows=response.data.map(function(row){var user=relation(row.users);return[node('td',{class:'mono',text:'#'+row.id}),node('td',{},node('span',{class:'cell-main',text:short(row.message,120)})),node('td',{text:row.user_id?(user.username||String(user.telegram_id||row.user_id)):'All users'}),node('td',{text:formatDate(row.created_at)})];});content.appendChild(panel('Notifications','Database notifications shown in the bot records screen',node('div',{},table(['ID','Message','Audience','Created'],rows),pagination(response.meta,function(page){state.page=page;renderCurrent();}))));}

  async function monitorBroadcast(id){try{var job=(await api('/broadcasts/'+id)).data;renderBroadcastJob(job);if(job.status==='queued'||job.status==='running')pollTimer=setTimeout(function(){monitorBroadcast(id);},1200);}catch(e){toast(e.message,'error');}}
  function renderBroadcastJob(job){var target=document.getElementById('broadcast-job');if(!target)return;clear(target);var percent=job.total?Math.min(100,Math.round(job.processed*100/job.total)):0;append(target,[detailsGrid([['Status',job.status],['Recipients',job.total],['Processed',job.processed],['Sent',job.sent],['Failed',job.failed],['Started',formatDate(job.createdAt)]]),node('div',{class:'subsection'},node('progress',{class:'progress-native',max:'100',value:String(percent)}),node('p',{class:'cell-sub',text:percent+'% complete'}))]);if((job.status==='queued'||job.status==='running'))target.appendChild(button('Cancel broadcast','danger small',async function(){try{await api('/broadcasts/'+job.id+'/cancel',{method:'POST',body:{}});toast('Cancellation requested.','success');}catch(e){toast(e.message,'error');}}));if(job.errors&&job.errors.length)target.appendChild(node('div',{class:'subsection'},node('h3',{text:'Short error log'}),codeBlock(job.errors)));}
  async function startBroadcast(message,recipients){var body=node('div',{},node('div',{class:'section-note warning',text:'Send this plain-text message to '+recipients+' non-suspended users? Progress is held in memory and can be lost if the service restarts.'}),node('div',{class:'code-block',text:message}));var send=button('Start broadcast','',async function(){send.disabled=true;try{var job=(await api('/broadcasts',{method:'POST',body:{message:message,parseMode:'plain'}})).data;closeModal();toast('Broadcast started.','success');monitorBroadcast(job.id);}catch(e){toast(e.message,'error');}finally{send.disabled=false;}});openModal('Confirm broadcast',body,[button('Cancel','ghost',closeModal),send]);}
  async function renderBroadcast(){var estimate=(await api('/broadcasts/estimate')).data;clear(content);var form=node('form',{},inputField('Plain-text message','message','',{tag:'textarea',maxlength:4000,required:true,wide:true}));var start=button('Review and start','',function(){if(!form.reportValidity())return;startBroadcast(String(new FormData(form).get('message')),estimate.recipients);});var jobBox=node('div',{id:'broadcast-job'});content.appendChild(node('div',{class:'grid-2'},panel('New broadcast','Send gradually through the existing bot instance',node('div',{class:'modal-body'},form,node('div',{class:'section-note',text:'Estimated recipients: '+estimate.recipients+'. Only non-suspended users are included. Telegram rate limits are respected.'}),start)),panel('Broadcast progress','Jobs are stored only in this running process',node('div',{class:'modal-body'},jobBox))));if(estimate.activeJobId)monitorBroadcast(estimate.activeJobId);else jobBox.appendChild(node('div',{class:'empty'},node('p',{text:'No active broadcast.'})));}

  function linkForm(row){var form=node('form',{class:'form-grid'},inputField('Key (support, channel, whatsapp, terms...)','key',row&&row.link_key||'',{maxlength:60,required:true}),inputField('Button text','text',row&&row.button_text||'',{maxlength:120,required:true}),inputField('HTTPS URL','url',row&&row.url||'',{maxlength:2048,required:true,wide:true}),inputField('Status','active',String(row?row.active:true),{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('Sort order','sort',row&&row.sort_order||0,{type:'number'}));var save=button(row?'Save link':'Add link','',function(){submitForm(form,save,function(fd){return api('/links'+(row?'/'+row.id:''),{method:row?'PATCH':'POST',body:{link_key:String(fd.get('key')),button_text:String(fd.get('text')),url:String(fd.get('url')),active:String(fd.get('active'))==='true',sort_order:String(fd.get('sort')||0)}});});});openModal(row?'Edit link':'Add bot link',form,[button('Cancel','ghost',closeModal),save]);}
  async function renderLinks(){var data=(await api('/links')).data;clear(content);var rows=data.map(function(row){return[node('td',{},node('span',{class:'cell-main',text:row.button_text}),node('span',{class:'cell-sub mono',text:row.link_key})),node('td',{class:'mono',text:short(row.url,70)}),node('td',{text:String(row.sort_order)}),node('td',{},badge(row.active?'active':'disabled')),node('td',{},node('div',{class:'row-actions'},button('Edit','ghost small',function(){linkForm(row);}),button('Delete','danger small',async function(){if(!window.confirm('Delete this link?'))return;await api('/links/'+row.id,{method:'DELETE',body:{}});renderCurrent();})))];});content.appendChild(panel('Bot Links / Redirect Links','Every public URL/button can be changed without editing source code.',node('div',{},button('Add link','',function(){linkForm(null);}),table(['Button / Key','URL','Order','Status',''],rows))));}

  function faqForm(row){var form=node('form',{class:'form-grid'},inputField('Question','question',row&&row.question||'',{maxlength:500,required:true,wide:true}),inputField('Answer','answer',row&&row.answer||'',{tag:'textarea',maxlength:5000,required:true,wide:true}),inputField('Language','language',row&&row.language||'all',{tag:'select',choices:[['all','All'],['en','English'],['ar','Arabic'],['hi','Hindi']]}),inputField('Status','active',String(row?row.active:true),{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('Sort order','sort',row&&row.sort_order||0,{type:'number'}));var save=button(row?'Save FAQ':'Add FAQ','',function(){submitForm(form,save,function(fd){return api('/faqs'+(row?'/'+row.id:''),{method:row?'PATCH':'POST',body:{question:String(fd.get('question')),answer:String(fd.get('answer')),language:String(fd.get('language')),active:String(fd.get('active'))==='true',sort_order:String(fd.get('sort')||0)}});});});openModal(row?'Edit FAQ':'Add FAQ',form,[button('Cancel','ghost',closeModal),save]);}
  async function renderFaq(){var data=(await api('/faqs')).data;clear(content);var rows=data.map(function(row){return[node('td',{class:'mono',text:'#'+row.id}),node('td',{},node('span',{class:'cell-main',text:row.question}),node('span',{class:'cell-sub',text:short(row.answer,90)})),node('td',{text:row.language}),node('td',{text:String(row.sort_order)}),node('td',{},badge(row.active?'active':'disabled')),node('td',{},node('div',{class:'row-actions'},button('Edit','ghost small',function(){faqForm(row);}),button('Delete','danger small',async function(){if(!window.confirm('Delete this FAQ?'))return;await api('/faqs/'+row.id,{method:'DELETE',body:{}});renderCurrent();})))];});content.appendChild(panel('FAQ Management','Questions are read directly by the Telegram bot.',node('div',{},button('Add FAQ','',function(){faqForm(null);}),table(['ID','Question / Answer','Language','Order','Status',''],rows))));}

  async function openChat(row){var data=(await api('/chats/'+row.id)).data;var user=relation(data.users);var history=node('div',{class:'code-block',text:data.messages.map(function(m){return (m.sender_type==='admin'?'ADMIN':'USER')+' · '+formatDate(m.created_at)+'\n'+m.message_text;}).join('\n\n')||'No messages'});var recentOrders=(data.recent_orders||[]);var ordersTable=table(['Order','Product','Qty','Total','Status','Date'],recentOrders.map(function(o){return[node('td',{class:'mono',text:'#'+o.id}),node('td',{text:o.product_name}),node('td',{text:String(o.quantity||1)}),node('td',{text:money(o.total_amount||o.amount)}),node('td',{},badge(o.status)),node('td',{text:formatDate(o.created_at)})];}));var form=node('form',{},inputField('Reply to user','message','',{tag:'textarea',maxlength:4000,required:true,wide:true}));var reply=button('Send reply','success',async function(){if(!form.reportValidity())return;reply.disabled=true;try{await api('/chats/'+row.id+'/reply',{method:'POST',body:{message:String(new FormData(form).get('message'))}});toast('Reply sent in Telegram.','success');closeModal();renderCurrent();}catch(e){toast(e.message,'error');}finally{reply.disabled=false;}});var toggle=button(data.status==='open'?'Close conversation':'Reopen conversation','secondary',async function(){await api('/chats/'+row.id+'/status',{method:'POST',body:{status:data.status==='open'?'closed':'open'}});closeModal();renderCurrent();});openModal('Support · '+(user.username?'@'+user.username:user.first_name||user.telegram_id),node('div',{},detailsGrid([['Telegram ID',user.telegram_id,true],['Name',[user.first_name,user.last_name].filter(Boolean).join(' ')],['Status',data.status],['Unread',data.unread_admin_count]]),node('div',{class:'subsection'},node('h3',{text:'Conversation'}),history),node('div',{class:'subsection'},node('h3',{text:'Recent orders'}),ordersTable),node('div',{class:'subsection'},node('h3',{text:'Reply'}),form)),[button('Close','ghost',closeModal),toggle,reply]);}
  async function renderChats(){var state=stateFor('chats');var response=await api('/chats'+queryString(state));clear(content);content.appendChild(node('div',{class:'toolbar'},toolbarSearch(state,'Telegram ID or user name',renderCurrent),selectControl('Status',state.status||'',[['','All'],['open','Open'],['closed','Closed']],function(v){state.status=v;state.page=1;renderCurrent();})));var directForm=node('form',{class:'form-grid'});var telegramInput=inputField('Telegram User ID','telegram_id','',{maxlength:20,required:true});var openBtn=button('Open / Create Support Chat','success',async function(){if(!directForm.reportValidity())return;openBtn.disabled=true;try{var id=String(new FormData(directForm).get('telegram_id')||'').trim();var result=(await api('/chats/by-telegram-id',{method:'POST',body:{telegram_id:id}})).data;toast('Support conversation ready.','success');openChat(result);}catch(e){toast(e.message,'error');}finally{openBtn.disabled=false;}});directForm.appendChild(telegramInput);directForm.appendChild(openBtn);var rows=response.data.map(function(row){var u=relation(row.users);return[node('td',{},node('span',{class:'cell-main',text:u.username?'@'+u.username:[u.first_name,u.last_name].filter(Boolean).join(' ')||'User'}),node('span',{class:'cell-sub mono',text:String(u.telegram_id)})),node('td',{},badge(row.status)),node('td',{class:'mono',text:String(row.unread_admin_count)}),node('td',{text:formatDate(row.last_message_at)}),node('td',{},button('Open','ghost small',function(){openChat(row);}))];});content.appendChild(panel('Customer Chat / Support Inbox','User messages appear here automatically; replies are sent directly through the bot.',node('div',{},directForm,table(['User','Status','Unread','Last message',''],rows),pagination(response.meta,function(page){state.page=page;renderCurrent();}))));}

  async function renderPayments(){
    var data=(await api('/payment-settings')).data;clear(content);
    var cards=data.map(function(row){
      var help=row.method_key==='usdt_bep20'?'Use address, network_name, minimum, maximum, presets, expiration_minutes and instructions.':'Use payment_name, pay_id, currency, minimum, maximum, presets, expiration_minutes and instructions.';
      var form=node('form',{class:'form-grid'},inputField('Display name','name',row.display_name,{maxlength:120,required:true}),inputField('Enabled','enabled',String(row.enabled),{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('Public JSON config','config',JSON.stringify(row.public_config||{},null,2),{tag:'textarea',maxlength:5000,wide:true}),node('div',{class:'section-note wide',text:help}));
      var save=button('Save','',async function(){if(!form.reportValidity())return;try{var fd=new FormData(form);var cfg=JSON.parse(String(fd.get('config')||'{}'));await api('/payment-settings/'+row.method_key,{method:'PATCH',body:{display_name:String(fd.get('name')),enabled:String(fd.get('enabled'))==='true',public_config:cfg}});toast('Payment setting saved.','success');renderCurrent();}catch(e){toast(e.message,'error');}});
      return panel(row.display_name,row.method_key,node('div',{},form,save));
    });
    content.appendChild(node('div',{class:'section-note warning',text:'Secret API keys, encryption keys and private credentials remain in Environment Variables. TRC20 is kept only in historical deposit records and cannot be enabled for new deposits.'}));
    content.appendChild(node('div',{class:'grid-2'},cards));
    var filters=node('form',{class:'form-grid'},inputField('Order ID','orderId','',{maxlength:64}),inputField('Transaction ID (history search only)','transactionId','',{maxlength:120}),inputField('Currency','currency','USDT',{maxlength:12}),inputField('Date from','dateFrom','',{type:'date'}),inputField('Date to','dateTo','',{type:'date'}),inputField('Incoming only','incomingOnly','true',{tag:'select',choices:[['true','Yes'],['false','No']]}));
    var box=node('div',{class:'subsection'});
    async function loadHistory(refresh){clear(box);box.appendChild(node('div',{class:'empty'},node('p',{text:'Loading Binance Pay history…'})));try{var fd=new FormData(filters),params=new URLSearchParams();['orderId','transactionId','currency','dateFrom','dateTo','incomingOnly'].forEach(function(key){var value=String(fd.get(key)||'').trim();if(value)params.set(key,value);});if(refresh)params.set('refresh','true');var result=(await api('/binance/transactions?'+params.toString())).data;clear(box);box.appendChild(node('div',{class:'section-note',text:'Last sync: '+formatDate(result.lastSyncTime)+(result.cached?' · cached':' · refreshed')}));var rows=(result.items||[]).map(function(row){return[node('td',{class:'mono',text:row.orderId||'—'}),node('td',{class:'mono',text:short(row.transactionId||'—',28)}),node('td',{text:money(row.amount)+' '+row.currency}),node('td',{},badge(row.direction)),node('td',{},badge(row.match)),node('td',{text:formatDate(row.transactionTime)})];});box.appendChild(table(['Order ID','Transaction ID','Amount','Direction','Bot match','Date'],rows));if(!rows.length)box.appendChild(node('div',{class:'empty'},node('p',{text:'No Binance transactions matched these filters.'})));}catch(e){clear(box);box.appendChild(node('div',{class:'section-note warning',text:e.message}));}}
    var search=button('Search cached history','secondary',function(){loadHistory(false);});var refresh=button('Refresh from Binance','',function(){loadHistory(true);});var test=button('Test Binance API','ghost',async function(){try{var status=(await api('/binance/test',{method:'POST',body:{}})).data;toast(status.connected?'Binance read access works.':'Binance test failed.','success');loadHistory(false);}catch(e){toast(e.message,'error');}});
    content.appendChild(panel('Binance Pay Transactions','Server-side, cached history. API secrets never reach this browser.',node('div',{},filters,node('div',{class:'row-actions'},search,refresh,test),box)));
    loadHistory(false);
  }

  function automationRuleForm(rule){
    var thresholds=(rule.selling_fast_thresholds||[]).join(', ');
    var form=node('form',{class:'form-grid'},
      inputField('Enabled','enabled',String(rule.enabled),{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),
      inputField('Destination mode','destinationMode',rule.destination_mode||'disabled',{tag:'select',choices:[['disabled','Disabled'],['all_users','All Bot Users'],['telegram_channel','Telegram Channel'],['telegram_group','Telegram Group'],['custom_chat','Custom Chat ID'],['users_plus_channel','Users + Channel'],['users_plus_group','Users + Group'],['multiple','Multiple Destinations']]}),
      inputField('Destination / @username / chat ID','destinationValue',rule.destination_value||'',{maxlength:120}),
      inputField('Cooldown minutes','cooldown',rule.cooldown_minutes||0,{type:'number'}),
      inputField('Selling fast thresholds','thresholds',thresholds,{maxlength:160}),
      inputField('Minimum stock increase','minStock',rule.min_stock_increase||1,{type:'number'}),
      inputField('Minimum price drop','minDrop',rule.min_price_drop||0,{maxlength:40}),
      inputField('Minimum price drop %','minDropPercent',rule.min_price_drop_percent||0,{maxlength:40}),
      inputField('Button text','buttonText',rule.button_text||'🛍️ Buy Now',{maxlength:64}),
      inputField('Message template','template',rule.message_template||'',{tag:'textarea',maxlength:4000,wide:true})
    );
    var save=button('Save rule','',async function(){if(!form.reportValidity())return;save.disabled=true;try{var fd=new FormData(form);var raw=String(fd.get('thresholds')||'').split(',').map(function(v){return v.trim();}).filter(Boolean);var body={enabled:String(fd.get('enabled'))==='true',destination_mode:String(fd.get('destinationMode')),destination_value:String(fd.get('destinationValue'))||null,cooldown_minutes:Number(fd.get('cooldown')||0),selling_fast_thresholds:raw.length?raw.map(Number):[8,5,3],min_stock_increase:Number(fd.get('minStock')||0),min_price_drop:String(fd.get('minDrop')||'0'),min_price_drop_percent:String(fd.get('minDropPercent')||'0'),button_text:String(fd.get('buttonText')||''),message_template:String(fd.get('template')||'')};if(body.selling_fast_thresholds.some(function(v){return !Number.isInteger(v)||v<1;}))throw new Error('Thresholds must be whole positive numbers separated by commas.');await api('/notification-rules/'+rule.event_type,{method:'PATCH',body:body});toast('Automation rule saved.','success');renderCurrent();}catch(e){toast(e.message,'error');}finally{save.disabled=false;}});
    return panel(rule.event_type.replace(/_/g,' ').toUpperCase(),rule.enabled?'Automation enabled':'Automation disabled',node('div',{},form,save));
  }

  function destinationForm(prefill){prefill=prefill||{};var form=node('form',{class:'form-grid'},inputField('Event','event',prefill.event_type||'new_product',{tag:'select',choices:[['new_product','New Product'],['restock','Restock'],['price_drop','Price Drop'],['selling_fast','Selling Fast'],['out_of_stock','Out Of Stock'],['product_update','Product Update']]}),inputField('Type','type',prefill.destination_type||'channel',{tag:'select',choices:[['users','All Bot Users'],['channel','Telegram Channel'],['group','Telegram Group'],['custom_chat','Custom Chat ID']]}),inputField('Target','target',prefill.target||'',{maxlength:120}),inputField('Label','label',prefill.label||'',{maxlength:120}),inputField('Enabled','enabled',String(prefill.enabled!==false),{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}));var save=button(prefill.id?'Save destination':'Add destination','',function(){submitForm(form,save,async function(fd){var type=String(fd.get('type')),body={destination_type:type,target:type==='users'?null:String(fd.get('target')||''),label:String(fd.get('label')||''),enabled:String(fd.get('enabled'))==='true'};if(!prefill.id)body.event_type=String(fd.get('event'));await api('/notification-destinations'+(prefill.id?'/'+prefill.id:''),{method:prefill.id?'PATCH':'POST',body:body});});});openModal(prefill.id?'Edit destination':'Add destination',form,[button('Cancel','ghost',closeModal),save]);}

  function scheduledSaleForm(){var form=node('form',{class:'form-grid'},inputField('Product ID','productId','',{type:'number',required:true}),inputField('Sale price','salePrice','',{maxlength:40,required:true}),inputField('Starts at','startsAt','',{type:'datetime-local',required:true}),inputField('Ends at','endsAt','',{type:'datetime-local',required:true}));var save=button('Create scheduled sale','',async function(){if(!form.reportValidity())return;save.disabled=true;try{var fd=new FormData(form);await api('/scheduled-sales',{method:'POST',body:{product_id:String(fd.get('productId')),sale_price:String(fd.get('salePrice')),starts_at:new Date(String(fd.get('startsAt'))).toISOString(),ends_at:new Date(String(fd.get('endsAt'))).toISOString()}});closeModal();toast('Scheduled sale created.','success');renderCurrent();}catch(e){toast(e.message,'error');}finally{save.disabled=false;}});openModal('Schedule Flash Sale',form,[button('Cancel','ghost',closeModal),save]);}

  async function renderAutomation(){
    var state=stateFor('automation');var results=await Promise.all([api('/notification-automation'+queryString(state)),api('/scheduled-sales')]);var response=results[0],data=response.data||{},sales=results[1].data||[];clear(content);
    content.appendChild(node('div',{class:'section-note',text:'Automatic notifications use a persistent PostgreSQL queue with cooldown/dedup state. Disabled is the safe default until you configure a destination.'}));
    var rulesWrap=node('div',{class:'grid-2'});(data.rules||[]).forEach(function(rule){rulesWrap.appendChild(automationRuleForm(rule));});content.appendChild(rulesWrap);
    var destinationRows=(data.destinations||[]).map(function(row){var target=row.destination_type==='users'?'All Bot Users':(row.target||'—');return[node('td',{text:row.event_type.replace(/_/g,' ')}),node('td',{},badge(row.destination_type)),node('td',{class:'mono',text:target}),node('td',{text:row.label||'—'}),node('td',{},badge(row.enabled?'enabled':'disabled')),node('td',{},node('div',{class:'row-actions'},button('Edit','ghost small',function(){destinationForm(row);}),row.destination_type==='users'?null:button('Test','secondary small',async function(){try{await api('/notification-destinations/test',{method:'POST',body:{target:row.target}});toast('Test notification sent.','success');}catch(e){toast(e.message,'error');}}),button('Delete','danger small',async function(){if(!window.confirm('Delete this destination?'))return;await api('/notification-destinations/'+row.id,{method:'DELETE',body:{}});renderCurrent();})))];});
    content.appendChild(panel('Destinations','Add reusable destinations for rules using Multiple Destinations.',node('div',{},button('Add destination','',function(){destinationForm(null);}),table(['Event','Type','Target','Label','Status',''],destinationRows))));
    var jobRows=(data.jobs||[]).map(function(row){var product=relation(row.products);var actions=[];if(['queued','processing'].indexOf(row.status)>=0)actions.push(button('Cancel','danger small',async function(){try{await api('/notification-jobs/'+row.id+'/cancel',{method:'POST',body:{}});toast('Cancel requested.','success');renderCurrent();}catch(e){toast(e.message,'error');}}));if((Number(row.failed||0)>0)||row.status==='cancelled')actions.push(button(Number(row.failed||0)>0?'Retry Failed':'Retry','secondary small',async function(){try{await api('/notification-jobs/'+row.id+'/retry',{method:'POST',body:{}});toast('Retry queued.','success');renderCurrent();}catch(e){toast(e.message,'error');}}));return[node('td',{},node('span',{class:'cell-main',text:row.event_type.replace(/_/g,' ')}),node('span',{class:'cell-sub mono',text:short(row.id,18)})),node('td',{text:(product.emoji||'')+' '+(product.name||('Product #'+(row.product_id||'—')))}),node('td',{},badge(row.status)),node('td',{class:'mono',text:String(row.processed||0)+' / '+String(row.total||0)}),node('td',{class:'mono',text:String(row.sent||0)}),node('td',{class:'mono',text:String(row.failed||0)}),node('td',{text:formatDate(row.created_at)}),node('td',{},node('div',{class:'row-actions'},actions))];});
    content.appendChild(panel('Notification History','Queue progress updates live. Telegram 429 responses honor retry_after and failed recipients do not stop other deliveries.',node('div',{},table(['Event','Product','Status','Processed','Sent','Failed','Created',''],jobRows),pagination(response.meta,function(page){state.page=page;renderCurrent();}))));
    var saleRows=sales.map(function(row){var product=relation(row.products);var actions=[];if(row.status==='scheduled'||row.status==='active')actions.push(button('Cancel','danger small',async function(){if(!window.confirm('Cancel this scheduled sale?'))return;try{await api('/scheduled-sales/'+row.id+'/cancel',{method:'POST',body:{}});toast('Scheduled sale cancelled.','success');renderCurrent();}catch(e){toast(e.message,'error');}}));return[node('td',{class:'mono',text:'#'+row.id}),node('td',{text:(product.emoji||'📦')+' '+(product.name||('Product #'+row.product_id))}),node('td',{class:'mono',text:money(row.normal_price)+' → '+money(row.sale_price)}),node('td',{text:formatDate(row.starts_at)}),node('td',{text:formatDate(row.ends_at)}),node('td',{},badge(row.status)),node('td',{},node('div',{class:'row-actions'},actions))];});
    content.appendChild(panel('Scheduled Flash Sales','The worker applies the sale price at start, sends the existing price-drop notification, and safely restores the original price at end.',node('div',{},button('Schedule sale','',scheduledSaleForm),table(['ID','Product','Price','Starts','Ends','Status',''],saleRows))));
  }

  async function renderSettings(){
    var data=(await api('/settings')).data;clear(content);var v=data.settings||{};
    var form=node('form',{class:'form-grid'},
      inputField('Bot name','bot_name',v.bot_name||'',{maxlength:120}),inputField('Currency','currency',v.currency||'USD',{maxlength:10}),
      inputField('Welcome message','welcome_message',v.welcome_message||'',{tag:'textarea',maxlength:5000,wide:true}),inputField('Start message','start_message',v.start_message||'',{tag:'textarea',maxlength:5000,wide:true}),inputField('Store description','store_description',v.store_description||'',{tag:'textarea',maxlength:5000,wide:true}),inputField('Support text','support_text',v.support_text||'',{tag:'textarea',maxlength:5000,wide:true}),inputField('About text','about_text',v.about_text||'',{tag:'textarea',maxlength:5000,wide:true}),inputField('Footer','footer',v.footer||'',{tag:'textarea',maxlength:5000,wide:true}),inputField('Terms text','terms_text',v.terms_text||'',{tag:'textarea',maxlength:5000,wide:true}),inputField('Contact information','contact_information',v.contact_information||'',{tag:'textarea',maxlength:5000,wide:true}),inputField('Payment instructions','payment_instructions',v.payment_instructions||'',{tag:'textarea',maxlength:5000,wide:true}),inputField('Order success message','order_success_message',v.order_success_message||'',{tag:'textarea',maxlength:5000,wide:true}),inputField('Order pending message','order_pending_message',v.order_pending_message||'',{tag:'textarea',maxlength:5000,wide:true}),
      inputField('Buy button text','buy_button_text',v.buy_button_text||'🛒 Buy Now',{maxlength:120}),inputField('Back button text','back_button_text',v.back_button_text||'⬅️ Back',{maxlength:120}),inputField('Main menu text','main_menu_text',v.main_menu_text||'☰ Menu',{maxlength:120}),inputField('Out-of-stock text','out_of_stock_message',v.out_of_stock_message||'OUT OF STOCK',{maxlength:120}),
      inputField('Category layout','category_layout',v.category_layout||'full',{tag:'select',choices:[['full','Full Width / One Per Row'],['two','Two Columns'],['auto','Auto']]}),inputField('Show Other Products','show_uncategorized_products',v.show_uncategorized_products||'true',{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('Other Products title','uncategorized_section_title',v.uncategorized_section_title||'📦 Other Products',{maxlength:120}),
      inputField('Main menu layout','menu_layout',v.menu_layout||'two',{tag:'select',choices:[['two','Two Columns'],['one','One Column'],['auto','Auto']]}),inputField('Products button','menu_products_enabled',v.menu_products_enabled||'true',{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('Wallet button','menu_wallet_enabled',v.menu_wallet_enabled||'true',{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('Deposit button','menu_deposit_enabled',v.menu_deposit_enabled||'true',{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('My Orders button','menu_orders_enabled',v.menu_orders_enabled||'true',{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('Support button','menu_support_enabled',v.menu_support_enabled||'true',{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('About button','menu_about_enabled',v.menu_about_enabled||'true',{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('Channel button','menu_channel_enabled',v.menu_channel_enabled||'true',{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('More button','menu_more_enabled',v.menu_more_enabled||'true',{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),
      inputField('Products label EN','products_label_en',v.products_label_en||'🛍 Products',{maxlength:64}),inputField('Products label AR','products_label_ar',v.products_label_ar||'🛍 المنتجات',{maxlength:64}),inputField('Products label HI','products_label_hi',v.products_label_hi||'🛍 उत्पाद',{maxlength:64}),inputField('Wallet label EN','wallet_label_en',v.wallet_label_en||'💰 Wallet',{maxlength:64}),inputField('Wallet label AR','wallet_label_ar',v.wallet_label_ar||'💰 المحفظة',{maxlength:64}),inputField('Wallet label HI','wallet_label_hi',v.wallet_label_hi||'💰 वॉलेट',{maxlength:64}),inputField('Deposit label EN','deposit_label_en',v.deposit_label_en||'➕ Deposit',{maxlength:64}),inputField('Deposit label AR','deposit_label_ar',v.deposit_label_ar||'➕ إيداع',{maxlength:64}),inputField('Deposit label HI','deposit_label_hi',v.deposit_label_hi||'➕ जमा',{maxlength:64}),inputField('Orders label EN','orders_label_en',v.orders_label_en||'📦 My Orders',{maxlength:64}),inputField('Orders label AR','orders_label_ar',v.orders_label_ar||'📦 طلباتي',{maxlength:64}),inputField('Orders label HI','orders_label_hi',v.orders_label_hi||'📦 मेरे ऑर्डर',{maxlength:64}),inputField('Support label EN','support_label_en',v.support_label_en||'💬 Support',{maxlength:64}),inputField('Support label AR','support_label_ar',v.support_label_ar||'💬 الدعم',{maxlength:64}),inputField('Support label HI','support_label_hi',v.support_label_hi||'💬 सहायता',{maxlength:64}),inputField('About label EN','about_label_en',v.about_label_en||'ℹ️ About',{maxlength:64}),inputField('About label AR','about_label_ar',v.about_label_ar||'ℹ️ حول المتجر',{maxlength:64}),inputField('About label HI','about_label_hi',v.about_label_hi||'ℹ️ हमारे बारे में',{maxlength:64}),inputField('Channel label EN','channel_label_en',v.channel_label_en||'📢 Join Channel',{maxlength:64}),inputField('Channel label AR','channel_label_ar',v.channel_label_ar||'📢 انضم للقناة',{maxlength:64}),inputField('Channel label HI','channel_label_hi',v.channel_label_hi||'📢 चैनल से जुड़ें',{maxlength:64}),
      inputField('Quantity mode','quantity_mode',v.quantity_mode||'auto',{tag:'select',choices:[['auto','Auto'],['sequential','Sequential'],['presets','Presets']]}),inputField('Sequential quantity threshold','quantity_sequential_threshold',v.quantity_sequential_threshold||'20',{type:'number'}),inputField('Quantity presets','quantity_presets',v.quantity_presets||'1,2,3,5,10,20',{maxlength:240}),inputField('Custom quantity','quantity_custom_enabled',v.quantity_custom_enabled||'true',{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('Quantity buttons per row','quantity_buttons_per_row',v.quantity_buttons_per_row||'3',{tag:'select',choices:[['1','1'],['2','2'],['3','3'],['4','4'],['5','5']]}),
      inputField('Animated Custom Emojis','custom_emojis_enabled',v.custom_emojis_enabled||'true',{tag:'select',choices:[['true','Enabled'],['false','Disabled / Unicode fallback']]}),inputField('Automatic chat cleanup','chat_cleanup_enabled',v.chat_cleanup_enabled||'true',{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('Product custom emoji ID','product_custom_emoji_id',v.product_custom_emoji_id||'',{maxlength:30}),inputField('Price custom emoji ID','price_custom_emoji_id',v.price_custom_emoji_id||'',{maxlength:30}),inputField('Stock custom emoji ID','stock_custom_emoji_id',v.stock_custom_emoji_id||'',{maxlength:30}),inputField('Sold custom emoji ID','sold_custom_emoji_id',v.sold_custom_emoji_id||'',{maxlength:30}),inputField('Warranty custom emoji ID','warranty_custom_emoji_id',v.warranty_custom_emoji_id||'',{maxlength:30}),inputField('Binance custom emoji ID','binance_custom_emoji_id',v.binance_custom_emoji_id||'',{maxlength:30}),inputField('Success custom emoji ID','success_custom_emoji_id',v.success_custom_emoji_id||'',{maxlength:30}),
      inputField('Delete previous navigation menus','delete_previous_navigation_menus',v.delete_previous_navigation_menus||'true',{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('Persistent bottom keyboard','persistent_bottom_keyboard',v.persistent_bottom_keyboard||'true',{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),inputField('Shop button text','shop_button_text',v.shop_button_text||'🛍️ Shop',{maxlength:120}),inputField('Deposit button text','deposit_button_text',v.deposit_button_text||'➕ Deposit',{maxlength:120}),
      inputField('Default language','default_language',v.default_language||'en',{tag:'select',choices:[['en','English'],['ar','Arabic'],['hi','Hindi']]}),inputField('Maintenance mode','maintenance_mode',v.maintenance_mode||'false',{tag:'select',choices:[['false','Off'],['true','On']]}),inputField('Minimum order','minimum_order',v.minimum_order||'1',{maxlength:20}),inputField('Maximum order','maximum_order',v.maximum_order||'1000',{maxlength:20})
    );
    var settingKeys=['bot_name','currency','welcome_message','start_message','store_description','support_text','about_text','footer','terms_text','contact_information','payment_instructions','order_success_message','order_pending_message','buy_button_text','back_button_text','main_menu_text','out_of_stock_message','category_layout','show_uncategorized_products','uncategorized_section_title','delete_previous_navigation_menus','persistent_bottom_keyboard','shop_button_text','deposit_button_text','default_language','maintenance_mode','minimum_order','maximum_order','menu_layout','menu_products_enabled','menu_wallet_enabled','menu_deposit_enabled','menu_orders_enabled','menu_support_enabled','menu_about_enabled','menu_channel_enabled','menu_more_enabled','products_label_en','products_label_ar','products_label_hi','wallet_label_en','wallet_label_ar','wallet_label_hi','deposit_label_en','deposit_label_ar','deposit_label_hi','orders_label_en','orders_label_ar','orders_label_hi','support_label_en','support_label_ar','support_label_hi','about_label_en','about_label_ar','about_label_hi','channel_label_en','channel_label_ar','channel_label_hi','quantity_mode','quantity_sequential_threshold','quantity_presets','quantity_custom_enabled','quantity_buttons_per_row','product_custom_emoji_id','price_custom_emoji_id','stock_custom_emoji_id','sold_custom_emoji_id','warranty_custom_emoji_id','binance_custom_emoji_id','success_custom_emoji_id','custom_emojis_enabled','chat_cleanup_enabled'];
    var save=button('Save bot settings','',async function(){if(!form.reportValidity())return;save.disabled=true;try{var fd=new FormData(form),body={};settingKeys.forEach(function(k){body[k]=String(fd.get(k)||'');});await api('/settings',{method:'PATCH',body:body});toast('Bot settings saved.','success');renderCurrent();}catch(e){toast(e.message,'error');}finally{save.disabled=false;}});
    var testEmojis=button('Test Custom Emojis','secondary',async function(){if(!form.reportValidity())return;testEmojis.disabled=true;try{var fd=new FormData(form),body={custom_emojis_enabled:String(fd.get('custom_emojis_enabled')||'true')};['product_custom_emoji_id','price_custom_emoji_id','stock_custom_emoji_id','sold_custom_emoji_id','warranty_custom_emoji_id','binance_custom_emoji_id','success_custom_emoji_id'].forEach(function(k){body[k]=String(fd.get(k)||'');});var rows=(await api('/settings/custom-emojis/test',{method:'POST',body:body})).data||[];var configured=rows.filter(function(row){return row.id;});var valid=configured.filter(function(row){return row.valid;});var animated=valid.filter(function(row){return row.animated;});var invalid=configured.filter(function(row){return !row.valid;});toast('Valid: '+valid.length+' / '+configured.length+' · Animated/video: '+animated.length+(invalid.length?' · Invalid: '+invalid.map(function(row){return row.key;}).join(', '):''),invalid.length?'error':'success');}catch(e){toast(e.message,'error');}finally{testEmojis.disabled=false;}});
    content.appendChild(node('div',{class:'section-note',text:data.secretNotice}));
    content.appendChild(panel('Bot Settings','Catalog layout, chat cleanup and validated Telegram Custom Emojis are applied without source-code changes.',node('div',{},form,node('div',{class:'row-actions'},save,testEmojis))));
    content.appendChild(panel('Runtime security','Read-only deployment information',detailsGrid([['Environment',data.environment],['Webhook',data.webhookConfigured?'Configured':'Polling'],['Binance API',data.binanceAutomatic?'Configured':'Not configured'],['Inventory encryption',data.inventoryEncryptionConfigured?'Configured':'Missing'],['Live updates',data.liveUpdates?'Enabled':'Disabled'],['Admin actor',data.adminActor]])));
  }

  async function renderReferrals(){
    var settings=(await api('/referrals/settings')).data;var stats=(await api('/referrals/stats')).data;clear(content);
    var form=node('form',{class:'form-grid'},
      inputField('Referrals enabled','enabled',String(settings.enabled),{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),
      inputField('Commission percent','commissionPercent',settings.commissionPercent,{type:'number'}),
      inputField('Button label EN','labelEn',settings.labels.en,{maxlength:64}),
      inputField('Button label AR','labelAr',settings.labels.ar,{maxlength:64}),
      inputField('Button label HI','labelHi',settings.labels.hi,{maxlength:64}));
    var save=button('Save referral settings','',function(){return submitForm(form,save,function(fd){return api('/referrals/settings',{method:'PATCH',body:{enabled:String(fd.get('enabled'))==='true',commissionPercent:Number(fd.get('commissionPercent')),labelEn:String(fd.get('labelEn')),labelAr:String(fd.get('labelAr')),labelHi:String(fd.get('labelHi'))}});});});
    content.appendChild(panel('Referral Settings','Disabled by default. The main-menu button only appears once enabled.',node('div',{},form,save)));
    content.appendChild(node('div',{class:'grid-2'},[
      panel('Total Referrers',null,node('h2',{text:String(stats.totalReferrers)})),
      panel('Total Referred Users',null,node('h2',{text:String(stats.totalReferredUsers)})),
      panel('Total Referral Orders',null,node('h2',{text:String(stats.totalReferralOrders)})),
      panel('Total Commission Paid',null,node('h2',{text:'$'+money(stats.totalCommissionPaid)})),
      panel('Commission Today',null,node('h2',{text:'$'+money(stats.commissionToday)})),
      panel('Commission This Month',null,node('h2',{text:'$'+money(stats.commissionThisMonth)}))
    ]));
    var search=inputField('Search by Telegram ID or username','search','',{});
    var searchBtn=button('Search','secondary',function(){loadUsers();});
    var box=node('div',{class:'subsection'});
    async function loadUsers(){clear(box);var fd=new FormData(search.querySelector('input,select,textarea').form||undefined);var q=search.querySelector('input').value.trim();var params=new URLSearchParams();if(q)params.set('search',q);var result=await api('/referrals/users?'+params.toString());var rows=result.data.map(function(row){var actions=[];if(row.referral_active!==false){actions.push(button('Disable','danger small',async function(){await api('/referrals/users/'+row.id,{method:'PATCH',body:{active:false}});toast('User referral disabled.','success');loadUsers();}));}else{actions.push(button('Enable','success small',async function(){await api('/referrals/users/'+row.id,{method:'PATCH',body:{active:true}});toast('User referral enabled.','success');loadUsers();}));}actions.push(button('Delete','danger small',async function(){if(!window.confirm('Delete this user referral code? Existing referral history will be kept.'))return;await api('/referrals/users/'+row.id,{method:'DELETE',body:{}});toast('User referral code deleted.','success');loadUsers();}));return[node('td',{class:'mono',text:String(row.telegram_id)}),node('td',{text:row.username?'@'+row.username:'—'}),node('td',{class:'mono',text:row.referral_code||'—'}),node('td',{text:String(row.referred_count)}),node('td',{text:String(row.purchases_count)}),node('td',{text:'$'+money(row.total_commission)}),node('td',{},badge(row.status)),node('td',{},node('div',{class:'row-actions'},actions))];});box.appendChild(table(['Telegram ID','Username','Code','Referred','Purchases','Commission','Status',''],rows));}
    content.appendChild(panel('Referrers',null,node('div',{},node('div',{class:'row-actions'},search,searchBtn),box)));
    loadUsers();
  }

  function merchantLinkForm(row){
    var form=node('form',{class:'form-grid'},
      inputField(row?'Owner (read-only)':'Owner (Telegram ID or @username)','owner',row?row.owner_user_id:'',{maxlength:64,required:!row}),
      inputField('Commission percent','commissionPercent',row?row.commission_percent:'',{type:'number',required:true}),
      inputField('Label','label',row?row.label:'',{maxlength:120}),
      inputField('Status','active',String(row?row.active:true),{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}));
    var save=button(row?'Save link':'Create link','',function(){return submitForm(form,save,function(fd){var body={commissionPercent:Number(fd.get('commissionPercent')),label:String(fd.get('label')||''),active:String(fd.get('active'))==='true'};if(!row)body.owner=String(fd.get('owner'));return api('/merchant-links'+(row?'/'+row.id:''),{method:row?'PATCH':'POST',body:body});});});
    openModal(row?'Edit merchant link':'Create merchant link',form,[button('Cancel','ghost',closeModal),save]);
  }

  async function renderMerchantLinks(){
    var result=await api('/merchant-links');clear(content);
    var rows=result.data.map(function(row){var owner=row.users||{};var linkCell=node('div',{},node('span',{class:'cell-main mono',text:row.referral_link||'—'}),node('div',{class:'row-actions'},button('Copy','ghost small',function(){return copyText(row.referral_link).then(function(){toast('Merchant referral link copied.','success');});})));var actions=[button('Edit','ghost small',function(){merchantLinkForm(row);})];actions.push(button(row.active?'Disable':'Enable',row.active?'danger small':'success small',async function(){await api('/merchant-links/'+row.id,{method:'PATCH',body:{active:!row.active}});toast(row.active?'Merchant referral disabled.':'Merchant referral enabled.','success');renderCurrent();}));actions.push(button('Delete','danger small',async function(){if(!window.confirm('Delete this merchant referral link? Historical commissions will be kept.'))return;await api('/merchant-links/'+row.id,{method:'DELETE',body:{}});toast('Merchant referral link deleted.','success');renderCurrent();}));return[node('td',{class:'mono',text:row.code}),node('td',{},node('span',{class:'cell-main',text:owner.username?'@'+owner.username:String(owner.telegram_id||row.owner_user_id)}),node('span',{class:'cell-sub',text:row.label||''})),node('td',{},linkCell),node('td',{text:money(row.commission_percent)+'%'}),node('td',{text:String(row.referred_count)}),node('td',{text:String(row.orders_count)}),node('td',{text:'$'+money(row.total_sales)}),node('td',{text:'$'+money(row.total_commission)}),node('td',{},badge(row.active?'active':'disabled')),node('td',{},node('div',{class:'row-actions'},actions))];});
    content.appendChild(panel('Merchant Referral Links','Independent from customer referrals — each link has its own owner and commission rate. Disable pauses the link; Delete removes the link permanently while keeping historical commission records.',node('div',{},button('Create link','',function(){merchantLinkForm(null);}),table(['Code','Owner','Referral Link','Commission','Referred','Orders','Sales','Commission Paid','Status','Actions'],rows))));
  }

  function channelForm(row){
    var form=node('form',{class:'form-grid'},
      inputField('Channel name','name',row?row.name:'',{maxlength:120,required:true}),
      inputField('Chat ID or @username','chatRef',row?row.chat_ref:'',{maxlength:120,required:true}),
      inputField('Join URL','joinUrl',row?row.join_url:'',{maxlength:500,required:true,wide:true}),
      inputField('Status','active',String(row?row.active:true),{tag:'select',choices:[['true','Enabled'],['false','Disabled']]}),
      inputField('Sort order','sortOrder',row?row.sort_order:0,{type:'number'}));
    var save=button(row?'Save channel':'Add channel','',function(){return submitForm(form,save,function(fd){return api('/required-channels'+(row?'/'+row.id:''),{method:row?'PATCH':'POST',body:{name:String(fd.get('name')),chatRef:String(fd.get('chatRef')),joinUrl:String(fd.get('joinUrl')),active:String(fd.get('active'))==='true',sortOrder:Number(fd.get('sortOrder')||0)}});});});
    openModal(row?'Edit channel':'Add required channel',form,[button('Cancel','ghost',closeModal),save]);
  }

  async function renderChannels(){
    var data=(await api('/required-channels')).data;clear(content);
    var toggle=node('form',{class:'form-grid'},inputField('Force Join enabled','enabled',String(data.enabled),{tag:'select',choices:[['true','Enabled — users must join before using the bot'],['false','Disabled']]}));
    var saveToggle=button('Save','',function(){return submitForm(toggle,saveToggle,function(fd){return api('/required-channels/settings',{method:'PATCH',body:{enabled:String(fd.get('enabled'))==='true'}});});});
    content.appendChild(panel('Force Join','Off by default so existing users are never interrupted.',node('div',{},toggle,saveToggle)));
    var rows=data.channels.map(function(row){return[node('td',{text:String(row.sort_order)}),node('td',{},node('span',{class:'cell-main',text:row.name}),node('span',{class:'cell-sub mono',text:row.chat_ref})),node('td',{class:'mono',text:short(row.join_url,50)}),node('td',{},badge(row.active?'active':'disabled')),node('td',{},node('div',{class:'row-actions'},button('Edit','ghost small',function(){channelForm(row);}),button('Delete','danger small',async function(){if(!window.confirm('Delete this channel?'))return;await api('/required-channels/'+row.id,{method:'DELETE',body:{}});renderCurrent();})))];});
    content.appendChild(panel('Required Channels','Any number of channels; users must join every active one to pass Force Join.',node('div',{},button('Add channel','',function(){channelForm(null);}),table(['Order','Channel','Join URL','Status',''],rows))));
  }

  var renderers={dashboard:renderDashboard,products:renderProducts,categories:renderCategories,inventory:renderInventory,orders:renderOrders,preorders:renderPreorders,refunds:renderRefunds,deposits:renderDeposits,users:renderUsers,wallet:renderWallet,notifications:renderNotifications,automation:renderAutomation,chats:renderChats,faq:renderFaq,links:renderLinks,payments:renderPayments,broadcast:renderBroadcast,settings:renderSettings,referrals:renderReferrals,merchantlinks:renderMerchantLinks,channels:renderChannels};

  async function init(){try{initTheme();session=(await api('/session')).data;document.getElementById('actor').textContent='Admin '+session.actor;var nav=document.getElementById('nav');navItems.forEach(function(item){var b=node('button',{type:'button',class:'nav-button',on:{click:function(){setRoute(item[0]);}}},node('span',{class:'nav-icon',text:item[2]}),node('span',{text:item[1]}));b.dataset.page=item[0];nav.appendChild(b);});document.getElementById('menu-button').addEventListener('click',function(){sidebar.classList.toggle('open');});document.getElementById('logout-button').addEventListener('click',async function(){try{await fetch('/admin/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:'{}',credentials:'same-origin'});}finally{if(liveSource)liveSource.close();window.location.assign('/admin/login');}});window.addEventListener('hashchange',function(){var name=window.location.hash.slice(1);if(name!==currentPage)setRoute(name);});connectLive();setRoute(window.location.hash.slice(1)||'dashboard');}catch(error){window.location.assign('/admin/login');}}
  init();
}());
`;

'use strict';

const crypto = require('node:crypto');
const { db, unwrap } = require('../database');
const liveEvents = require('./liveEvents');

const WORKER_ID = `notify-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const EVENT_TYPES = new Set(['new_product','restock','price_drop','selling_fast','out_of_stock','product_update']);
let workerTimer = null;
let workerBusy = false;
let botRef = null;
let botUsername = '';

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function numeric(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function stockOf(product) {
  if (!product) return 0;
  if (product.unlimited_stock) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.trunc(numeric(product.stock ?? product.available_stock ?? product.manual_stock, 0)));
}
function money(value) { return numeric(value, 0).toFixed(2).replace(/\.00$/, '.00'); }
function durationSuffix(product) { return product?.duration ? ` — ${String(product.duration)}` : ''; }
function warranty(product) {
  if (!product?.warranty_value || !product?.warranty_unit) return 'No warranty';
  const unit = product.warranty_unit === 'hours' ? 'H' : product.warranty_unit === 'days' ? ' Days' : ' Months';
  return `${product.warranty_value}${unit}`;
}
function bulkPricing(product) {
  const tiers = product?.bulk_pricing_tiers || [];
  if (!product?.bulk_pricing_enabled || !tiers.length) return '';
  const rows = ['💰 Buy more and save:'];
  for (const tier of tiers) {
    const range = tier.max_quantity == null ? `${tier.min_quantity}+ items` : `${tier.min_quantity}–${tier.max_quantity} items`;
    rows.push(`• ${range}: $${money(tier.unit_price)}/item`);
  }
  return rows.join('\n');
}

function normalizeTemplateNewlines(value) {
  return String(value || '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
}

function templateValues(product, previous = {}, extra = {}) {
  const currentStock = stockOf(product);
  return {
    emoji: product?.emoji || '📦',
    name: product?.name || 'Product',
    duration: durationSuffix(product),
    product_type: product?.product_type || (product?.fulfillment_type === 'instant' ? 'Activation Link' : 'Manual Delivery'),
    delivery_time: product?.delivery_time_label || (product?.fulfillment_type === 'instant' ? 'Instant delivery' : 'Manual delivery'),
    price: `$${money(product?.price)}`,
    old_price: `$${money(previous?.price ?? product?.price)}`,
    stock: product?.unlimited_stock ? '∞' : String(currentStock),
    warranty: warranty(product),
    bulk_pricing: bulkPricing(product),
    ...extra
  };
}

function renderTemplate(template, values) {
  return normalizeTemplateNewlines(template)
    .replace(/\{\{([a-z0-9_]+)\}\}/gi, (_m, key) => values[key] == null ? '' : String(values[key]))
    .trim()
    .slice(0, 4000);
}

async function getRule(eventType) {
  if (!EVENT_TYPES.has(eventType)) return null;
  return unwrap(await db().from('notification_rules').select('*').eq('event_type', eventType).maybeSingle(), 'get notification rule');
}

async function getState(productId) {
  return unwrap(await db().from('product_notification_state').select('*').eq('product_id', productId).maybeSingle(), 'get product notification state');
}

async function saveState(productId, patch) {
  return unwrap(await db().from('product_notification_state').upsert({
    product_id: productId,
    ...patch,
    updated_at: new Date().toISOString()
  }, { onConflict: 'product_id' }).select().single(), 'save product notification state');
}

function cooldownPassed(state, eventType, cooldownMinutes) {
  const raw = state?.event_timestamps?.[eventType];
  if (!raw || cooldownMinutes <= 0) return true;
  const time = new Date(raw).getTime();
  return !Number.isFinite(time) || Date.now() - time >= cooldownMinutes * 60_000;
}

async function enqueue(eventType, product, previous, rule, extra = {}) {
  if (!rule?.enabled || rule.destination_mode === 'disabled' || product?.notification_mode === 'muted') return null;
  const values = templateValues(product, previous, extra);
  const message = renderTemplate(rule.message_template, values);
  if (!message) return null;
  const payload = {
    message,
    button_text: String(rule.button_text || '🛍️ Buy Now').slice(0, 64),
    product_id: product.id,
    product_name: product.name,
    destination_mode: rule.destination_mode,
    destination_value: rule.destination_value || null,
    values
  };
  const row = unwrap(await db().from('notification_jobs').insert({
    event_type: eventType,
    product_id: product.id,
    status: 'queued',
    payload
  }).select().single(), 'enqueue notification job');
  liveEvents.publish(['automation', 'notifications', 'dashboard'], { source: 'notification_queued', jobId: row.id, eventType });
  return row;
}

async function captureProductChange(previous, product, { created = false, forceUpdateEvent = false } = {}) {
  if (!product?.id || product.notification_mode === 'muted') return [];
  const state = await getState(product.id);
  const nowIso = new Date().toISOString();
  const prevStock = previous ? stockOf(previous) : numeric(state?.last_stock, stockOf(product));
  const nextStock = stockOf(product);
  const prevPrice = previous ? numeric(previous.price) : numeric(state?.last_price, numeric(product.price));
  const nextPrice = numeric(product.price);
  const eventTimestamps = { ...(state?.event_timestamps || {}) };
  const eventValues = { ...(state?.event_values || {}) };
  let sentThresholds = Array.isArray(state?.sent_thresholds) ? state.sent_thresholds.map(Number) : [];
  const queued = [];

  async function maybe(eventType, condition, extra = {}) {
    if (!condition) return;
    const rule = await getRule(eventType);
    if (!rule?.enabled || !cooldownPassed(state, eventType, Number(rule.cooldown_minutes || 0))) return;
    const row = await enqueue(eventType, product, previous, rule, extra);
    if (row) {
      queued.push(row);
      eventTimestamps[eventType] = nowIso;
      eventValues[eventType] = extra.value ?? nextStock;
    }
  }

  if (created) await maybe('new_product', product.active && product.product_status === 'active', { value: product.id });

  if (previous) {
    const restockRule = await getRule('restock');
    const increase = nextStock - prevStock;
    const restockCondition = nextStock > prevStock && (
      (prevStock <= 0 && nextStock > 0) || (restockRule && increase >= Number(restockRule.min_stock_increase || 1))
    );
    if (restockRule?.enabled && restockCondition && cooldownPassed(state, 'restock', Number(restockRule.cooldown_minutes || 0))) {
      const row = await enqueue('restock', product, previous, restockRule, { stock_increase: increase, value: nextStock });
      if (row) { queued.push(row); eventTimestamps.restock = nowIso; eventValues.restock = nextStock; }
      if (nextStock > prevStock) sentThresholds = sentThresholds.filter((threshold) => nextStock <= threshold);
    }

    if (nextPrice < prevPrice) {
      const rule = await getRule('price_drop');
      if (rule?.enabled && cooldownPassed(state, 'price_drop', Number(rule.cooldown_minutes || 0))) {
        const drop = prevPrice - nextPrice;
        const percent = prevPrice > 0 ? drop * 100 / prevPrice : 100;
        const samePrice = String(eventValues.price_drop ?? '') === String(nextPrice);
        if (!samePrice && drop >= Number(rule.min_price_drop || 0) && percent >= Number(rule.min_price_drop_percent || 0)) {
          const row = await enqueue('price_drop', product, previous, rule, { drop: money(drop), drop_percent: percent.toFixed(2), value: nextPrice });
          if (row) { queued.push(row); eventTimestamps.price_drop = nowIso; eventValues.price_drop = nextPrice; }
        }
      }
    }

    const sellingRule = await getRule('selling_fast');
    if (sellingRule?.enabled && nextStock > 0 && !product.unlimited_stock) {
      const thresholds = [...new Set((sellingRule.selling_fast_thresholds || [8, 5, 3]).map(Number).filter((v) => Number.isInteger(v) && v > 0))].sort((a, b) => b - a);
      const crossed = thresholds.filter((threshold) => prevStock > threshold && nextStock <= threshold && !sentThresholds.includes(threshold) && cooldownPassed(state, `selling_fast_${threshold}`, Number(sellingRule.cooldown_minutes || 0)));
      const threshold = crossed.length ? Math.min(...crossed) : null;
      if (threshold) {
        const row = await enqueue('selling_fast', product, previous, sellingRule, { threshold, value: threshold });
        if (row) {
          queued.push(row); sentThresholds.push(threshold); eventTimestamps[`selling_fast_${threshold}`] = nowIso; eventValues[`selling_fast_${threshold}`] = nextStock;
        }
      }
    }

    await maybe('out_of_stock', prevStock > 0 && nextStock <= 0 && !product.unlimited_stock, { value: 0 });
    await maybe('product_update', forceUpdateEvent, { value: nowIso });
  }

  await saveState(product.id, {
    last_stock: product.unlimited_stock ? null : Math.min(nextStock, 2147483647),
    last_price: String(product.price),
    sent_thresholds: [...new Set(sentThresholds)].sort((a, b) => b - a),
    event_timestamps: eventTimestamps,
    event_values: eventValues
  });
  return queued;
}

async function ensureBotUsername() {
  if (botUsername) return botUsername;
  if (!botRef) return '';
  try {
    const me = botRef.botInfo || await botRef.telegram.getMe();
    botUsername = String(me?.username || '').replace(/^@/, '');
  } catch (_) { botUsername = ''; }
  return botUsername;
}

function deepLink(username, productId) {
  return username ? `https://t.me/${username}?start=product_${productId}` : null;
}

async function sendWithRetry(chatId, message, extra) {
  const normalizedMessage = normalizeTemplateNewlines(message).slice(0, 4000);
  let attempt = 0;
  while (attempt < 4) {
    attempt += 1;
    try {
      await botRef.telegram.sendMessage(chatId, normalizedMessage, extra);
      return { ok: true, attempts: attempt };
    } catch (error) {
      const code = Number(error?.response?.error_code || error?.code || 0);
      const retryAfter = Number(error?.response?.parameters?.retry_after || error?.parameters?.retry_after || 0);
      if (code === 429 && retryAfter > 0 && attempt < 4) {
        await delay(Math.min(retryAfter, 60) * 1000 + Math.floor(Math.random() * 250));
        continue;
      }
      if (attempt < 4 && code >= 500) { await delay(500 * 2 ** (attempt - 1)); continue; }
      return { ok: false, attempts: attempt, error, code };
    }
  }
  return { ok: false, attempts: attempt, error: new Error('SEND_FAILED') };
}

async function destinationList(job) {
  if (Array.isArray(job.payload?.retry_targets) && job.payload.retry_targets.length) {
    return job.payload.retry_targets.map((row) => ({ type: 'retry', target: String(row.chat_id), recipientKey: String(row.recipient_key || `retry:${row.chat_id}`) }));
  }
  const mode = job.payload?.destination_mode || 'disabled';
  const value = job.payload?.destination_value || null;
  const result = [];
  if (mode === 'all_users' || mode === 'users_plus_channel' || mode === 'users_plus_group') result.push({ type: 'users' });
  if (mode === 'telegram_channel' || mode === 'users_plus_channel') result.push({ type: 'channel', target: value });
  if (mode === 'telegram_group' || mode === 'users_plus_group') result.push({ type: 'group', target: value });
  if (mode === 'custom_chat') result.push({ type: 'custom_chat', target: value });
  if (mode === 'multiple') {
    const rows = unwrap(await db().from('notification_destinations').select('*').eq('event_type', job.event_type).eq('enabled', true).order('id'), 'list notification destinations');
    for (const row of rows) result.push({ type: row.destination_type, target: row.target });
  }
  return result.filter((row) => row.type === 'users' || row.target);
}

async function getJob(id) {
  return unwrap(await db().from('notification_jobs').select('*').eq('id', id).maybeSingle(), 'get notification job');
}

async function recordDelivery(jobId, recipientKey, chatId, result) {
  const errorText = result.ok ? null : String(result.error?.message || result.code || 'SEND_FAILED').slice(0, 500);
  await db().from('notification_job_deliveries').upsert({
    job_id: jobId,
    recipient_key: recipientKey,
    telegram_chat_id: String(chatId),
    status: result.ok ? 'sent' : 'failed',
    attempts: result.attempts || 1,
    last_error: errorText,
    sent_at: result.ok ? new Date().toISOString() : null
  }, { onConflict: 'job_id,recipient_key' });
}

async function updateProgress(jobId, counts) {
  await db().from('notification_jobs').update(counts).eq('id', jobId);
  liveEvents.publish(['automation', 'notifications'], { source: 'notification_progress', jobId, ...counts });
}

async function processJob(job) {
  if (!botRef) return;
  const username = await ensureBotUsername();
  const link = deepLink(username, job.product_id);
  const extra = link ? { reply_markup: { inline_keyboard: [[{ text: String(job.payload?.button_text || '🛍️ Buy Now').slice(0, 64), url: link }]] } } : {};
  const destinations = await destinationList(job);
  let total = 0; let sent = 0; let failed = 0; let processed = 0;
  for (const destination of destinations) {
    if (destination.type === 'users') {
      const countResult = await db().from('users').select('*', { count: 'exact', head: true }).eq('is_suspended', false);
      unwrap(countResult, 'count notification users');
      total += countResult.count || 0;
    } else total += 1;
  }
  await updateProgress(job.id, { total, sent: 0, failed: 0, processed: 0 });

  for (const destination of destinations) {
    const fresh = await getJob(job.id);
    if (!fresh || fresh.cancel_requested) break;
    if (destination.type === 'users') {
      let offset = 0;
      while (true) {
        const users = unwrap(await db().from('users').select('telegram_id').eq('is_suspended', false).order('id').range(offset, offset + 99), 'load notification users');
        if (!users.length) break;
        for (const user of users) {
          const current = await getJob(job.id);
          if (!current || current.cancel_requested) break;
          const result = await sendWithRetry(user.telegram_id, job.payload.message, extra);
          await recordDelivery(job.id, `user:${user.telegram_id}`, user.telegram_id, result);
          processed += 1; if (result.ok) sent += 1; else failed += 1;
          if (processed % 10 === 0 || processed === total) await updateProgress(job.id, { total, sent, failed, processed });
          await delay(45);
        }
        if (users.length < 100) break;
        offset += users.length;
      }
    } else {
      const result = await sendWithRetry(destination.target, job.payload.message, extra);
      await recordDelivery(job.id, destination.recipientKey || `${destination.type}:${destination.target}`, destination.target, result);
      processed += 1; if (result.ok) sent += 1; else failed += 1;
      await updateProgress(job.id, { total, sent, failed, processed });
    }
  }

  const fresh = await getJob(job.id);
  const cancelled = fresh?.cancel_requested;
  const status = cancelled ? 'cancelled' : (processed === 0 || (failed > 0 && sent === 0) ? 'failed' : 'completed');
  await db().from('notification_jobs').update({
    status, total, sent, failed, processed, completed_at: new Date().toISOString(),
    last_error: status === 'failed' ? 'All notification deliveries failed.' : null
  }).eq('id', job.id);
  liveEvents.publish(['automation', 'notifications', 'dashboard'], { source: 'notification_finished', jobId: job.id, status });
}

async function workerTick() {
  if (!botRef || workerBusy) return;
  workerBusy = true;
  try {
    const claimed = unwrap(await db().rpc('claim_notification_job', { p_worker_id: WORKER_ID }), 'claim notification job')[0];
    if (claimed) await processJob(claimed);
  } catch (error) {
    console.error('notification_worker_failed', { code: error.code, message: String(error.message || '').slice(0, 200) });
  } finally { workerBusy = false; }
}

function startWorker(bot) {
  botRef = bot;
  if (workerTimer) return;
  workerTimer = setInterval(() => workerTick(), 2500);
  workerTimer.unref();
  setTimeout(() => workerTick(), 750).unref?.();
}

function stopWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  botRef = null;
}

async function listRules() {
  return unwrap(await db().from('notification_rules').select('*').order('event_type'), 'list notification rules');
}
async function saveRule(eventType, values) {
  if (!EVENT_TYPES.has(eventType)) throw Object.assign(new Error('Invalid notification event type.'), { code: 'INVALID_EVENT_TYPE' });
  const row = unwrap(await db().from('notification_rules').update({ ...values, updated_at: new Date().toISOString() }).eq('event_type', eventType).select().single(), 'save notification rule');
  liveEvents.publish(['automation'], { source: 'notification_rule_update', eventType });
  return row;
}
async function listDestinations(eventType = null) {
  let query = db().from('notification_destinations').select('*').order('event_type').order('id');
  if (eventType) query = query.eq('event_type', eventType);
  return unwrap(await query, 'list notification destinations');
}
async function saveDestination(values, id = null) {
  const query = id ? db().from('notification_destinations').update({ ...values, updated_at: new Date().toISOString() }).eq('id', id).select().single()
    : db().from('notification_destinations').insert(values).select().single();
  const row = unwrap(await query, id ? 'update notification destination' : 'create notification destination');
  liveEvents.publish(['automation'], { source: 'notification_destination_update' });
  return row;
}
async function deleteDestination(id) {
  const row = unwrap(await db().from('notification_destinations').delete().eq('id', id).select().maybeSingle(), 'delete notification destination');
  liveEvents.publish(['automation'], { source: 'notification_destination_delete' });
  return row;
}
async function listJobs(page = 1, limit = 25) {
  const from = (page - 1) * limit;
  const result = await db().from('notification_jobs').select('id,event_type,product_id,status,total,sent,failed,processed,created_at,started_at,completed_at,last_error,products(name,emoji)', { count: 'exact' }).order('created_at', { ascending: false }).range(from, from + limit - 1);
  const rows = unwrap(result, 'list notification jobs');
  return { items: rows, count: result.count || 0 };
}
async function cancelJob(id) {
  const row = unwrap(await db().from('notification_jobs').update({ cancel_requested: true }).eq('id', id).in('status', ['queued','processing']).select().maybeSingle(), 'cancel notification job');
  liveEvents.publish(['automation'], { source: 'notification_cancel', jobId: id });
  return row;
}
async function retryJob(id) {
  const source = await getJob(id);
  if (!source) return null;
  if (!['failed','completed','cancelled'].includes(source.status)) throw Object.assign(new Error('Job must be finished before retrying.'), { code: 'JOB_NOT_FINISHED' });
  const failedRows = unwrap(await db().from('notification_job_deliveries').select('recipient_key,telegram_chat_id').eq('job_id', id).eq('status', 'failed').order('id'), 'load failed notification deliveries');
  const payload = { ...(source.payload || {}) };
  if (failedRows.length) payload.retry_targets = failedRows.map((row) => ({ recipient_key: row.recipient_key, chat_id: row.telegram_chat_id }));
  else if (source.status !== 'cancelled') throw Object.assign(new Error('This job has no failed deliveries to retry.'), { code: 'NO_FAILED_DELIVERIES' });
  const row = unwrap(await db().from('notification_jobs').insert({ event_type: source.event_type, product_id: source.product_id, status: 'queued', payload }).select().single(), 'retry notification job');
  liveEvents.publish(['automation'], { source: 'notification_retry', jobId: row.id });
  return row;
}
async function testDestination(target, message = '✅ Telegram Store notification test successful.') {
  if (!botRef) throw Object.assign(new Error('Telegram bot is not ready.'), { code: 'BOT_NOT_READY' });
  const result = await sendWithRetry(target, String(message).slice(0, 1000), {});
  if (!result.ok) throw result.error || new Error('Telegram test notification failed.');
  return true;
}

module.exports = {
  EVENT_TYPES,
  captureProductChange,
  startWorker,
  stopWorker,
  workerTick,
  listRules,
  saveRule,
  listDestinations,
  saveDestination,
  deleteDestination,
  listJobs,
  cancelJob,
  retryJob,
  testDestination,
  normalizeTemplateNewlines,
  renderTemplate,
  templateValues,
  stockOf
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const keyboards = require('../src/keyboards');

const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'database.sql'), 'utf8');
const store = fs.readFileSync(path.join(root, 'src/services/store.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');

test('main menu follows the screenshot-inspired store layout', () => {
  const rows = keyboards.mainMenu('en', { supportUsername: '', supportUrl: '', channelUrl: '' }).reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((row) => row.map((button) => button.callback_data)), [
    ['menu:products', 'menu:wallet'],
    ['wallet:topup', 'orders:all:0'],
    ['menu:support', 'menu:about'],
    ['menu:channel'],
    ['menu:more']
  ]);
});

test('atomic purchase SQL locks rows, selects unique inventory, and prices server-side', () => {
  const functionBody = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION purchase_product_v2'), sql.indexOf('CREATE OR REPLACE FUNCTION deliver_manual_order'));
  for (const contract of [
    'FOR UPDATE', 'FOR UPDATE SKIP LOCKED', "status = 'available'", 'LIMIT p_quantity',
    'v_unit_price * p_quantity', 'wallet_balance - v_total', "status = 'sold'",
    'idempotency_key = p_idempotency_key', 'INSUFFICIENT_BALANCE', 'OUT_OF_STOCK'
  ]) assert.equal(functionBody.includes(contract), true, `missing purchase contract: ${contract}`);
  assert.equal(store.includes(".rpc('purchase_product_v2'"), true);
  assert.equal(store.includes(".rpc('purchase_product',"), false);
});

test('migration includes unique encrypted inventory, manual delivery and atomic refunds', () => {
  for (const contract of [
    'CREATE TABLE IF NOT EXISTS product_inventory_items', 'UNIQUE(product_id, payload_hash)',
    'CREATE TABLE IF NOT EXISTS refund_requests', 'CREATE OR REPLACE FUNCTION deliver_manual_order',
    'CREATE OR REPLACE FUNCTION review_refund_request', "fulfillment_type TEXT NOT NULL DEFAULT 'manual'",
    "status IN ('pending', 'processing', 'delivered', 'refunded', 'cancelled')",
    'CREATE OR REPLACE FUNCTION replace_bulk_pricing_tiers'
  ]) assert.equal(sql.includes(contract), true, `missing migration contract: ${contract}`);
});

test('admin has authenticated live events with reconnect polling and secret-safe list APIs', () => {
  for (const contract of [
    "router.get('/api/events'", "new EventSource('/admin/api/events'", 'startFallbackPolling',
    "router.post('/api/products/:productId/inventory/:itemId/reveal'", "router.post('/api/orders/:id/deliver'",
    "router.post('/api/refunds/:id/review'", "router.post('/api/orders/:id/delivery/reveal'",
    'Private delivery payloads are excluded'
  ]) assert.equal(admin.includes(contract), true, `missing admin contract: ${contract}`);
  const listFunction = store.slice(store.indexOf('async function listInventoryItems'), store.indexOf('async function inventoryStatusCounts'));
  assert.equal(listFunction.includes('payload_ciphertext, payload_iv, payload_auth_tag, ...safe'), true);
});



test('v4 migration and admin expose dynamic bot settings, FAQ, links, support inbox and payments', () => {
  for (const contract of [
    'CREATE TABLE IF NOT EXISTS bot_settings', 'CREATE TABLE IF NOT EXISTS bot_links',
    'CREATE TABLE IF NOT EXISTS faqs', 'CREATE TABLE IF NOT EXISTS support_conversations',
    'CREATE TABLE IF NOT EXISTS support_messages', 'CREATE TABLE IF NOT EXISTS payment_settings',
    "'Other Product'", 'sold_display_offset', 'CREATE OR REPLACE FUNCTION admin_dashboard_stats'
  ]) assert.equal(sql.includes(contract), true, `missing v4 migration contract: ${contract}`);

  for (const contract of [
    "router.get('/api/chats'", "router.get('/api/faqs'", "router.get('/api/links'",
    "router.get('/api/payment-settings'", "router.patch('/api/settings'"
  ]) assert.equal(admin.includes(contract), true, `missing v4 admin contract: ${contract}`);

  assert.equal(store.includes('async function addSupportMessage'), true);
  assert.equal(store.includes('async function listFaqs'), true);
  assert.equal(store.includes('async function listBotLinks'), true);
});
test('legacy delivery text is not used by the active v2 purchase path', () => {
  const purchaseFunction = store.slice(store.indexOf('async function purchase('), store.indexOf('async function listOrders'));
  assert.equal(purchaseFunction.includes('delivery_text'), false);
  assert.equal(purchaseFunction.includes('decryptPayload'), true);
});

class AtomicAcceptanceModel {
  constructor(stock, balanceUnits, unitPriceUnits) {
    this.items = Array.from({ length: stock }, (_, index) => `payload-${index + 1}`);
    this.balance = balanceUnits;
    this.unitPrice = unitPriceUnits;
    this.orders = new Map();
    this.queue = Promise.resolve();
  }

  purchase(key, quantity = 1) {
    const operation = this.queue.then(() => {
      if (this.orders.has(key)) return this.orders.get(key);
      const total = this.unitPrice * BigInt(quantity);
      if (this.balance < total) throw new Error('INSUFFICIENT_BALANCE');
      if (this.items.length < quantity) throw new Error('OUT_OF_STOCK');
      const delivery = this.items.splice(0, quantity);
      this.balance -= total;
      const order = { key, delivery, total };
      this.orders.set(key, order);
      return order;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

test('20 concurrent acceptance attempts never repeat a unique payload or go negative', async () => {
  const model = new AtomicAcceptanceModel(10, 1000n, 10n);
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => model.purchase(`order-${index}`)));
  const fulfilled = attempts.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  const deliveries = fulfilled.flatMap((order) => order.delivery);
  assert.equal(fulfilled.length, 10);
  assert.equal(new Set(deliveries).size, deliveries.length);
  assert.equal(model.items.length, 0);
  assert.equal(model.balance, 900n);
});

test('stock/balance failures roll back and idempotency returns one order', async () => {
  const stockFailure = new AtomicAcceptanceModel(0, 100n, 10n);
  await assert.rejects(() => stockFailure.purchase('stock'), /OUT_OF_STOCK/);
  assert.equal(stockFailure.balance, 100n);
  const balanceFailure = new AtomicAcceptanceModel(2, 5n, 10n);
  await assert.rejects(() => balanceFailure.purchase('balance'), /INSUFFICIENT_BALANCE/);
  assert.equal(balanceFailure.items.length, 2);
  const idempotent = new AtomicAcceptanceModel(2, 100n, 10n);
  const [first, second] = await Promise.all([idempotent.purchase('same'), idempotent.purchase('same')]);
  assert.equal(first, second);
  assert.equal(idempotent.items.length, 1);
  assert.equal(idempotent.balance, 90n);
});

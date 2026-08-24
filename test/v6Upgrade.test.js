'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const keyboards = require('../src/keyboards');
const { isValidBep20TxId } = require('../src/utils');
const { BinancePayClient } = require('../src/services/binancePay');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'migration_v6_ui_bep20_binance_history.sql'), 'utf8');
const bot = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');

test('BEP20 hashes require 0x plus 64 hexadecimal characters', () => {
  assert.equal(isValidBep20TxId(`0x${'a'.repeat(64)}`), true);
  assert.equal(isValidBep20TxId('a'.repeat(64)), false);
  assert.equal(isValidBep20TxId(`0x${'z'.repeat(64)}`), false);
});

test('quantity reply keyboard mirrors stock and never offers more than stock', () => {
  const small = keyboards.quantityReply('en', { stock: 5, unlimited_stock: false }, {
    quantity_sequential_threshold: '20', quantity_buttons_per_row: '3', quantity_custom_enabled: 'true'
  }).reply_markup.keyboard;
  assert.deepEqual(small.slice(0, 2).flat().map((item) => item.text), ['1', '2', '3', '4', '5']);
  assert.equal(small.at(-1)[0].text, '❌ Cancel');
  const large = keyboards.quantityReply('en', { stock: 500, unlimited_stock: false }, {
    quantity_sequential_threshold: '20', quantity_buttons_per_row: '3', quantity_presets: '1,2,3,5,10,20', quantity_custom_enabled: 'true'
  }).reply_markup.keyboard.flat().map((item) => item.text);
  assert.equal(large.includes('500'), false);
  assert.equal(large.includes('🟣 Custom Quantity'), true);
});

test('product card keyboard starts quantity selection with one Buy Now button', () => {
  const rows = keyboards.product('en', { id: 7, active: true, product_status: 'active', stock: 5 }, { settings: {} }).reply_markup.inline_keyboard;
  assert.equal(rows[0].length, 1);
  assert.equal(rows[0][0].callback_data, 'qty:7');
  assert.equal(rows[0][0].style, 'success');
});

test('Binance verification never falls back to transactionId', async () => {
  const client = new BinancePayClient({
    isReady: true, apiKey: 'key', secretKey: 'secret', uid: '779012775', payId: '', currency: 'USDT',
    baseUrl: 'https://api.binance.com', recvWindow: 5000, timeoutMs: 1000
  }, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: '000000', data: [{
    transactionId: '447818298012852224', transactionTime: 1710000000000, amount: '1', currency: 'USDT', receiverInfo: { binanceId: '779012775' }
  }] }) }));
  await assert.rejects(() => client.verifyIncomingTransaction({
    orderId: '447818298012852224', currency: 'USDT', startTime: 1709999900000, endTime: 1710000100000
  }), (error) => error.code === 'TRANSACTION_NOT_FOUND');
});

test('v6 migration is non-destructive, enables BEP20 and preserves legacy TRC history', () => {
  assert.equal(/DROP\s+TABLE|TRUNCATE/i.test(migration), false);
  for (const contract of [
    "payment_method IN ('binance', 'usdt_bep20', 'usdt_trc20')",
    "IF p_method NOT IN ('binance', 'usdt_bep20')",
    "UPDATE payment_settings SET enabled = FALSE",
    "provider_order_id = v_order_id",
    "DUPLICATE_BINANCE_ORDER_ID",
    'CREATE TABLE IF NOT EXISTS scheduled_sales'
  ]) assert.equal(migration.includes(contract), true, `missing v6 migration contract: ${contract}`);
});

test('bot and admin expose real BEP20, Binance history and scheduled-sale controls', () => {
  for (const contract of ["bot.action('pay:bep20'", "'awaiting_bep20_txid'", "isValidBep20TxId", "payment_method === 'usdt_bep20'"]) {
    assert.equal(bot.includes(contract), true, `missing bot contract: ${contract}`);
  }
  for (const contract of [
    "router.get('/api/binance/transactions'", "router.post('/api/binance/test'",
    "router.post('/api/scheduled-sales'", "router.post('/api/scheduled-sales/:id/cancel'",
    'Refresh from Binance', 'Quantity buttons per row'
  ]) assert.equal(admin.includes(contract), true, `missing admin contract: ${contract}`);
});

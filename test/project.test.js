const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const keyboards = require('../src/keyboards');

const root = path.join(__dirname, '..');

test('legacy Telegram payment handlers are absent from the active bot', () => {
  const source = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');
  for (const forbidden of ['replyWithInvoice', 'successful_payment', 'pre_checkout_query', "currency: 'XTR'"]) {
    assert.equal(source.includes(forbidden), false, `found forbidden active payment code: ${forbidden}`);
  }
});

test('USDT reservation screen has only cancel and wallet buttons', () => {
  const rows = keyboards.usdtReservation('en', '00000000-0000-0000-0000-000000000000')
    .reply_markup.inline_keyboard;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row[0].callback_data), [
    'dep:cancel:00000000-0000-0000-0000-000000000000',
    'menu:wallet'
  ]);
  assert.equal(JSON.stringify(rows).includes('Check Payment'), false);
});

test('database migration contains atomic financial functions and uniqueness constraints', () => {
  const sql = fs.readFileSync(path.join(root, 'database.sql'), 'utf8');
  for (const required of [
    'CREATE OR REPLACE FUNCTION purchase_product',
    'CREATE OR REPLACE FUNCTION approve_manual_deposit',
    'CREATE OR REPLACE FUNCTION approve_binance_deposit',
    'uq_deposits_transaction_id',
    'uq_deposits_provider_order_id',
    'FOR UPDATE'
  ]) assert.equal(sql.includes(required), true, `missing SQL contract: ${required}`);
});

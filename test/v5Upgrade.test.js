'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const keyboards = require('../src/keyboards');

const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'migration.sql'), 'utf8');
const botSource = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');
const notificationsSource = fs.readFileSync(path.join(root, 'src/services/notifications.js'), 'utf8');

test('category catalog supports one-per-row and two-column layouts', () => {
  const categories = [
    { id: 1, name: 'ChatGPT', emoji: '🤖', active_product_count: 5, layout_override: 'inherit' },
    { id: 2, name: 'Gemini', emoji: '⭐', active_product_count: 3, layout_override: 'inherit' },
    { id: 3, name: 'CapCut', emoji: '🎬', active_product_count: 4, layout_override: 'inherit' }
  ];
  const full = keyboards.categories('en', categories, 0, false, { layout: 'full' }).reply_markup.inline_keyboard;
  assert.equal(full[0].length, 1);
  assert.equal(full[1].length, 1);
  assert.equal(full[2].length, 1);
  const two = keyboards.categories('en', categories, 0, false, { layout: 'two' }).reply_markup.inline_keyboard;
  assert.equal(two[0].length, 2);
  assert.equal(two[1].length, 1);
});

test('uncategorized products appear as full-width Other Products rows', () => {
  const rows = keyboards.categories('en', [], 0, false, {
    layout: 'full',
    uncategorizedTitle: '📦 Other Products',
    uncategorized: [{ id: 91, name: 'Office 365', emoji: '📎', price: '0.99', stock: 12, active: true, product_status: 'active' }]
  }).reply_markup.inline_keyboard;
  assert.equal(rows[0][0].callback_data, 'catalog:other');
  assert.equal(rows[1].length, 1);
  assert.equal(rows[1][0].callback_data, 'prd:91');
  assert.match(rows[1][0].text, /✅ 12/);
  const details = keyboards.product('en', { id: 91, category_id: null, stock: 12, active: true, product_status: 'active', max_quantity: 1 }, {});
  assert.equal(details.reply_markup.inline_keyboard.at(-1)[0].callback_data, 'menu:products');
});

test('persistent keyboard exposes Shop and Deposit actions', () => {
  const keyboard = keyboards.persistentActions('en', { settings: {} }).reply_markup;
  assert.equal(keyboard.resize_keyboard, true);
  assert.equal(keyboard.is_persistent, true);
  assert.deepEqual(keyboard.keyboard[0].map((button) => button.text), ['➕ Deposit', '🛍️ Shop']);
});

test('v5 migration is non-destructive and adds notification persistence', () => {
  for (const contract of [
    'ALTER TABLE products ALTER COLUMN category_id DROP NOT NULL',
    'CREATE TABLE IF NOT EXISTS user_ui_state',
    'CREATE TABLE IF NOT EXISTS notification_rules',
    'CREATE TABLE IF NOT EXISTS notification_destinations',
    'CREATE TABLE IF NOT EXISTS notification_jobs',
    'CREATE TABLE IF NOT EXISTS notification_job_deliveries',
    'CREATE TABLE IF NOT EXISTS product_notification_state',
    'FOR UPDATE SKIP LOCKED',
    "('category_layout','full'",
    "('persistent_bottom_keyboard','true'",
    'CREATE OR REPLACE FUNCTION admin_adjust_wallet'
  ]) assert.equal(sql.includes(contract), true, `missing v5 migration contract: ${contract}`);
  assert.equal(/DROP\s+TABLE/i.test(sql), false, 'upgrade migration must not drop tables');
});

test('bot and admin expose deep links, safe navigation, and automation controls', () => {
  for (const contract of [
    'payload.match(/^product_(\\d+)$/)', 'last_menu_message_id', 'persistentActions', "product.fulfillment_type === 'manual' ? '📎' : '🔗'"
  ]) assert.equal(botSource.includes(contract), true, `missing bot contract: ${contract}`);
  for (const contract of [
    "router.get('/api/notification-automation'", "router.post('/api/users/:id/wallet-adjustment'", 'No Category / Other Products', 'Notifications / Automation', 'category_layout', 'theme-switcher', 'Apply wallet adjustment'
  ]) assert.equal(adminSource.includes(contract), true, `missing admin contract: ${contract}`);
  for (const contract of ['retry_after', 'claim_notification_job', 'retry_targets', 'selling_fast_', 'notification_job_deliveries']) {
    assert.equal(notificationsSource.includes(contract), true, `missing automation contract: ${contract}`);
  }
});

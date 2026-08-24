'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildDeliveryView, assertDeliveryCount } = require('../src/services/delivery');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'migration_delivery_v2.sql'), 'utf8');
const botSource = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');

const escape = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function order(snapshot, deliveries, quantity = deliveries.length) {
  return {
    id: 77,
    order_id: 77,
    product_id: 9,
    product_name: snapshot.product_name,
    quantity,
    fulfillment_type: 'instant',
    status: 'delivered',
    delivery_time_snapshot: snapshot.delivery_time,
    warranty_value_snapshot: snapshot.warranty_value,
    warranty_unit_snapshot: snapshot.warranty_unit,
    delivery_snapshot: snapshot,
    deliveries
  };
}

test('renderer matches the required delivery card and excludes product description', () => {
  const view = buildDeliveryView(order({
    product_name: 'Netflix Admin 5 Profile Premium 4K UHD 1 month',
    subtitle: 'Ignored subtitle', duration: '1 Month', product_type: 'Instant', emoji: '🎁',
    full_description: 'MUST NOT APPEAR', public_instructions: 'MUST NOT APPEAR',
    delivery_details: '🌐 موقع التشغيل: https://netflix.com\n📱 الأجهزة المدعومة: Android / iPhone / TV',
    delivery_time: 'Instant', warranty_value: 27, warranty_unit: 'days'
  }, ['ASdfSA']), ['ASdfSA'], 'en', { escape });
  const message = view.chunks[0];
  assert.match(message, /🎁 <b>Your Order Is Ready<\/b>/);
  assert.match(message, /🛍️ <b>Netflix Admin 5 Profile Premium 4K UHD 1 month<\/b>/);
  assert.match(message, /🔗 <b>Type:<\/b> Instant/);
  assert.match(message, /🛡️ <b>Warranty:<\/b> 27 day/);
  assert.match(message, /🆔 <b>Order:<\/b> #77/);
  assert.match(message, /Delivery Details/);
  assert.match(message, /netflix\.com/);
  assert.match(message, /🎁 <b>Delivery Data<\/b>/);
  assert.match(message, /<pre>ASdfSA<\/pre>/);
  assert.doesNotMatch(message, /MUST NOT APPEAR/);
  assert.doesNotMatch(message, /Duration/);
  assert.doesNotMatch(message, /How to use/);
});

test('renderer escapes special credential characters without changing payload', () => {
  const payload = '<x>&"\'\n  spaced';
  const view = buildDeliveryView(order({
    product_name: 'Safe', full_description: '', public_instructions: '', delivery_time: '', warranty_value: null, warranty_unit: ''
  }, [payload]), [payload], 'en', { escape });
  assert.match(view.chunks[0], /&lt;x&gt;&amp;&quot;&#39;\n  spaced/);
  assert.doesNotMatch(view.chunks[0], /<x>/);
});

test('renderer preserves five quantity items and never splits an item block', () => {
  const deliveries = Array.from({ length: 5 }, (_, i) => `credential-${i + 1}`);
  const view = buildDeliveryView(order({ product_name: 'Multi', delivery_time: 'Instant', warranty_value: 1, warranty_unit: 'months' }, deliveries), deliveries, 'en', { escape, limit: 1000 });
  assert.equal(view.summary.quantity, 5);
  for (const item of deliveries) assert.ok(view.parts.some((part) => part.type === 'message' && part.text.includes(item)));
  assertDeliveryCount(order({ product_name: 'Multi', delivery_time: 'Instant', warranty_value: 1, warranty_unit: 'months' }, deliveries), deliveries);
});

test('oversized single credential becomes a txt document instead of being cut', () => {
  const payload = 'A'.repeat(12000);
  const deliveries = [payload];
  const view = buildDeliveryView(order({ product_name: 'Long', delivery_time: 'Instant', warranty_value: 1, warranty_unit: 'months' }, deliveries), deliveries, 'en', { escape, limit: 3900 });
  assert.equal(view.parts.filter((part) => part.type === 'document').length, 1);
  assert.equal(view.parts.find((part) => part.type === 'document').value, payload);
});

test('renderer falls back safely for old orders with missing snapshot fields', () => {
  const legacy = { id: 88, product_name: 'Legacy', quantity: 1, fulfillment_type: 'instant', status: 'delivered', public_instructions_snapshot: '' };
  const view = buildDeliveryView(legacy, ['legacy-payload'], 'en', { escape });
  assert.match(view.chunks[0], /Legacy/);
  assert.ok(!view.chunks[0].includes('undefined'));
});

test('Delivery Details button persists existing product value through the admin API', () => {
  assert.match(adminSource, /button\('Delivery Details'/);
  assert.match(adminSource, /api\('\/products\/'\+product\.id,\{method:'PATCH',body:\{delivery_text:value\}\}\)/);
});

test('architecture uses the centralized renderer in purchase, order details, and manual delivery', () => {
  assert.match(botSource, /buildDeliveryView\(order, order\.deliveries/);
  assert.match(botSource, /if \(order\.deliveries\?\.length\) \{\s*await sendDeliveryPayloads/s);
  assert.match(adminSource, /buildDeliveryView\(deliveredOrder, deliveredOrder\.deliveries/);
  assert.match(adminSource, /getOrderDetails\(result\.telegram_id, id\)/);
});

test('delivery migration is additive and snapshots product content atomically in purchase RPC', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS delivery_snapshot JSONB/i);
  assert.match(migration, /jsonb_build_object\(/i);
  assert.match(migration, /full_description.*v_product\.full_description/i);
  assert.match(migration, /public_instructions.*v_product\.public_instructions/i);
  assert.match(migration, /INSERT INTO orders\(/i);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|DELETE FROM orders|DELETE FROM product_inventory_items|TRUNCATE/i);
});


test('renders free-form Delivery Details before credentials', () => {
  const order = {
    id: 99, status: 'delivered', fulfillment_type: 'instant', quantity: 1,
    delivery_snapshot: { product_name: 'Netflix', delivery_details: '🌐 Site: https://netflix.com\n📱 Devices: Android / TV' }
  };
  const view = buildDeliveryView(order, ['email@example.com\nPASS'], 'en');
  assert.match(view.parts[0].text, /Delivery Details/);
  assert.match(view.parts[0].text, /netflix\.com/);
  assert.ok(view.parts[0].text.indexOf('Delivery Details') < view.parts[0].text.indexOf('Delivery Data'));
});

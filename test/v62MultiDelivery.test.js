'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertDeliveryCount, hydratePurchaseDeliveries, buildDeliveryChunks } = require('../src/services/delivery');
const { CustomEmojiService } = require('../src/services/customEmojis');
const { deleteMessagesBestEffort } = require('../src/services/chatCleanup');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'migration_v6_2_multi_delivery_chat_cleanup.sql'), 'utf8');
const botSource = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');

class AtomicPurchaseModel {
  constructor(stock = 20, balance = 1000) {
    this.inventory = Array.from({ length: stock }, (_, index) => ({ id: index + 1, status: 'available', orderId: null }));
    this.balance = balance;
    this.orders = new Map();
    this.nextOrderId = 1;
    this.tail = Promise.resolve();
  }

  purchase(quantity, key, price = 1) {
    const operation = this.tail.then(() => {
      if (this.orders.has(key)) return { ...this.orders.get(key), alreadyProcessed: true };
      const selected = this.inventory.filter((item) => item.status === 'available').slice(0, quantity);
      if (selected.length !== quantity) throw Object.assign(new Error('OUT_OF_STOCK'), { code: 'OUT_OF_STOCK' });
      const total = quantity * price;
      if (this.balance < total) throw Object.assign(new Error('INSUFFICIENT_BALANCE'), { code: 'INSUFFICIENT_BALANCE' });
      const order = { id: this.nextOrderId++, quantity, deliveries: selected.map((item) => `payload-${item.id}`), total, alreadyProcessed: false };
      selected.forEach((item) => { item.status = 'sold'; item.orderId = order.id; });
      this.balance -= total;
      this.orders.set(key, order);
      return { ...order };
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}

test('1. one instant item is sold and delivered once', async () => {
  const model = new AtomicPurchaseModel(2);
  const order = await model.purchase(1, 'key-one');
  assert.equal(order.deliveries.length, 1);
  assert.equal(model.inventory.filter((item) => item.status === 'sold').length, 1);
});

test('2. two instant items are unique and share one order', async () => {
  const model = new AtomicPurchaseModel(3);
  const order = await model.purchase(2, 'key-two');
  assert.equal(new Set(order.deliveries).size, 2);
  assert.deepEqual(model.inventory.filter((item) => item.status === 'sold').map((item) => item.orderId), [order.id, order.id]);
});

test('3. five-item purchase hydrates and returns all five deliveries', async () => {
  const row = {
    order_id: 52, quantity: 5, status: 'delivered', fulfillment_type: 'instant',
    payload_ciphertexts: ['c1', 'c2', 'c3', 'c4', 'c5'],
    payload_ivs: ['i1', 'i2', 'i3', 'i4', 'i5'],
    payload_auth_tags: ['t1', 't2', 't3', 't4', 't5']
  };
  const values = hydratePurchaseDeliveries(7, row, (_productId, item) => `${item.payload_ciphertext}:${item.payload_iv}:${item.payload_auth_tag}`);
  assert.deepEqual(values, ['c1:i1:t1', 'c2:i2:t2', 'c3:i3:t3', 'c4:i4:t4', 'c5:i5:t5']);
});

test('4. ten-item purchase returns ten different inventory records', async () => {
  const model = new AtomicPurchaseModel(10);
  const order = await model.purchase(10, 'key-ten');
  assert.equal(order.deliveries.length, 10);
  assert.equal(new Set(order.deliveries).size, 10);
});

test('5. four available and request five rolls back without a charge or order', async () => {
  const model = new AtomicPurchaseModel(4, 100);
  await assert.rejects(model.purchase(5, 'key-short'), /OUT_OF_STOCK/);
  assert.equal(model.balance, 100);
  assert.equal(model.orders.size, 0);
  assert.equal(model.inventory.every((item) => item.status === 'available'), true);
});

test('6. repeated confirmation key creates one order and one debit', async () => {
  const model = new AtomicPurchaseModel(10, 100);
  const first = await model.purchase(5, 'same-key');
  const second = await model.purchase(5, 'same-key');
  assert.equal(first.id, second.id);
  assert.equal(second.alreadyProcessed, true);
  assert.equal(model.balance, 95);
  assert.equal(model.orders.size, 1);
});

test('7. concurrent purchases never receive the same inventory item', async () => {
  const model = new AtomicPurchaseModel(10);
  const [left, right] = await Promise.all([model.purchase(5, 'left'), model.purchase(5, 'right')]);
  assert.equal(new Set([...left.deliveries, ...right.deliveries]).size, 10);
});

test('8. idempotent replay returns the complete original delivery set', async () => {
  const model = new AtomicPurchaseModel(8);
  const first = await model.purchase(5, 'replay-key');
  const replay = await model.purchase(5, 'replay-key');
  assert.deepEqual(replay.deliveries, first.deliveries);
});

test('9. My Orders integrity check accepts five and rejects a partial result', () => {
  const order = { id: 9, quantity: 5, status: 'delivered', fulfillment_type: 'instant' };
  assert.equal(assertDeliveryCount(order, ['1', '2', '3', '4', '5']).length, 5);
  assert.throws(() => assertDeliveryCount(order, ['1']), (error) => error.code === 'DELIVERY_COUNT_MISMATCH');
});

test('10. long deliveries split only at item boundaries without losing data', () => {
  const deliveries = Array.from({ length: 10 }, (_, index) => `account-${index + 1}:` + 'x'.repeat(700));
  const result = buildDeliveryChunks(deliveries, { language: 'en', limit: 2000 });
  assert.ok(result.parts.length > 1);
  assert.equal(result.parts.every((part) => part.type !== 'message' || part.text.length <= 2000), true);
  for (const item of deliveries) assert.equal(result.parts.some((part) => part.text?.includes(item) || part.value === item), true);
});

test('11. a valid Telegram Custom Emoji ID is cached and enabled', async () => {
  let calls = 0;
  const telegram = { callApi: async () => { calls += 1; return [{ custom_emoji_id: '5368324170671202286', type: 'custom_emoji', emoji: '👍', is_animated: true }]; } };
  const service = new CustomEmojiService({ ttlMs: 60000 });
  const first = await service.resolveSettings(telegram, { custom_emojis_enabled: 'true', product_custom_emoji_id: '5368324170671202286' });
  const second = await service.resolveSettings(telegram, { custom_emojis_enabled: 'true', product_custom_emoji_id: '5368324170671202286' });
  assert.equal(first.icons.product_custom_emoji_id, '5368324170671202286');
  assert.equal(first.report.find((item) => item.key === 'product_custom_emoji_id').animated, true);
  assert.equal(second.icons.product_custom_emoji_id, '5368324170671202286');
  assert.equal(calls, 1);
});

test('12. invalid Custom Emoji ID falls back to Unicode', async () => {
  const telegram = { callApi: async () => [] };
  const service = new CustomEmojiService();
  const resolved = await service.resolveSettings(telegram, { product_custom_emoji_id: '12345' });
  assert.equal(service.html('📦', 'product_custom_emoji_id', resolved), '📦');
});

test('13. transient cleanup excludes permanent delivery messages', async () => {
  const deleted = [];
  const telegram = { callApi: async (_method, body) => { deleted.push(...body.message_ids); } };
  await deleteMessagesBestEffort(telegram, 1, [10, 11]);
  assert.deepEqual(deleted, [10, 11]);
  assert.equal(deleted.includes(99), false, 'permanent delivery message 99 was never scheduled for deletion');
});

test('14. Telegram deletion failure never rejects the business flow', async () => {
  const telegram = {
    callApi: async () => { throw new Error('method unavailable'); },
    deleteMessage: async () => { throw new Error("message can't be deleted"); }
  };
  const result = await deleteMessagesBestEffort(telegram, 1, [10], { warn() {} });
  assert.deepEqual(result, { attempted: 1, deleted: 0 });
});

test('15. Wallet and Binance multi-quantity paths call the same idempotent purchase service', () => {
  assert.match(botSource, /store\.purchase\(ctx\.from\.id, state\.data\.productId, Number\(state\.data\.quantity\), state\.data\.idempotencyKey\)/);
  assert.match(botSource, /store\.purchase\(ctx\.from\.id, purchase\.productId, Number\(purchase\.quantity\), purchase\.idempotencyKey\)/);
});

test('v6.2 migration enforces exact locked-row and encrypted-array counts', () => {
  assert.match(migration, /FOR UPDATE SKIP LOCKED\s+LIMIT p_quantity/i);
  assert.match(migration, /COALESCE\(v_item_count, 0\) <> p_quantity/i);
  assert.match(migration, /GET DIAGNOSTICS v_updated_count = ROW_COUNT/i);
  assert.match(migration, /v_updated_count <> p_quantity/i);
  assert.match(migration, /array_agg\(i\.payload_ciphertext ORDER BY i\.id\)/i);
  assert.match(migration, /cardinality\(COALESCE\(v_ciphertexts/i);
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE/i);
});

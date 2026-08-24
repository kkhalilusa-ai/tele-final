const { db, unwrap } = require('../database');
const { config } = require('../config');
const { encryptPayload, decryptPayload, maskPayload, encryptionConfigured } = require('../security/inventoryCrypto');
const { assertDeliveryCount, hydratePurchaseDeliveries } = require('./delivery');
const liveEvents = require('./liveEvents');
const notifications = require('./notifications');

const PAGE_SIZE = 8;

async function ensureUser(from, referralPayload = null) {
  const payload = String(referralPayload || '').trim();
  const userReferralMatch = /^ref_([A-Za-z0-9]{4,16})$/.exec(payload);

  // Keep first-contact semantics explicit in Node as a safety net. This is
  // important when the deployed Supabase RPC is older than the bundled SQL.
  let wasNew = false;
  if (userReferralMatch) {
    const existing = await db().from('users')
      .select('id,referred_by_user_id,referred_by_merchant_link_id')
      .eq('telegram_id', from.id)
      .maybeSingle();
    unwrap(existing, 'check existing referral user');
    wasNew = !existing.data;
  }

  const result = await db().rpc('ensure_bot_user', {
    p_telegram_id: from.id,
    p_username: from.username || null,
    p_first_name: from.first_name || null,
    p_default_language: config.defaultLanguage,
    p_last_name: from.last_name || null,
    p_referral_payload: payload || null
  });
  const user = unwrap(result, 'ensure user')[0] || result.data;

  // Fallback for user referrals: if the first-contact RPC did not attribute
  // the user, apply it here. Existing users are never newly attributed.
  if (wasNew && userReferralMatch && user && !user.referred_by_user_id && !user.referred_by_merchant_link_id) {
    const referralCode = userReferralMatch[1];
    const referrerResult = await db().from('users')
      .select('id')
      .eq('referral_code', referralCode)
      .maybeSingle();
    const referrer = unwrap(referrerResult, 'find referral owner');

    if (referrer.data && referrer.data.id !== user.id) {
      const attributed = await db().from('users')
        .update({
          referred_by_user_id: referrer.data.id,
          referred_by_type: 'user',
          referred_by_merchant_link_id: null,
          attributed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', user.id)
        .is('referred_by_user_id', null)
        .select()
        .maybeSingle();
      unwrap(attributed, 'apply referral attribution');
      return attributed.data || user;
    }
  }

  return user;
}

async function completeOnboarding(telegramId, language) {
  const row = unwrap(await db().rpc('complete_onboarding', {
    p_telegram_id: telegramId,
    p_language: language
  }), 'complete onboarding')[0];
  return row;
}

async function getUser(telegramId) {
  return unwrap(
    await db().from('users').select('*').eq('telegram_id', telegramId).single(),
    'get user'
  );
}

async function setLanguage(telegramId, language) {
  return unwrap(
    await db().from('users').update({ language, updated_at: new Date().toISOString() })
      .eq('telegram_id', telegramId).select().single(),
    'set language'
  );
}

async function listCategories(page = 0) {
  const start = page * PAGE_SIZE;
  const rows = unwrap(
    await db().from('category_catalog').select('id,name,emoji,sort_order,layout_override,available_product_count,active_product_count').eq('active', true)
      .order('sort_order').order('name').range(start, start + PAGE_SIZE),
    'list categories'
  );
  return { items: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE };
}

async function getCategory(id) {
  return unwrap(await db().from('categories').select('id,name,emoji,active,sort_order,layout_override').eq('id', id).single(), 'get category');
}

async function getCatalogSummary() {
  const [categories, products] = await Promise.all([
    db().from('categories').select('*', { count: 'exact', head: true }).eq('active', true),
    db().from('products').select('*', { count: 'exact', head: true }).in('product_status', ['active', 'out_of_stock'])
  ]);
  unwrap(categories, 'count categories');
  unwrap(products, 'count products');
  return { categories: categories.count || 0, products: products.count || 0 };
}

async function listProducts(categoryId, page = 0) {
  const start = page * PAGE_SIZE;
  const rows = unwrap(
    await db().from('product_catalog').select('id,category_id,name,subtitle,duration,product_type,currency,product_status,price,stock,available_stock,unlimited_stock,active,emoji,delivery_time_label,fulfillment_type,allow_preorder,sort_order,sold_count')
      .eq('category_id', categoryId).in('product_status', ['active', 'out_of_stock']).order('sort_order').order('name').range(start, start + PAGE_SIZE),
    'list products'
  );
  return {
    items: rows.slice(0, PAGE_SIZE).map((row) => ({
      ...row,
      stock: row.fulfillment_type === 'instant' ? row.available_stock : (row.unlimited_stock ? null : row.available_stock)
    })),
    hasNext: rows.length > PAGE_SIZE
  };
}

async function listUncategorizedProducts(page = 0) {
  const start = page * PAGE_SIZE;
  const rows = unwrap(
    await db().from('product_catalog').select('id,category_id,name,subtitle,duration,product_type,currency,product_status,price,stock,available_stock,unlimited_stock,active,emoji,delivery_time_label,fulfillment_type,allow_preorder,sort_order,sold_count')
      .is('category_id', null).in('product_status', ['active', 'out_of_stock']).order('sort_order').order('name').range(start, start + PAGE_SIZE),
    'list uncategorized products'
  );
  return {
    items: rows.slice(0, PAGE_SIZE).map((row) => ({
      ...row,
      stock: row.fulfillment_type === 'instant' ? row.available_stock : (row.unlimited_stock ? null : row.available_stock)
    })),
    hasNext: rows.length > PAGE_SIZE
  };
}

async function getProduct(id) {
  const [productResult, tierResult] = await Promise.all([
    db().from('product_catalog').select('*').eq('id', id).single(),
    db().from('bulk_pricing_tiers').select('id,min_quantity,max_quantity,unit_price').eq('product_id', id).order('min_quantity')
  ]);
  const product = unwrap(productResult, 'get product');
  const tiers = unwrap(tierResult, 'get bulk pricing');
  return {
    ...product,
    description: product.full_description || product.description || '',
    stock: product.fulfillment_type === 'instant' ? product.available_stock : (product.unlimited_stock ? null : product.available_stock),
    bulk_pricing_tiers: tiers
  };
}

async function purchase(telegramId, productId, quantity = 1, idempotencyKey) {
  if (typeof quantity === 'string' && idempotencyKey === undefined) {
    idempotencyKey = quantity;
    quantity = 1;
  }
  const product = await getProduct(productId);
  if (product.fulfillment_type === 'instant' && !encryptionConfigured()) {
    throw Object.assign(new Error('Inventory encryption is not configured.'), { code: 'INVENTORY_ENCRYPTION_KEY_NOT_CONFIGURED' });
  }
  const upgraded = await db().rpc('purchase_product_v2', {
    p_telegram_id: telegramId,
    p_product_id: productId,
    p_quantity: quantity,
    p_idempotency_key: idempotencyKey
  });
  const row = unwrap(upgraded, 'purchase product v2')[0];
  const deliveries = hydratePurchaseDeliveries(productId, row, decryptPayload);

  // The purchase RPC intentionally returns a compact payment payload.
  // My Orders, however, renders delivery from the persisted order snapshots
  // (including delivery_snapshot / warranty snapshots / delivery details).
  // Re-read the just-created order here so instant post-payment delivery gets
  // exactly the same source data as My Orders instead of a reduced RPC row.
  const persistedOrder = await getOrderDetails(telegramId, row.order_id);

  liveEvents.publish(['dashboard', 'products', 'inventory', 'orders', 'wallet'], { source: 'purchase' });
  getProduct(productId).then((afterProduct) => notifications.captureProductChange(product, afterProduct))
    .catch((error) => console.warn('purchase_notification_capture_failed', { productId, message: error.message }));
  return { ...(persistedOrder || {}), ...row, deliveries };
}

async function listOrders(telegramId, page = 0, admin = false) {
  const start = page * PAGE_SIZE;
  let query = db().from('orders').select('id,user_id,product_id,product_name,amount,total_amount,unit_price,quantity,status,fulfillment_type,delivery_time_snapshot,warranty_value_snapshot,warranty_unit_snapshot,created_at,delivered_at,users!inner(telegram_id)')
    .order('created_at', { ascending: false }).range(start, start + PAGE_SIZE);
  if (!admin) query = query.eq('users.telegram_id', telegramId);
  const rows = unwrap(await query, 'list orders');
  return { items: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE };
}

function orderDateRange(filter, now = new Date()) {
  const end = new Date(now);
  let start = null;
  if (filter === '7d') start = new Date(end.getTime() - 7 * 86400000);
  if (filter === '30d') start = new Date(end.getTime() - 30 * 86400000);
  if (filter === 'month') start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  if (filter === 'lastmonth') {
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
    end.setTime(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  }
  return { from: start?.toISOString() || null, to: filter === 'lastmonth' ? end.toISOString() : null };
}

async function listUserOrders(telegramId, page = 0, filter = 'all') {
  const { from, to } = orderDateRange(filter);
  const start = page * PAGE_SIZE;
  let query = db().from('orders').select('id,product_name,total_amount,amount,status,quantity,fulfillment_type,created_at,users!inner(telegram_id)', { count: 'exact' })
    .eq('users.telegram_id', telegramId).order('created_at', { ascending: false }).range(start, start + PAGE_SIZE);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lt('created_at', to);
  const [ordersResult, summaryResult] = await Promise.all([
    query,
    db().rpc('user_order_summary', { p_telegram_id: telegramId, p_from: from, p_to: to })
  ]);
  const rows = unwrap(ordersResult, 'list user orders');
  const summary = unwrap(summaryResult, 'summarize user orders')[0] || { total: 0, delivered: 0, spent: '0' };
  return { items: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE, count: ordersResult.count || Number(summary.total || 0), summary };
}

async function getOrderDetails(telegramId, orderId, admin = false) {
  let query = db().from('orders').select('*,users!inner(telegram_id,language,username,first_name)').eq('id', orderId);
  if (!admin) query = query.eq('users.telegram_id', telegramId);
  const order = unwrap(await query.maybeSingle(), 'get order details');
  if (!order) return null;
  const deliveries = [];
  if (order.status === 'delivered') {
    if (order.fulfillment_type === 'instant') {
      const items = unwrap(await db().from('product_inventory_items')
        .select('payload_ciphertext,payload_iv,payload_auth_tag').eq('order_id', order.id).order('id'), 'get order inventory');
      for (const item of items) deliveries.push(decryptPayload(order.product_id, item));
    } else if (order.delivery_ciphertext) {
      deliveries.push(decryptPayload(order.product_id, {
        payload_ciphertext: order.delivery_ciphertext,
        payload_iv: order.delivery_iv,
        payload_auth_tag: order.delivery_auth_tag
      }));
    } else if (order.delivery_data) {
      deliveries.push(order.delivery_data);
    }
  }
  assertDeliveryCount(order, deliveries);
  return { ...order, deliveries };
}

async function listPreorderProducts(page = 0) {
  const start = page * PAGE_SIZE;
  const rows = unwrap(await db().from('product_catalog').select('id,name,price,emoji,delivery_time_label,warranty_value,warranty_unit,available_stock,unlimited_stock')
    .eq('active', true).eq('allow_preorder', true).order('sort_order').order('name').range(start, start + PAGE_SIZE), 'list preorders');
  return { items: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE };
}

async function listRefundEligibleOrders(telegramId) {
  return unwrap(await db().from('orders').select('id,product_name,total_amount,amount,status,delivered_at,created_at,users!inner(telegram_id)')
    .eq('users.telegram_id', telegramId).in('status', ['processing', 'delivered'])
    .order('created_at', { ascending: false }).limit(20), 'list refund eligible orders');
}

async function createRefundRequest(telegramId, orderId, reason) {
  const row = unwrap(await db().rpc('create_refund_request', {
    p_telegram_id: telegramId,
    p_order_id: orderId,
    p_reason: reason
  }), 'create refund request')[0];
  liveEvents.publish(['dashboard', 'refunds', 'orders'], { source: 'refund_request' });
  return row;
}

async function importInventory(productId, payloads, actorTelegramId) {
  const product = await getProduct(productId);
  if (product.fulfillment_type !== 'instant') throw Object.assign(new Error('Inventory items can only be imported for instant products.'), { code: 'PRODUCT_NOT_INSTANT' });
  const unique = [...new Set(payloads.map((value) => String(value).trim()).filter(Boolean))];
  if (!unique.length || unique.length > 5000) throw Object.assign(new Error('Import between 1 and 5000 non-empty lines.'), { code: 'INVALID_INVENTORY_IMPORT' });
  const rows = unique.map((payload) => ({ product_id: productId, created_by: actorTelegramId, ...encryptPayload(productId, payload) }));
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += 250) {
    const result = await db().from('product_inventory_items').upsert(rows.slice(offset, offset + 250), {
      onConflict: 'product_id,payload_hash', ignoreDuplicates: true
    }).select('id');
    inserted += unwrap(result, 'import inventory').length;
  }
  liveEvents.publish(['dashboard', 'products', 'inventory'], { source: 'inventory_import' });
  if (inserted > 0) {
    getProduct(productId).then((afterProduct) => notifications.captureProductChange(product, afterProduct))
      .catch((error) => console.warn('inventory_notification_capture_failed', { productId, message: error.message }));
  }
  return { requested: payloads.length, valid: unique.length, inserted, duplicates: unique.length - inserted };
}

async function listInventoryItems(productId, page = 1, limit = 25, status = '', search = '') {
  const from = (page - 1) * limit;
  let query = db().from('product_inventory_items').select('id,product_id,status,order_id,created_at,sold_at,updated_at,payload_ciphertext,payload_iv,payload_auth_tag', { count: 'exact' })
    .eq('product_id', productId).order('id', { ascending: false }).range(from, from + limit - 1);
  if (status) query = query.eq('status', status);
  if (search) {
    if (!/^\d+$/.test(search)) return { items: [], count: 0 };
    query = query.or(`id.eq.${search},order_id.eq.${search}`);
  }
  const result = await query;
  const rows = unwrap(result, 'list inventory items').map((item) => {
    let preview = 'Encrypted item';
    try { preview = maskPayload(decryptPayload(productId, item)); } catch (_) { preview = 'Unavailable with current key'; }
    const { payload_ciphertext, payload_iv, payload_auth_tag, ...safe } = item;
    return { ...safe, preview };
  });
  return { items: rows, count: result.count || 0 };
}

async function deleteInventoryItem(productId, itemId) {
  const existing = unwrap(await db().from('product_inventory_items').select('id,status,order_id')
    .eq('id', itemId).eq('product_id', productId).maybeSingle(), 'get inventory item');
  if (!existing) return null;
  if (existing.status === 'sold' || existing.status === 'reserved' || existing.order_id) {
    throw Object.assign(new Error('Sold or reserved inventory cannot be deleted.'), { code: 'INVENTORY_LOCKED' });
  }
  const row = unwrap(await db().from('product_inventory_items').delete().eq('id', itemId).eq('product_id', productId).select('id,product_id,status').maybeSingle(), 'delete inventory item');
  liveEvents.publish(['dashboard','products','inventory'], { source: 'inventory_delete' });
  return row;
}

async function exportInventoryItems(productId, status = 'available') {
  if (!['available','disabled','reserved','sold','all'].includes(status)) throw new Error('Invalid export status.');
  let query = db().from('product_inventory_items').select('id,product_id,status,order_id,payload_ciphertext,payload_iv,payload_auth_tag').eq('product_id', productId).order('id').limit(10000);
  if (status !== 'all') query = query.eq('status', status);
  const rows = unwrap(await query, 'export inventory');
  return rows.map((item) => ({ id:item.id, status:item.status, order_id:item.order_id, payload:decryptPayload(productId,item) }));
}

async function inventoryStatusCounts(productId) {
  const statuses = ['available', 'sold', 'disabled', 'reserved'];
  const results = await Promise.all(statuses.map((status) => db().from('product_inventory_items')
    .select('*', { count: 'exact', head: true }).eq('product_id', productId).eq('status', status)));
  const counts = {};
  results.forEach((result, index) => { unwrap(result, `count ${statuses[index]} inventory`); counts[statuses[index]] = result.count || 0; });
  return counts;
}

async function revealInventoryItem(productId, itemId) {
  const item = unwrap(await db().from('product_inventory_items')
    .select('id,product_id,status,order_id,payload_ciphertext,payload_iv,payload_auth_tag')
    .eq('id', itemId).eq('product_id', productId).maybeSingle(), 'reveal inventory item');
  if (!item) return null;
  return { id: item.id, product_id: item.product_id, status: item.status, order_id: item.order_id, payload: decryptPayload(productId, item) };
}

async function setInventoryItemStatus(productId, itemId, status) {
  const existing = unwrap(await db().from('product_inventory_items').select('id,status,order_id')
    .eq('id', itemId).eq('product_id', productId).maybeSingle(), 'get inventory item');
  if (!existing) return null;
  if (existing.status === 'sold' || existing.order_id) throw Object.assign(new Error('Sold inventory cannot be changed or reused.'), { code: 'INVENTORY_SOLD' });
  if (!['available', 'disabled'].includes(status)) throw Object.assign(new Error('Invalid inventory status.'), { code: 'INVALID_INVENTORY_STATUS' });
  const row = unwrap(await db().from('product_inventory_items').update({ status, updated_at: new Date().toISOString() })
    .eq('id', itemId).eq('product_id', productId).select('id,product_id,status,order_id,updated_at').single(), 'update inventory item');
  liveEvents.publish(['dashboard', 'products', 'inventory'], { source: 'inventory_status' });
  return row;
}

async function deliverManualOrder(orderId, adminTelegramId, payload) {
  const order = unwrap(await db().from('orders').select('id,product_id,fulfillment_type,status').eq('id', orderId).maybeSingle(), 'get manual order');
  if (!order) return null;
  const encrypted = encryptPayload(order.product_id, payload);
  const result = unwrap(await db().rpc('deliver_manual_order', {
    p_order_id: orderId,
    p_admin_telegram_id: adminTelegramId,
    p_delivery_ciphertext: encrypted.payload_ciphertext,
    p_delivery_iv: encrypted.payload_iv,
    p_delivery_auth_tag: encrypted.payload_auth_tag
  }), 'deliver manual order')[0];
  liveEvents.publish(['dashboard', 'orders', 'preorders'], { source: 'manual_delivery' });
  return { ...result };
}

async function reviewRefund(requestId, adminTelegramId, decision, note) {
  const result = unwrap(await db().rpc('review_refund_request', {
    p_request_id: requestId,
    p_admin_telegram_id: adminTelegramId,
    p_decision: decision,
    p_admin_note: note || null
  }), 'review refund request')[0];
  liveEvents.publish(['dashboard', 'refunds', 'orders', 'wallet', 'users'], { source: 'refund_review' });
  return result;
}

async function saveBulkTiers(productId, tiers) {
  return unwrap(await db().rpc('replace_bulk_pricing_tiers', {
    p_product_id: productId,
    p_tiers: tiers
  }), 'save bulk tiers');
}

async function auditAdmin(actorTelegramId, action, targetType, targetId, metadata = {}) {
  const safeMetadata = JSON.parse(JSON.stringify(metadata, (_key, value) => /payload|secret|token|password/i.test(_key) ? '[redacted]' : value));
  return unwrap(await db().from('admin_audit_log').insert({
    actor_telegram_id: actorTelegramId,
    action,
    target_type: targetType,
    target_id: String(targetId),
    metadata: safeMetadata
  }).select('id').single(), 'write admin audit');
}

async function createDeposit(telegramId, method, amount, expiryMinutes, paymentAddress = null, quote = null) {
  const result = await db().rpc('create_deposit', {
    p_telegram_id: telegramId,
    p_method: method,
    p_requested_amount: amount,
    p_expiry_minutes: expiryMinutes,
    p_payment_address: (method === 'usdt_bep20' || method === 'solana')
      ? paymentAddress
      : (config.binance.payId || config.binance.uid || null),
    p_price_used: method === 'solana' ? quote?.price : null,
    p_crypto_amount: method === 'solana' ? quote?.cryptoAmount : null,
    p_price_source: method === 'solana' ? quote?.source : null,
    p_price_at: method === 'solana' ? quote?.fetchedAt : null
  });
  const row = unwrap(result, 'create deposit')[0];
  liveEvents.publish(['dashboard', 'deposits'], { source: 'deposit_create' });
  return row;
}

async function cancelDeposit(telegramId, depositId) {
  return unwrap(await db().rpc('cancel_deposit', {
    p_telegram_id: telegramId,
    p_deposit_id: depositId
  }), 'cancel deposit')[0];
}

async function submitUsdtTxId(telegramId, depositId, txId) {
  const row = unwrap(await db().rpc('submit_usdt_txid', {
    p_telegram_id: telegramId,
    p_deposit_id: depositId,
    p_transaction_id: txId
  }), 'submit USDT TxID')[0];
  liveEvents.publish(['dashboard', 'deposits'], { source: 'deposit_submit' });
  return row;
}

async function approveDeposit(depositId, adminTelegramId) {
  const row = unwrap(await db().rpc('approve_manual_deposit', {
    p_deposit_id: depositId,
    p_admin_telegram_id: adminTelegramId
  }), 'approve deposit')[0];
  liveEvents.publish(['dashboard', 'deposits', 'users', 'wallet'], { source: 'deposit_approve' });
  return row;
}

async function rejectDeposit(depositId, adminTelegramId, reason = null) {
  const row = unwrap(await db().rpc('reject_deposit', {
    p_deposit_id: depositId,
    p_admin_telegram_id: adminTelegramId,
    p_reason: reason
  }), 'reject deposit')[0];
  liveEvents.publish(['dashboard', 'deposits'], { source: 'deposit_reject' });
  return row;
}


async function getBinanceDeposit(telegramId, depositId) {
  const result = await db().from('deposits')
    .select('id,deposit_code,user_id,requested_amount,expected_amount,received_amount,currency,payment_method,status,created_at,expires_at,transaction_id,provider_transaction_id,users!inner(telegram_id)')
    .eq('id', depositId).eq('users.telegram_id', telegramId).maybeSingle();
  return unwrap(result, 'get Binance deposit');
}

async function approveBinanceHistoryPayment(depositId, transaction) {
  const row = unwrap(await db().rpc('approve_binance_history_deposit', {
    p_deposit_id: depositId,
    // The database uniqueness/idempotency key is the Binance Order ID. The
    // provider transaction ID is informational and is never accepted from users.
    p_provider_transaction_id: transaction.orderId,
    p_received_amount: String(transaction.amount),
    p_currency: String(transaction.currency || '').toUpperCase(),
    p_paid_at: new Date(Number(transaction.transactionTime)).toISOString()
  }), 'approve Binance history deposit')[0];
  liveEvents.publish(['dashboard', 'deposits', 'users', 'wallet'], { source: 'binance_history_approve' });
  return row;
}

async function markOrderPaymentMethod(orderId, paymentMethod) {
  return unwrap(await db().from('orders').update({ payment_method: paymentMethod })
    .eq('id', orderId).select('id,payment_method').single(), 'mark order payment method');
}

async function listDeposits(telegramId, page = 0, pendingOnly = false) {
  const start = page * PAGE_SIZE;
  let query = db().from('deposits').select('id,deposit_code,user_id,payment_method,requested_amount,expected_amount,received_amount,currency,network,crypto_amount,price_used,price_source,price_at,status,transaction_id,created_at,expires_at,users!inner(telegram_id,username)')
    .order('created_at', { ascending: false }).range(start, start + PAGE_SIZE);
  if (telegramId) query = query.eq('users.telegram_id', telegramId);
  if (pendingOnly) query = query.eq('status', 'pending_review');
  const rows = unwrap(await query, 'list deposits');
  return { items: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE };
}

async function expireDeposits() {
  return unwrap(await db().rpc('expire_deposits'), 'expire deposits');
}

async function setState(telegramId, state, data = {}) {
  return unwrap(await db().from('bot_states').upsert({
    telegram_id: telegramId,
    state,
    data,
    updated_at: new Date().toISOString()
  }, { onConflict: 'telegram_id' }).select().single(), 'set bot state');
}

async function getState(telegramId) {
  const result = await db().from('bot_states').select('*').eq('telegram_id', telegramId).maybeSingle();
  return unwrap(result, 'get bot state');
}

async function clearState(telegramId) {
  unwrap(await db().from('bot_states').delete().eq('telegram_id', telegramId), 'clear bot state');
}

async function listNotifications(userId, page = 0) {
  const start = page * PAGE_SIZE;
  const rows = unwrap(await db().from('notifications').select('id,message,created_at')
    .or(`user_id.is.null,user_id.eq.${userId}`).order('created_at', { ascending: false })
    .range(start, start + PAGE_SIZE), 'list notifications');
  return { items: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE };
}

async function createNotification(message, userId = null) {
  return unwrap(await db().from('notifications').insert({ message, user_id: userId }).select().single(), 'create notification');
}

async function listUserTelegramIds(offset = 0, limit = 100) {
  return unwrap(await db().from('users').select('telegram_id').eq('is_suspended', false)
    .order('id').range(offset, offset + limit - 1), 'list users');
}

async function adminAddCategory(name) {
  return unwrap(await db().from('categories').insert({ name }).select().single(), 'add category');
}

async function adminEditCategory(id, name) {
  return unwrap(await db().from('categories').update({ name, updated_at: new Date().toISOString() }).eq('id', id).select().single(), 'edit category');
}

async function adminToggleCategory(id, active) {
  return unwrap(await db().from('categories').update({ active, updated_at: new Date().toISOString() }).eq('id', id).select().single(), 'toggle category');
}

async function adminAddProduct(categoryId, name, price, stock, deliveryText, description = '') {
  return unwrap(await db().from('products').insert({
    category_id: categoryId,
    name,
    description,
    short_description: description.slice(0, 240),
    full_description: description,
    price,
    stock,
    manual_stock: stock,
    fulfillment_type: 'manual',
    delivery_text: deliveryText,
    public_instructions: ''
  }).select().single(), 'add product');
}

async function adminCreateProduct(values, tiers = []) {
  const row = unwrap(await db().from('products').insert(values).select().single(), 'add product');
  await saveBulkTiers(row.id, tiers);
  liveEvents.publish(['dashboard', 'products', 'inventory'], { source: 'product_create' });
  const product = await getProduct(row.id);
  notifications.captureProductChange(null, product, { created: true })
    .catch((error) => console.warn('product_create_notification_failed', { productId: row.id, message: error.message }));
  return product;
}

async function adminEditProduct(id, values) {
  const previousProduct = await getProduct(id);
  if (Object.prototype.hasOwnProperty.call(values, 'active') && !Object.prototype.hasOwnProperty.call(values, 'product_status')) {
    values.product_status = values.active ? 'active' : 'inactive';
  }
  if (Object.prototype.hasOwnProperty.call(values, 'product_status')) values.active = values.product_status === 'active';
  if (values.fulfillment_type) {
    const current = unwrap(await db().from('products').select('id,fulfillment_type,manual_stock').eq('id', id).maybeSingle(), 'get product type');
    if (!current) return null;
    if (current.fulfillment_type === 'instant' && values.fulfillment_type === 'manual') {
      const active = await db().from('product_inventory_items').select('*', { count: 'exact', head: true })
        .eq('product_id', id).in('status', ['available', 'reserved']);
      unwrap(active, 'check instant inventory');
      if (active.count) throw Object.assign(new Error('Disable or sell all available inventory before switching this product to manual delivery.'), { code: 'INVENTORY_NOT_EMPTY' });
    }
    if (current.fulfillment_type === 'manual' && values.fulfillment_type === 'instant' && current.manual_stock > 0) {
      throw Object.assign(new Error('Set manual stock to zero before switching to unique instant inventory.'), { code: 'MANUAL_STOCK_NOT_EMPTY' });
    }
  }
  const row = unwrap(await db().from('products').update({ ...values, updated_at: new Date().toISOString() }).eq('id', id).select().single(), 'edit product');
  liveEvents.publish(['dashboard', 'products', 'inventory'], { source: 'product_update' });
  const currentProduct = await getProduct(id);
  notifications.captureProductChange(previousProduct, currentProduct, { forceUpdateEvent: true })
    .catch((error) => console.warn('product_update_notification_failed', { productId: id, message: error.message }));
  return currentProduct;
}

async function adminAdjustWallet(userId, amount, reason, actorTelegramId, idempotencyKey) {
  const rows = unwrap(await db().rpc('admin_adjust_wallet', {
    p_user_id: userId,
    p_delta: amount,
    p_reason: reason,
    p_admin_telegram_id: actorTelegramId,
    p_idempotency_key: idempotencyKey
  }), 'adjust wallet');
  const row = Array.isArray(rows) ? rows[0] : rows;
  liveEvents.publish(['dashboard', 'users', 'wallet'], { source: 'wallet_adjustment', userId });
  return row;
}

async function adminSetSuspended(telegramId, isSuspended) {
  return unwrap(await db().from('users').update({ is_suspended: isSuspended, updated_at: new Date().toISOString() })
    .eq('telegram_id', telegramId).select().single(), 'suspend user');
}


async function getUserStats(telegramId) {
  const summary = unwrap(await db().rpc('user_order_summary', {
    p_telegram_id: telegramId, p_from: null, p_to: null
  }), 'get user stats')[0] || { total: 0, delivered: 0, spent: '0' };
  return summary;
}

async function getUiState(telegramId) {
  return unwrap(await db().from('user_ui_state').select('*').eq('telegram_id', telegramId).maybeSingle(), 'get user ui state');
}

async function saveUiState(telegramId, values) {
  return unwrap(await db().from('user_ui_state').upsert({
    telegram_id: telegramId,
    ...values,
    updated_at: new Date().toISOString()
  }, { onConflict: 'telegram_id' }).select().single(), 'save user ui state');
}

async function clearLastMenuMessage(telegramId) {
  return saveUiState(telegramId, { last_menu_message_id: null });
}

async function rotateLastUserMessage(telegramId, messageId) {
  const current = await getUiState(telegramId);
  await saveUiState(telegramId, { last_user_message_id: messageId });
  return current?.last_user_message_id || null;
}

async function rememberTransientBotMessage(telegramId, messageId) {
  const current = await getUiState(telegramId);
  const ids = [...new Set([...(current?.transient_bot_message_ids || []), Number(messageId)])]
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .slice(-50);
  await saveUiState(telegramId, { transient_bot_message_ids: ids });
  return ids;
}

async function clearTransientBotMessages(telegramId) {
  return saveUiState(telegramId, { transient_bot_message_ids: [] });
}

async function getBotSettings() {
  const rows = unwrap(await db().from('bot_settings').select('key,value').eq('is_public', true), 'get bot settings');
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

async function saveBotSettings(values, actorTelegramId) {
  const rows = Object.entries(values).map(([key, value]) => ({
    key, value: String(value ?? ''), updated_by: actorTelegramId, updated_at: new Date().toISOString()
  }));
  if (!rows.length) return [];
  const result = unwrap(await db().from('bot_settings').upsert(rows, { onConflict: 'key' }).select('key,value'), 'save bot settings');
  liveEvents.publish(['settings', 'dashboard'], { source: 'bot_settings' });
  return result;
}

async function listBotLinks(activeOnly = false) {
  let query = db().from('bot_links').select('*').order('sort_order').order('id');
  if (activeOnly) query = query.eq('active', true);
  return unwrap(await query, 'list bot links');
}

async function saveBotLink(values, actorTelegramId, id = null) {
  const payload = { ...values, updated_by: actorTelegramId, updated_at: new Date().toISOString() };
  const query = id
    ? db().from('bot_links').update(payload).eq('id', id).select().single()
    : db().from('bot_links').insert(payload).select().single();
  const row = unwrap(await query, id ? 'update bot link' : 'create bot link');
  liveEvents.publish(['links', 'settings'], { source: 'bot_link' });
  return row;
}

async function deleteBotLink(id) {
  const row = unwrap(await db().from('bot_links').delete().eq('id', id).select().maybeSingle(), 'delete bot link');
  liveEvents.publish(['links', 'settings'], { source: 'bot_link_delete' });
  return row;
}

async function listFaqs(language = 'en', activeOnly = true) {
  let query = db().from('faqs').select('*').order('sort_order').order('id');
  if (activeOnly) query = query.eq('active', true);
  if (language) query = query.in('language', [language, 'all']);
  return unwrap(await query, 'list faqs');
}

async function saveFaq(values, actorTelegramId, id = null) {
  const payload = { ...values, updated_by: actorTelegramId, updated_at: new Date().toISOString() };
  const query = id
    ? db().from('faqs').update(payload).eq('id', id).select().single()
    : db().from('faqs').insert(payload).select().single();
  const row = unwrap(await query, id ? 'update faq' : 'create faq');
  liveEvents.publish(['faq'], { source: 'faq' });
  return row;
}

async function deleteFaq(id) {
  const row = unwrap(await db().from('faqs').delete().eq('id', id).select().maybeSingle(), 'delete faq');
  liveEvents.publish(['faq'], { source: 'faq_delete' });
  return row;
}

async function addSupportMessage(telegramId, message, telegramMessageId = null) {
  const row = unwrap(await db().rpc('add_support_message', {
    p_telegram_id: telegramId, p_message: message, p_telegram_message_id: telegramMessageId
  }), 'add support message')[0];
  liveEvents.publish(['chats', 'dashboard'], { source: 'support_user_message', conversationId: row?.conversation_id });
  return row;
}

async function listSupportConversations({ page = 1, limit = 25, status = '', search = '' } = {}) {
  const from = (page - 1) * limit;
  let query = db().from('support_conversations')
    .select('id,user_id,status,unread_admin_count,last_message_at,created_at,updated_at,users!inner(telegram_id,username,first_name,last_name)', { count: 'exact' })
    .order('last_message_at', { ascending: false }).range(from, from + limit - 1);
  if (status) query = query.eq('status', status);
  if (search) {
    const safe = String(search).replace(/[%_,()]/g, '');
    if (/^\d+$/.test(safe)) {
      const users = unwrap(await db().from('users').select('id').eq('telegram_id', safe), 'find support user');
      if (!users.length) return { items: [], count: 0 };
      query = query.in('user_id', users.map((row) => row.id));
    } else {
      const users = unwrap(await db().from('users').select('id').or(`username.ilike.%${safe}%,first_name.ilike.%${safe}%,last_name.ilike.%${safe}%`), 'find support users');
      if (!users.length) return { items: [], count: 0 };
      query = query.in('user_id', users.map((row) => row.id));
    }
  }
  const result = await query;
  const items = unwrap(result, 'list support conversations');
  return { items, count: result.count || 0 };
}

async function getOrCreateSupportConversationByTelegramId(telegramId) {
  const raw = String(telegramId ?? '').trim();
  if (!/^\d{1,20}$/.test(raw)) { const e = new Error('INVALID_TELEGRAM_ID'); e.code = 'INVALID_TELEGRAM_ID'; throw e; }
  const user = unwrap(await db().from('users').select('id,telegram_id,username,first_name,last_name').eq('telegram_id', raw).maybeSingle(), 'find support user');
  if (!user) { const e = new Error('USER_NOT_FOUND'); e.code = 'USER_NOT_FOUND'; throw e; }
  const existing = unwrap(await db().from('support_conversations').select('id').eq('user_id', user.id).maybeSingle(), 'find support conversation');
  if (existing) return getSupportConversation(existing.id);
  try {
    const created = unwrap(await db().from('support_conversations').insert({ user_id: user.id, status: 'open', unread_admin_count: 0, last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() }).select('id').single(), 'create support conversation');
    return getSupportConversation(created.id);
  } catch (error) {
    if (error?.code === '23505') {
      const raced = unwrap(await db().from('support_conversations').select('id').eq('user_id', user.id).maybeSingle(), 'recover support conversation');
      if (raced) return getSupportConversation(raced.id);
    }
    throw error;
  }
}

async function getSupportConversation(id) {
  const conversation = unwrap(await db().from('support_conversations')
    .select('id,user_id,status,unread_admin_count,last_message_at,created_at,updated_at,users!inner(telegram_id,username,first_name,last_name)')
    .eq('id', id).maybeSingle(), 'get support conversation');
  if (!conversation) return null;
  const [messageResult, orderResult] = await Promise.all([
    db().from('support_messages').select('*').eq('conversation_id', id).order('created_at'),
    db().from('orders').select('id,product_name,quantity,total_amount,amount,status,created_at').eq('user_id', conversation.user_id).order('created_at', { ascending: false }).limit(5)
  ]);
  const messages = unwrap(messageResult, 'get support messages');
  const recentOrders = unwrap(orderResult, 'get support recent orders');
  return { ...conversation, messages, recent_orders: recentOrders };
}

async function adminReplySupport(conversationId, adminTelegramId, message, telegramMessageId = null) {
  const conversation = await getSupportConversation(conversationId);
  if (!conversation) return null;
  const row = unwrap(await db().from('support_messages').insert({
    conversation_id: conversationId, sender_type: 'admin', message_text: message,
    telegram_message_id: telegramMessageId, admin_telegram_id: adminTelegramId, read_at: new Date().toISOString()
  }).select().single(), 'reply support');
  unwrap(await db().from('support_conversations').update({
    status: 'open', last_message_at: new Date().toISOString(), updated_at: new Date().toISOString()
  }).eq('id', conversationId), 'touch support conversation');
  liveEvents.publish(['chats', 'dashboard'], { source: 'support_admin_reply', conversationId });
  return { ...row, telegram_id: conversation.users.telegram_id };
}

async function setSupportConversationStatus(id, status) {
  const row = unwrap(await db().from('support_conversations').update({ status, updated_at: new Date().toISOString() }).eq('id', id).select().maybeSingle(), 'update support conversation');
  liveEvents.publish(['chats', 'dashboard'], { source: 'support_status', conversationId: id });
  return row;
}

async function markSupportRead(id) {
  const now = new Date().toISOString();
  await Promise.all([
    db().from('support_conversations').update({ unread_admin_count: 0, updated_at: now }).eq('id', id),
    db().from('support_messages').update({ read_at: now }).eq('conversation_id', id).eq('sender_type', 'user').is('read_at', null)
  ]);
  liveEvents.publish(['chats', 'dashboard'], { source: 'support_read', conversationId: id });
  return true;
}

async function getPaymentSettings() {
  return unwrap(await db().from('payment_settings').select('*').order('method_key'), 'get payment settings');
}

async function savePaymentSetting(methodKey, values, actorTelegramId) {
  const row = unwrap(await db().from('payment_settings').update({
    ...values, updated_by: actorTelegramId, updated_at: new Date().toISOString()
  }).eq('method_key', methodKey).select().single(), 'save payment setting');
  liveEvents.publish(['settings', 'payments'], { source: 'payment_settings' });
  return row;
}

async function adminCreateCategory(values) {
  const row = unwrap(await db().from('categories').insert(values).select().single(), 'create category');
  liveEvents.publish(['categories','products','dashboard'], { source: 'category_create' });
  return row;
}

async function adminUpdateCategory(id, values) {
  const row = unwrap(await db().from('categories').update({ ...values, updated_at: new Date().toISOString() }).eq('id', id).select().single(), 'update category');
  liveEvents.publish(['categories','products','dashboard'], { source: 'category_update' });
  return row;
}

async function adminDeleteCategory(id) {
  const count = await db().from('products').select('*', { count: 'exact', head: true }).eq('category_id', id);
  unwrap(count, 'check category products');
  if (count.count) throw Object.assign(new Error('Category contains products and cannot be deleted.'), { code: 'CATEGORY_NOT_EMPTY' });
  const row = unwrap(await db().from('categories').delete().eq('id', id).select().maybeSingle(), 'delete category');
  liveEvents.publish(['categories','dashboard'], { source: 'category_delete' });
  return row;
}

async function adminArchiveProduct(id) {
  const row = unwrap(await db().from('products').update({ active: false, product_status: 'draft', updated_at: new Date().toISOString() }).eq('id', id).select().maybeSingle(), 'archive product');
  liveEvents.publish(['products','inventory','dashboard'], { source: 'product_archive' });
  return row;
}

// ---------------------------------------------------------------------------
// Referrals (customer referrals + merchant referral links)
// ---------------------------------------------------------------------------

async function getReferralCode(userId) {
  const row = unwrap(await db().rpc('get_or_create_referral_code', { p_user_id: userId }), 'get referral code');
  return Array.isArray(row) ? row[0] : row;
}

async function getReferralSettings() {
  const rows = unwrap(await db().from('bot_settings').select('key,value')
    .in('key', ['referral_enabled', 'referral_commission_percent', 'menu_referrals_enabled', 'referrals_label_en', 'referrals_label_ar', 'referrals_label_hi']),
    'get referral settings');
  const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    enabled: String(map.referral_enabled || 'false').toLowerCase() === 'true',
    commissionPercent: Number(map.referral_commission_percent || '10') || 10,
    menuEnabled: String(map.menu_referrals_enabled || 'false').toLowerCase() === 'true',
    labels: { en: map.referrals_label_en || '🎁 Referrals', ar: map.referrals_label_ar || '🎁 الإحالات', hi: map.referrals_label_hi || '🎁 रेफ़रल' }
  };
}

async function saveReferralSettings(values, actorTelegramId) {
  const payload = {};
  if ('enabled' in values) { payload.referral_enabled = String(Boolean(values.enabled)); payload.menu_referrals_enabled = String(Boolean(values.enabled)); }
  if ('commissionPercent' in values) payload.referral_commission_percent = String(values.commissionPercent);
  if ('labelEn' in values) payload.referrals_label_en = values.labelEn;
  if ('labelAr' in values) payload.referrals_label_ar = values.labelAr;
  if ('labelHi' in values) payload.referrals_label_hi = values.labelHi;
  await saveBotSettings(payload, actorTelegramId);
  return getReferralSettings();
}

async function getUserReferralSummary(telegramId) {
  const user = unwrap(await db().from('users').select('id,telegram_id,referral_code,referral_active,wallet_balance').eq('telegram_id', telegramId).single(), 'get referral user');
  const code = user.referral_active !== false ? (user.referral_code || await getReferralCode(user.id)) : null;
  const [referredCountResult, purchasedResult, commissionResult] = await Promise.all([
    db().from('users').select('*', { count: 'exact', head: true }).eq('referred_by_user_id', user.id).eq('referred_by_type', 'user'),
    db().from('referral_commissions').select('referred_user_id', { count: 'exact' }).eq('beneficiary_user_id', user.id).eq('source_type', 'user_referral'),
    db().from('referral_commissions').select('commission_amount,status').eq('beneficiary_user_id', user.id).eq('source_type', 'user_referral')
  ]);
  unwrap(referredCountResult, 'count referred users');
  unwrap(purchasedResult, 'count referred purchases');
  const commissionRows = unwrap(commissionResult, 'sum referral commissions');
  const totalEarnings = commissionRows.filter((row) => row.status === 'credited').reduce((sum, row) => sum + Number(row.commission_amount || 0), 0);
  const purchasedUserIds = new Set((purchasedResult.data || []).map((row) => row.referred_user_id));
  const settings = await getReferralSettings();
  return {
    code,
    referredCount: referredCountResult.count || 0,
    purchasedCount: purchasedUserIds.size,
    commissionPercent: settings.commissionPercent,
    totalEarnings: totalEarnings.toFixed(8),
    walletBalance: user.wallet_balance,
    active: user.referral_active !== false
  };
}

async function listReferralAdminStats() {
  const [referrersResult, referredResult, ordersResult, paidResult, todayResult, monthResult] = await Promise.all([
    db().from('users').select('*', { count: 'exact', head: true }).not('referral_code', 'is', null),
    db().from('users').select('*', { count: 'exact', head: true }).eq('referred_by_type', 'user'),
    db().from('referral_commissions').select('*', { count: 'exact', head: true }).eq('source_type', 'user_referral'),
    db().from('referral_commissions').select('commission_amount').eq('source_type', 'user_referral').eq('status', 'credited'),
    db().from('referral_commissions').select('commission_amount').eq('source_type', 'user_referral').eq('status', 'credited').gte('created_at', new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString()),
    db().from('referral_commissions').select('commission_amount').eq('source_type', 'user_referral').eq('status', 'credited').gte('created_at', new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString())
  ]);
  unwrap(referrersResult, 'count referrers');
  unwrap(referredResult, 'count referred');
  unwrap(ordersResult, 'count referral orders');
  const paid = unwrap(paidResult, 'sum paid commissions').reduce((sum, row) => sum + Number(row.commission_amount || 0), 0);
  const today = unwrap(todayResult, 'sum today commissions').reduce((sum, row) => sum + Number(row.commission_amount || 0), 0);
  const month = unwrap(monthResult, 'sum month commissions').reduce((sum, row) => sum + Number(row.commission_amount || 0), 0);
  return {
    totalReferrers: referrersResult.count || 0,
    totalReferredUsers: referredResult.count || 0,
    totalReferralOrders: ordersResult.count || 0,
    totalCommissionPaid: paid.toFixed(8),
    commissionToday: today.toFixed(8),
    commissionThisMonth: month.toFixed(8)
  };
}

async function listReferralUsers({ page = 1, limit = 25, search = '' } = {}) {
  const from = (page - 1) * limit;
  let query = db().from('users').select('id,telegram_id,username,referral_code,referral_active,is_suspended', { count: 'exact' })
    .not('referral_code', 'is', null).order('id', { ascending: false }).range(from, from + limit - 1);
  if (search) {
    const safe = String(search).replace(/[%_,()]/g, '');
    query = /^\d+$/.test(safe) ? query.eq('telegram_id', safe) : query.ilike('username', `%${safe}%`);
  }
  const result = await query;
  const rows = unwrap(result, 'list referral users');
  const rowsWithStats = await Promise.all(rows.map(async (row) => {
    const [referredResult, commissionResult] = await Promise.all([
      db().from('users').select('*', { count: 'exact', head: true }).eq('referred_by_user_id', row.id).eq('referred_by_type', 'user'),
      db().from('referral_commissions').select('commission_amount,status').eq('beneficiary_user_id', row.id).eq('source_type', 'user_referral')
    ]);
    const commissions = unwrap(commissionResult, 'get referrer commissions');
    return {
      ...row,
      referral_link: `ref_${row.referral_code}`,
      referred_count: referredResult.count || 0,
      purchases_count: new Set(commissions.map((c) => c.referred_user_id)).size,
      total_commission: commissions.filter((c) => c.status === 'credited').reduce((sum, c) => sum + Number(c.commission_amount || 0), 0).toFixed(8),
      status: row.is_suspended ? 'suspended' : (row.referral_active === false ? 'disabled' : 'active')
    };
  }));
  return { items: rowsWithStats, count: result.count || 0 };
}

async function setUserReferralActive(userId, active, actorTelegramId) {
  const row = unwrap(await db().from('users').update({ referral_active: Boolean(active), updated_at: new Date().toISOString() })
    .eq('id', userId).select('id,telegram_id,username,referral_code,referral_active').maybeSingle(), 'update user referral status');
  if (row) liveEvents.publish(['settings', 'referrals', 'users'], { source: 'user_referral_status', userId, active: Boolean(active) });
  return row;
}

async function deleteUserReferral(userId, actorTelegramId) {
  const row = unwrap(await db().from('users').update({ referral_code: null, referral_active: false, updated_at: new Date().toISOString() })
    .eq('id', userId).select('id,telegram_id,username,referral_code,referral_active').maybeSingle(), 'delete user referral');
  if (row) liveEvents.publish(['settings', 'referrals', 'users'], { source: 'user_referral_delete', userId });
  return row;
}

async function listMerchantLinks({ page = 1, limit = 25, search = '' } = {}) {
  const from = (page - 1) * limit;
  let query = db().from('merchant_referral_links')
    .select('id,code,owner_user_id,label,commission_percent,active,created_at,updated_at,users!merchant_referral_links_owner_user_id_fkey(telegram_id,username)', { count: 'exact' })
    .order('created_at', { ascending: false }).range(from, from + limit - 1);
  if (search) {
    const safe = String(search).replace(/[%_,()]/g, '');
    query = query.or(`code.ilike.%${safe}%,label.ilike.%${safe}%`);
  }
  const result = await query;
  const rows = unwrap(result, 'list merchant links');
  const withStats = await Promise.all(rows.map(async (row) => {
    const [referredResult, commissionResult] = await Promise.all([
      db().from('users').select('*', { count: 'exact', head: true }).eq('referred_by_merchant_link_id', row.id),
      db().from('referral_commissions').select('commission_amount,order_amount,status').eq('source_id', row.id).eq('source_type', 'merchant_referral')
    ]);
    const commissions = unwrap(commissionResult, 'get merchant link commissions');
    const credited = commissions.filter((c) => c.status === 'credited');
    return {
      ...row,
      referred_count: referredResult.count || 0,
      orders_count: credited.length,
      total_sales: credited.reduce((sum, c) => sum + Number(c.order_amount || 0), 0).toFixed(8),
      total_commission: credited.reduce((sum, c) => sum + Number(c.commission_amount || 0), 0).toFixed(8)
    };
  }));
  return { items: withStats, count: result.count || 0 };
}

async function findUserForMerchantLink(identifier) {
  const safe = String(identifier || '').trim();
  if (!safe) return null;
  const query = /^\d+$/.test(safe)
    ? db().from('users').select('id,telegram_id,username').eq('telegram_id', safe).maybeSingle()
    : db().from('users').select('id,telegram_id,username').ilike('username', safe.replace(/^@/, '')).maybeSingle();
  return unwrap(await query, 'find user for merchant link');
}

async function createMerchantLink(values, actorTelegramId) {
  const crypto = require('node:crypto');
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = Array.from({ length: 8 }, () => charset[crypto.randomInt(charset.length)]).join('');
    try {
      const row = unwrap(await db().from('merchant_referral_links').insert({
        code, owner_user_id: values.ownerUserId, label: values.label || '',
        commission_percent: values.commissionPercent, active: values.active !== false,
        created_by: actorTelegramId, updated_by: actorTelegramId
      }).select().single(), 'create merchant link');
      liveEvents.publish(['settings', 'referrals'], { source: 'merchant_link_create' });
      return row;
    } catch (error) {
      if (!/duplicate key|unique/i.test(error.message || '')) throw error;
    }
  }
  throw Object.assign(new Error('Could not generate a unique merchant referral code.'), { code: 'MERCHANT_CODE_GENERATION_FAILED' });
}

async function updateMerchantLink(id, values, actorTelegramId) {
  const payload = { updated_by: actorTelegramId, updated_at: new Date().toISOString() };
  if ('label' in values) payload.label = values.label;
  if ('commissionPercent' in values) payload.commission_percent = values.commissionPercent;
  if ('active' in values) payload.active = values.active;
  const row = unwrap(await db().from('merchant_referral_links').update(payload).eq('id', id).select().maybeSingle(), 'update merchant link');
  liveEvents.publish(['settings', 'referrals'], { source: 'merchant_link_update' });
  return row;
}

async function deleteMerchantLink(id) {
  const row = unwrap(await db().from('merchant_referral_links').delete().eq('id', id).select('id,code,owner_user_id').maybeSingle(), 'delete merchant link');
  liveEvents.publish(['settings', 'referrals'], { source: 'merchant_link_delete', linkId: id });
  return row;
}

async function getRequiredChannels(activeOnly = false) {
  let query = db().from('required_channels').select('*').order('sort_order').order('id');
  if (activeOnly) query = query.eq('active', true);
  return unwrap(await query, 'list required channels');
}

async function isForceJoinEnabled() {
  const row = unwrap(await db().from('bot_settings').select('value').eq('key', 'force_join_enabled').maybeSingle(), 'get force join setting');
  return String(row?.value || 'false').toLowerCase() === 'true';
}

async function setForceJoinEnabled(enabled, actorTelegramId) {
  await saveBotSettings({ force_join_enabled: String(Boolean(enabled)) }, actorTelegramId);
  return isForceJoinEnabled();
}

async function createRequiredChannel(values, actorTelegramId) {
  const row = unwrap(await db().from('required_channels').insert({
    name: values.name, chat_ref: values.chatRef, join_url: values.joinUrl,
    active: values.active !== false, sort_order: values.sortOrder || 0, updated_by: actorTelegramId
  }).select().single(), 'create required channel');
  liveEvents.publish(['settings', 'channels'], { source: 'required_channel_create' });
  return row;
}

async function updateRequiredChannel(id, values, actorTelegramId) {
  const payload = { updated_by: actorTelegramId, updated_at: new Date().toISOString() };
  if ('name' in values) payload.name = values.name;
  if ('chatRef' in values) payload.chat_ref = values.chatRef;
  if ('joinUrl' in values) payload.join_url = values.joinUrl;
  if ('active' in values) payload.active = values.active;
  if ('sortOrder' in values) payload.sort_order = values.sortOrder;
  const row = unwrap(await db().from('required_channels').update(payload).eq('id', id).select().maybeSingle(), 'update required channel');
  liveEvents.publish(['settings', 'channels'], { source: 'required_channel_update' });
  return row;
}

async function deleteRequiredChannel(id) {
  const row = unwrap(await db().from('required_channels').delete().eq('id', id).select().maybeSingle(), 'delete required channel');
  liveEvents.publish(['settings', 'channels'], { source: 'required_channel_delete' });
  return row;
}

module.exports = {
  PAGE_SIZE,
  ensureUser,
  completeOnboarding,
  getReferralCode,
  getReferralSettings,
  saveReferralSettings,
  getUserReferralSummary,
  listReferralAdminStats,
  listReferralUsers,
  setUserReferralActive,
  deleteUserReferral,
  listMerchantLinks,
  findUserForMerchantLink,
  createMerchantLink,
  updateMerchantLink,
  deleteMerchantLink,
  getRequiredChannels,
  isForceJoinEnabled,
  setForceJoinEnabled,
  createRequiredChannel,
  updateRequiredChannel,
  deleteRequiredChannel,
  getUser,
  setLanguage,
  listCategories,
  getCategory,
  getCatalogSummary,
  listProducts,
  listUncategorizedProducts,
  getProduct,
  purchase,
  listOrders,
  listUserOrders,
  getOrderDetails,
  listPreorderProducts,
  listRefundEligibleOrders,
  createRefundRequest,
  createDeposit,
  getBinanceDeposit,
  approveBinanceHistoryPayment,
  markOrderPaymentMethod,
  cancelDeposit,
  submitUsdtTxId,
  approveDeposit,
  rejectDeposit,
  listDeposits,
  expireDeposits,
  setState,
  getState,
  clearState,
  listNotifications,
  createNotification,
  listUserTelegramIds,
  adminAddCategory,
  adminEditCategory,
  adminToggleCategory,
  adminAddProduct,
  adminCreateProduct,
  adminEditProduct,
  adminAdjustWallet,
  adminSetSuspended,
  getUserStats,
  getBotSettings,
  saveBotSettings,
  getUiState,
  saveUiState,
  clearLastMenuMessage,
  rotateLastUserMessage,
  rememberTransientBotMessage,
  clearTransientBotMessages,
  listBotLinks,
  saveBotLink,
  deleteBotLink,
  listFaqs,
  saveFaq,
  deleteFaq,
  addSupportMessage,
  listSupportConversations,
  getOrCreateSupportConversationByTelegramId,
  getSupportConversation,
  adminReplySupport,
  setSupportConversationStatus,
  markSupportRead,
  getPaymentSettings,
  savePaymentSetting,
  adminCreateCategory,
  adminUpdateCategory,
  adminDeleteCategory,
  adminArchiveProduct,
  importInventory,
  listInventoryItems,
  deleteInventoryItem,
  exportInventoryItems,
  inventoryStatusCounts,
  revealInventoryItem,
  setInventoryItemStatus,
  deliverManualOrder,
  reviewRefund,
  saveBulkTiers,
  auditAdmin,
  orderDateRange
};

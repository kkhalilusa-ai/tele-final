'use strict';

const TELEGRAM_TEXT_LIMIT = 4096;
const DEFAULT_MESSAGE_LIMIT = 3900;

function deliveryIntegrityError(orderId, expected, actual) {
  const error = new Error('Instant-delivery item count does not match the order quantity.');
  error.code = 'DELIVERY_COUNT_MISMATCH';
  error.safeDetails = { orderId: orderId ?? null, expected, actual };
  return error;
}

function assertDeliveryCount(order, deliveries = order?.deliveries) {
  if (order?.fulfillment_type !== 'instant' || order?.status !== 'delivered') return deliveries || [];
  const values = Array.isArray(deliveries) ? deliveries : [];
  const expected = Number(order.quantity);
  if (!Number.isSafeInteger(expected) || expected < 1 || values.length !== expected) {
    throw deliveryIntegrityError(order.order_id ?? order.id, expected, values.length);
  }
  return values;
}

function hydratePurchaseDeliveries(productId, row, decryptPayload) {
  const ciphertexts = Array.isArray(row?.payload_ciphertexts) ? row.payload_ciphertexts : [];
  const ivs = Array.isArray(row?.payload_ivs) ? row.payload_ivs : [];
  const tags = Array.isArray(row?.payload_auth_tags) ? row.payload_auth_tags : [];
  if (ciphertexts.length !== ivs.length || ciphertexts.length !== tags.length) {
    throw deliveryIntegrityError(row?.order_id, Number(row?.quantity), Math.min(ciphertexts.length, ivs.length, tags.length));
  }
  const deliveries = ciphertexts.map((ciphertext, index) => decryptPayload(productId, {
    payload_ciphertext: ciphertext,
    payload_iv: ivs[index],
    payload_auth_tag: tags[index]
  }));
  assertDeliveryCount(row, deliveries);
  return deliveries;
}

function localizedDeliveryLabels(language) {
  if (language === 'ar') return {
    title: 'طلبك جاهز', product: 'المنتج', subtitle: 'التفاصيل', duration: 'المدة', type: 'النوع',
    description: 'الوصف', instructions: 'طريقة الاستخدام', credentials: 'بيانات التسليم', deliveryDetails: 'تفاصيل التسليم',
    item: 'العنصر', of: 'من', warranty: 'الضمان', delivery: 'التسليم', notes: 'ملاحظات مهمة',
    copyHint: 'بيانات التسليم داخل مربعات مستقلة لسهولة النسخ.', order: 'الطلب', status: 'الحالة', delivered: 'تم التسليم'
  };
  if (language === 'hi') return {
    title: 'आपका ऑर्डर तैयार है', product: 'उत्पाद', subtitle: 'विवरण', duration: 'अवधि', type: 'प्रकार',
    description: 'विवरण', instructions: 'उपयोग करने का तरीका', credentials: 'डिलीवरी डेटा', deliveryDetails: 'डिलीवरी विवरण',
    item: 'आइटम', of: 'में से', warranty: 'वारंटी', delivery: 'डिलीवरी', notes: 'महत्वपूर्ण नोट्स',
    copyHint: 'डिलीवरी डेटा अलग ब्लॉक्स में है ताकि उसे आसानी से कॉपी किया जा सके।', order: 'ऑर्डर', status: 'स्थिति', delivered: 'डिलीवर किया गया'
  };
  return {
    title: 'Your Order Is Ready', product: 'Product', subtitle: 'Details', duration: 'Duration', type: 'Type',
    description: 'Description', instructions: 'How to use', credentials: 'Delivery Data', deliveryDetails: 'Delivery Details',
    item: 'Item', of: 'of', warranty: 'Warranty', delivery: 'Delivery', notes: 'Important Notes',
    copyHint: 'Delivery data is separated into dedicated copy-friendly blocks.', order: 'Order', status: 'Status', delivered: 'Delivered'
  };
}

function fallbackEscapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function snapshotFromOrder(order) {
  const snapshot = order?.delivery_snapshot && typeof order.delivery_snapshot === 'object' ? order.delivery_snapshot : {};
  const fallback = {
    product_name: order?.product_name || '',
    subtitle: order?.product_subtitle_snapshot || '',
    duration: order?.duration_snapshot || '',
    product_type: order?.product_type_snapshot || '',
    emoji: order?.emoji_snapshot || '',
    short_description: order?.short_description_snapshot || '',
    full_description: order?.full_description_snapshot || order?.description_snapshot || '',
    public_instructions: order?.public_instructions_snapshot || '',
    delivery_time: order?.delivery_time_snapshot || '',
    warranty_value: order?.warranty_value_snapshot ?? null,
    warranty_unit: order?.warranty_unit_snapshot || '',
    notification_mode: order?.notification_mode_snapshot || '',
    delivery_details: order?.delivery_details_snapshot || ''
  };
  return { ...fallback, ...snapshot, product_name: snapshot.product_name || fallback.product_name };
}

function warrantyLabel(snapshot, language) {
  if (snapshot.warranty_value == null || !snapshot.warranty_unit) {
    return language === 'ar' ? 'بدون ضمان' : language === 'hi' ? 'कोई वारंटी नहीं' : 'No warranty';
  }
  const unit = language === 'ar'
    ? ({ hours: 'ساعة', days: 'يوم', months: 'شهر' }[snapshot.warranty_unit] || snapshot.warranty_unit)
    : language === 'hi'
      ? ({ hours: 'घंटे', days: 'दिन', months: 'महीने' }[snapshot.warranty_unit] || snapshot.warranty_unit)
      : ({ hours: 'hour', days: 'day', months: 'month' }[snapshot.warranty_unit] || snapshot.warranty_unit);
  return `${snapshot.warranty_value} ${unit}`;
}

function buildDeliveryView(order, deliveries = order?.deliveries, language = 'en', options = {}) {
  const values = Array.isArray(deliveries) ? deliveries : [];
  assertDeliveryCount(order, values);
  const labels = { ...localizedDeliveryLabels(language), ...(options.labels || {}) };
  const escape = options.escape || fallbackEscapeHtml;
  const gift = options.giftEmoji || '🎁';
  const snapshot = snapshotFromOrder(order);
  const orderId = order?.order_id ?? order?.id ?? '—';
  const type = snapshot.product_type || (
    order?.fulfillment_type === 'instant'
      ? (language === 'ar' ? 'فوري' : language === 'hi' ? 'तुरंत' : 'Instant')
      : (language === 'ar' ? 'يدوي' : language === 'hi' ? 'मैनुअल' : 'Manual')
  );
  const icon = snapshot.emoji || gift;
  const warranty = warrantyLabel(snapshot, language);

  const headerLines = [
    '━━━━━━━━━━━━━━━━━━━━',
    `${gift} <b>${escape(labels.title)}</b>`,
    '━━━━━━━━━━━━━━━━━━━━',
    '',
    `🛍️ <b>${escape(snapshot.product_name || 'Product')}</b>`,
    `🔗 <b>${escape(labels.type)}:</b> ${escape(type)}`,
    `🛡️ <b>${escape(labels.warranty)}:</b> ${escape(warranty)}`,
    `🆔 <b>${escape(labels.order)}:</b> #${escape(orderId)}`,
    ''
  ];

  if (snapshot.delivery_details) {
    headerLines.push(`ℹ️ <b>${escape(labels.deliveryDetails)}</b>`);
    headerLines.push(escape(snapshot.delivery_details));
    headerLines.push('');
  }

  headerLines.push(`🎁 <b>${escape(labels.credentials)}</b>`);
  headerLines.push(`<i>${escape(labels.copyHint)}</i>`);

  const header = headerLines.join('\n');
  const itemBlocks = values.map((value, index) => {
    const itemHeader = `${gift} <b>${escape(labels.item)} ${index + 1} ${escape(labels.of)} ${values.length}</b>`;
    const block = `${itemHeader}\n<pre>${escape(value)}</pre>`;
    return { index: index + 1, total: values.length, value: String(value), itemHeader, block };
  });

  const footer = [
    '━━━━━━━━━━━━━━━━━━━━',
    `🛡️ <b>${escape(labels.warranty)}:</b> ${escape(warranty)}`,
    '━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');

  const limit = Math.min(TELEGRAM_TEXT_LIMIT, Math.max(512, Number(options.limit) || DEFAULT_MESSAGE_LIMIT));
  const parts = [];
  const chunks = [];
  const oversized = [];
  let current = `${header}\n\n`;
  let currentHasItem = false;

  const flush = () => {
    if (!currentHasItem) return;
    const text = `${current}\n\n${footer}`;
    chunks.push(text);
    parts.push({ type: 'message', text });
    current = `${header}\n\n`;
    currentHasItem = false;
  };

  for (const item of itemBlocks) {
    const standalone = `${header}\n\n${item.block}\n\n${footer}`;
    if (standalone.length > limit) {
      flush();
      oversized.push(item);
      parts.push({ type: 'document', ...item });
      continue;
    }
    const candidate = `${current}${currentHasItem ? '\n\n' : ''}${item.block}`;
    if (`${candidate}\n\n${footer}`.length > limit) flush();
    current += `${currentHasItem ? '\n\n' : ''}${item.block}`;
    currentHasItem = true;
  }
  flush();

  return {
    parts,
    chunks,
    oversized,
    summary: {
      orderId,
      productName: snapshot.product_name || '',
      quantity: values.length,
      warranty,
      deliveryDetails: snapshot.delivery_details || '',
      snapshot
    }
  };
}

// Backward-compatible helper retained for callers/tests that only need item chunks.
function buildDeliveryChunks(deliveries, options = {}) {
  const values = Array.isArray(deliveries) ? deliveries : [];
  const labels = options.labels || localizedDeliveryLabels(options.language || 'en');
  const escape = options.escape || fallbackEscapeHtml;
  const gift = options.giftEmoji || '🎁';
  const limit = Math.min(TELEGRAM_TEXT_LIMIT, Math.max(512, Number(options.limit) || DEFAULT_MESSAGE_LIMIT));
  const header = `━━━━━━━━━━━━━━━━━━━━\n${gift} ${escape(labels.title || '')}\n━━━━━━━━━━━━━━━━━━━━`;
  const chunks = [];
  const oversized = [];
  const parts = [];
  let current = header;
  const flush = () => { if (current === header) return; chunks.push(current); parts.push({ type: 'message', text: current }); current = header; };
  values.forEach((value, index) => {
    const itemHeader = `${gift} ${escape(labels.item)} ${index + 1} ${escape(labels.of)} ${values.length}`;
    const block = `${itemHeader}\n<pre>${escape(value)}</pre>`;
    if (header.length + block.length + 2 > limit) {
      flush();
      const item = { index: index + 1, total: values.length, value: String(value), itemHeader };
      oversized.push(item); parts.push({ type: 'document', ...item }); return;
    }
    const candidate = `${current}\n\n${block}`;
    if (candidate.length > limit) flush();
    current = `${current}\n\n${block}`;
  });
  flush();
  return { chunks, oversized, parts };
}

module.exports = {
  TELEGRAM_TEXT_LIMIT,
  DEFAULT_MESSAGE_LIMIT,
  assertDeliveryCount,
  hydratePurchaseDeliveries,
  localizedDeliveryLabels,
  snapshotFromOrder,
  buildDeliveryView,
  buildDeliveryChunks
};

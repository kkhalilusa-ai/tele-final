'use strict';

const { escapeHtml, formatAmount } = require('../utils');

const SUCCESSFUL_ORDER_STATUSES = new Set(['processing', 'delivered']);

function uniqueAdminIds(adminIds = []) {
  return [...new Set(adminIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

function isIdempotentReplay(order) {
  return order?.already_processed === true || String(order?.already_processed || '').toLowerCase() === 'true';
}

function shouldNotifyAdmins(order) {
  return Boolean(
    order?.order_id &&
    SUCCESSFUL_ORDER_STATUSES.has(String(order.status || '').toLowerCase()) &&
    !isIdempotentReplay(order)
  );
}

function customerLabel(customer = {}) {
  if (customer.username) return `@${escapeHtml(String(customer.username).replace(/^@/, ''))}`;
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
  return name ? escapeHtml(name) : '—';
}

function buildSuccessfulOrderAdminMessage(order, customer = {}, paymentLabel = 'Wallet') {
  return [
    '🛒 <b>New Successful Order</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `🆔 <b>Order:</b> <code>#${escapeHtml(order.order_id)}</code>`,
    `👤 <b>Customer:</b> ${customerLabel(customer)}`,
    `🔢 <b>Telegram ID:</b> <code>${escapeHtml(customer.id || '—')}</code>`,
    `📦 <b>Product:</b> ${escapeHtml(order.product_name || '—')}`,
    `🔢 <b>Quantity:</b> ${escapeHtml(order.quantity || 1)}`,
    `💵 <b>Total:</b> $${formatAmount(order.total_amount || 0)}`,
    `💳 <b>Payment:</b> ${escapeHtml(paymentLabel)}`,
    `✅ <b>Status:</b> ${escapeHtml(String(order.status || '').toUpperCase())}`
  ].join('\n');
}

async function notifySuccessfulOrderAdmins({ telegram, adminIds, order, customer, paymentLabel }) {
  const recipients = uniqueAdminIds(adminIds);
  if (!shouldNotifyAdmins(order) || !recipients.length) {
    return { attempted: 0, sent: 0, failed: 0, skipped: true };
  }

  const message = buildSuccessfulOrderAdminMessage(order, customer, paymentLabel);
  const results = await Promise.allSettled(recipients.map((adminId) => telegram.sendMessage(adminId, message, {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  })));

  let sent = 0;
  let failed = 0;
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      sent += 1;
      return;
    }
    failed += 1;
    console.error('admin_order_notification_failed', {
      adminId: recipients[index],
      orderId: order.order_id,
      code: String(result.reason?.code || 'TELEGRAM_ERROR').slice(0, 64)
    });
  });

  return { attempted: recipients.length, sent, failed, skipped: false };
}

module.exports = {
  buildSuccessfulOrderAdminMessage,
  notifySuccessfulOrderAdmins,
  shouldNotifyAdmins
};

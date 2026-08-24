'use strict';

const crypto = require('node:crypto');
const { db } = require('../database');

const clients = new Set();
let channel = null;
let realtimeState = 'idle';

const tableResources = {
  users: ['dashboard', 'users', 'broadcast'],
  products: ['dashboard', 'products', 'inventory'],
  categories: ['products', 'categories'],
  product_inventory_items: ['dashboard', 'products', 'inventory', 'orders'],
  bulk_pricing_tiers: ['products'],
  orders: ['dashboard', 'orders', 'preorders', 'users', 'wallet'],
  deposits: ['dashboard', 'deposits', 'users', 'wallet'],
  wallet_transactions: ['dashboard', 'wallet', 'users'],
  notifications: ['notifications'],
  notification_rules: ['automation'],
  notification_destinations: ['automation'],
  notification_jobs: ['automation', 'dashboard'],
  notification_job_deliveries: ['automation'],
  product_notification_state: ['automation', 'products'],
  scheduled_sales: ['automation', 'products', 'dashboard'],
  user_ui_state: [],
  refund_requests: ['dashboard', 'refunds', 'orders'],
  admin_audit_log: ['dashboard']
};

function write(res, event, payload) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch (_) {
    return false;
  }
}

function publish(resources, detail = {}) {
  const normalized = [...new Set((Array.isArray(resources) ? resources : [resources]).filter(Boolean))];
  if (!normalized.length) return;
  const payload = {
    id: crypto.randomUUID(),
    resources: normalized,
    at: new Date().toISOString(),
    ...detail
  };
  for (const res of clients) if (!write(res, 'change', payload)) clients.delete(res);
}

function startRealtime() {
  if (channel || realtimeState === 'starting') return;
  realtimeState = 'starting';
  try {
    channel = db().channel('admin-live-v2')
      .on('postgres_changes', { event: '*', schema: 'public' }, (change) => {
        publish(tableResources[change.table] || ['dashboard'], {
          table: change.table,
          operation: change.eventType
        });
      })
      .subscribe((status) => {
        realtimeState = status === 'SUBSCRIBED' ? 'connected' : String(status || 'reconnecting').toLowerCase();
      });
  } catch (error) {
    realtimeState = 'unavailable';
    channel = null;
    console.warn('admin_realtime_unavailable', { code: error.code, message: String(error.message || '').slice(0, 160) });
  }
}

function addClient(req, res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  clients.add(res);
  write(res, 'ready', { at: new Date().toISOString(), realtime: realtimeState });
  startRealtime();
  const cleanup = () => clients.delete(res);
  req.once('close', cleanup);
  req.once('aborted', cleanup);
}

const heartbeat = setInterval(() => {
  for (const res of clients) if (!write(res, 'heartbeat', { at: new Date().toISOString() })) clients.delete(res);
}, 20_000);
heartbeat.unref();

module.exports = { addClient, publish, startRealtime };

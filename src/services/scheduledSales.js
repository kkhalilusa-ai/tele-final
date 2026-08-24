const { db, unwrap } = require('../database');
const store = require('./store');
const notifications = require('./notifications');
const liveEvents = require('./liveEvents');

let timer = null;
let busy = false;

async function activate(row) {
  const claimed = unwrap(await db().from('scheduled_sales').update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('status', 'scheduled').select('id').maybeSingle(), 'claim scheduled sale');
  if (!claimed) return;
  const before = await store.getProduct(row.product_id);
  await db().from('products').update({ price: row.sale_price, updated_at: new Date().toISOString() }).eq('id', row.product_id);
  const after = await store.getProduct(row.product_id);
  await notifications.captureProductChange(before, after);
  liveEvents.publish(['products', 'dashboard', 'automation'], { source: 'scheduled_sale_started', saleId: row.id });
}

async function complete(row) {
  const claimed = unwrap(await db().from('scheduled_sales').update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('status', 'active').select('id').maybeSingle(), 'complete scheduled sale');
  if (!claimed) return;
  const product = await store.getProduct(row.product_id);
  // A manual price edit during a sale wins; only restore when the sale price is still active.
  if (String(product.price) === String(row.sale_price)) {
    await db().from('products').update({ price: row.normal_price, updated_at: new Date().toISOString() }).eq('id', row.product_id);
  }
  liveEvents.publish(['products', 'dashboard', 'automation'], { source: 'scheduled_sale_ended', saleId: row.id });
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = new Date().toISOString();
    const [starts, ends] = await Promise.all([
      db().from('scheduled_sales').select('*').eq('status', 'scheduled').lte('starts_at', now).order('starts_at').limit(20),
      db().from('scheduled_sales').select('*').eq('status', 'active').lte('ends_at', now).order('ends_at').limit(20)
    ]);
    for (const row of unwrap(starts, 'list scheduled sale starts')) await activate(row);
    for (const row of unwrap(ends, 'list scheduled sale ends')) await complete(row);
  } catch (error) {
    // A fresh deployment can start before the v6 migration is applied.
    if (!String(error.message || '').includes('scheduled_sales')) console.error('scheduled_sales_tick_failed', { message: error.message });
  } finally { busy = false; }
}

function startWorker() {
  if (timer) return;
  timer = setInterval(tick, 30_000);
  timer.unref();
  setTimeout(tick, 2_000).unref?.();
}

function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { tick, startWorker, stopWorker };

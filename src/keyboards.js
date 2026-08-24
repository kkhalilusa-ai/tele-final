const { t } = require('./i18n');
const { stripLeadingEmoji } = require('./services/customEmojis');

function iconId(ui, key) {
  return ui?.customEmojis?.enabled ? ui.customEmojis.icons?.[key] || null : null;
}

function button(text, callbackData, style, customEmojiId = null) {
  const value = { text: customEmojiId ? stripLeadingEmoji(text) : text, callback_data: callbackData };
  if (customEmojiId) value.icon_custom_emoji_id = customEmojiId;
  if (style) value.style = style;
  return value;
}

function urlButton(text, url, style, customEmojiId = null) {
  const value = { text: customEmojiId ? stripLeadingEmoji(text) : text, url };
  if (customEmojiId) value.icon_custom_emoji_id = customEmojiId;
  if (style) value.style = style;
  return value;
}

function markup(rows) {
  return { reply_markup: { inline_keyboard: rows.filter((row) => row.length) } };
}

function localizedSetting(value, defaultEnglish, fallback) {
  const clean = String(value || '').trim();
  return clean && clean !== defaultEnglish ? clean : fallback;
}

function enabledSetting(value, fallback = true) {
  if (value == null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function menuLabel(settings, key, language, fallback) {
  return String(settings?.[`${key}_label_${language}`] || settings?.[`${key}_label_en`] || fallback).trim().slice(0, 64);
}

function purchasable(item) {
  return Boolean(
    item?.active &&
    (!item.product_status || item.product_status === 'active') &&
    (item.unlimited_stock || Number(item.stock) > 0)
  );
}

function mainMenu(language, ui = {}) {
  const channel = ui.channelUrl || ui.links?.channel?.url || '';
  const settings = ui.settings || {};
  const channelText = localizedSetting(ui.links?.channel?.button_text, '📢 Join Our Channel ↗', menuLabel(settings, 'channel', language, t(language, 'joinChannel')));
  const items = [];
  if (enabledSetting(settings.menu_products_enabled, true)) items.push(button(menuLabel(settings, 'products', language, t(language, 'products')), 'menu:products', 'success', iconId(ui, 'product_custom_emoji_id')));
  if (enabledSetting(settings.menu_wallet_enabled, true)) items.push(button(menuLabel(settings, 'wallet', language, t(language, 'wallet')), 'menu:wallet', 'primary', iconId(ui, 'price_custom_emoji_id')));
  if (enabledSetting(settings.menu_deposit_enabled, true)) items.push(button(menuLabel(settings, 'deposit', language, t(language, 'depositButton')), 'wallet:topup', 'primary', iconId(ui, 'binance_custom_emoji_id')));
  if (enabledSetting(settings.menu_orders_enabled, true)) items.push(button(menuLabel(settings, 'orders', language, t(language, 'myOrders')), 'orders:all:0', 'primary', iconId(ui, 'product_custom_emoji_id')));
  if (enabledSetting(settings.menu_support_enabled, true)) items.push(button(menuLabel(settings, 'support', language, t(language, 'support')), 'menu:support', 'primary'));
  if (enabledSetting(settings.menu_about_enabled, true)) items.push(button(menuLabel(settings, 'about', language, t(language, 'about')), 'menu:about', 'primary'));
  if (enabledSetting(settings.menu_channel_enabled, true)) items.push(channel ? urlButton(channelText, channel, 'success') : button(menuLabel(settings, 'channel', language, t(language, 'channel')), 'menu:channel', 'success'));
  if (enabledSetting(settings.menu_referrals_enabled, false)) items.push(button(menuLabel(settings, 'referrals', language, t(language, 'referralsButton')), 'menu:referrals', 'primary'));
  const columns = settings.menu_layout === 'one' ? 1 : 2;
  const rows = [];
  for (let index = 0; index < items.length; index += columns) rows.push(items.slice(index, index + columns));
  if (enabledSetting(settings.menu_more_enabled, true)) rows.push([button(t(language, 'more'), 'menu:more')]);
  return markup(rows);
}

function moreMenu(language) {
  return markup([
    [button(t(language, 'preOrders'), 'menu:preorders'), button(t(language, 'refundRequest'), 'menu:refunds')],
    [button(t(language, 'language'), 'menu:language'), button(t(language, 'records'), 'menu:records')],
    [button(t(language, 'back'), 'menu:main', 'danger')]
  ]);
}

function support(language, ui = {}) {
  const contact = ui.links?.support || ui.links?.contact;
  const rows = [[button(t(language, 'chatInBot'), 'support:chat', 'primary')]];
  if (contact?.url) {
    const contactText = localizedSetting(contact.button_text, '✉️ Contact Admin', t(language, 'contactAdmin'));
    rows.push([urlButton(contactText, contact.url, 'primary')]);
  }
  const reserved = new Set(['support','contact','channel']);
  const extras = Object.values(ui.links || {}).filter((item) => item && item.url && !reserved.has(item.link_key));
  for (const item of extras.slice(0, 6)) rows.push([urlButton(item.button_text || item.link_key, item.url, 'primary')]);
  rows.push([button(t(language, 'faq'), 'support:faq', 'primary')]);
  rows.push([button(t(language, 'back'), 'menu:main', 'danger')]);
  return markup(rows);
}

function faq(language, items) {
  const rows = items.map((item) => [button(`❓ ${item.question}`.slice(0, 60), `faq:${item.id}`)]);
  rows.push([button(t(language, 'back'), 'menu:support', 'danger')]);
  return markup(rows);
}

function languages(language) {
  return markup([
    [button('🇬🇧 English', 'lang:en', 'primary')],
    [button('🇵🇸 العربية', 'lang:ar', 'primary')],
    [button('🇮🇳 हिन्दी', 'lang:hi', 'primary')],
    [button(t(language, 'back'), 'menu:more')]
  ]);
}

function languagesOnboarding() {
  return markup([
    [button('🇬🇧 English', 'lang:en', 'primary')],
    [button('🇵🇸 العربية', 'lang:ar', 'primary')],
    [button('🇮🇳 हिन्दी', 'lang:hi', 'primary')]
  ]);
}

function accessRequired(language, channels) {
  const rows = channels.map((channel) => [urlButton(t(language, 'joinChannelButton', { name: channel.name }), channel.join_url, 'success')]);
  rows.push([button(t(language, 'verifyButton'), 'forcejoin:verify', 'primary')]);
  return markup(rows);
}

function categories(language, items, page, hasNext, options = {}) {
  const rows = [];
  const globalLayout = ['full', 'two', 'auto'].includes(options.layout) ? options.layout : 'full';
  let pending = [];
  const flush = () => { if (pending.length) { rows.push(pending); pending = []; } };
  for (const item of items) {
    const label = `${item.emoji || '📦'} ${item.name} (${item.active_product_count ?? item.available_product_count ?? 0})`;
    const override = item.layout_override && item.layout_override !== 'inherit' ? item.layout_override : globalLayout;
    const resolved = override === 'auto' ? (label.length > 28 ? 'full' : 'two') : override;
    const value = button(label.slice(0, 64), `cat:${item.id}`, 'success', iconId({ customEmojis: options.customEmojis }, 'product_custom_emoji_id'));
    if (resolved === 'full') { flush(); rows.push([value]); }
    else { pending.push(value); if (pending.length === 2) flush(); }
  }
  flush();
  if (page === 0 && Array.isArray(options.uncategorized) && options.uncategorized.length) {
    rows.push([button(String(options.uncategorizedTitle || '📦 Other Products').slice(0, 64), 'catalog:other', undefined, iconId({ customEmojis: options.customEmojis }, 'product_custom_emoji_id'))]);
    for (const item of options.uncategorized) rows.push(productButtonRow(item, true, language, { customEmojis: options.customEmojis }));
  }
  const nav = [];
  if (page > 0) nav.push(button(t(language, 'previous'), `cats:${page - 1}`));
  if (hasNext) nav.push(button(t(language, 'next'), `cats:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button(t(language, 'back'), 'menu:main', 'danger')]);
  return markup(rows);
}

function productButtonRow(item, showStock = false, language = 'en', ui = {}) {
  const available = purchasable(item);
  const prefix = item.emoji || '📦';
  const duration = item.duration ? ` — ${item.duration}` : '';
  const stockSuffix = showStock ? ` [${item.unlimited_stock ? '✅ ∞' : `✅ ${Number(item.stock) || 0}`}]` : '';
  const label = available
    ? `${prefix} ${item.name}${duration} — $${item.price}${stockSuffix}`
    : `❌ ${item.name}${duration} — $${item.price} — ${t(language, 'outOfStock')}`;
  return [button(label.slice(0, 64), `prd:${item.id}`, available ? 'success' : 'danger', iconId(ui, 'product_custom_emoji_id'))];
}

function products(language, items, categoryId, page, hasNext, ui = {}) {
  const rows = items.map((item) => productButtonRow(item, false, language, ui));
  const nav = [];
  if (page > 0) nav.push(button(t(language, 'previous'), `prods:${categoryId}:${page - 1}`));
  if (hasNext) nav.push(button(t(language, 'next'), `prods:${categoryId}:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button(t(language, 'back'), 'menu:products', 'danger')]);
  return markup(rows);
}

function product(language, item, ui = {}) {
  const available = purchasable(item);
  const rows = [];
  if (available) {
    const buyText = localizedSetting(ui.settings?.buy_button_text, '🛒 Buy Now', t(language, 'buyNow'));
    rows.push([button(buyText, `qty:${item.id}`, 'success', iconId(ui, 'product_custom_emoji_id'))]);
  } else {
    const outText = localizedSetting(ui.settings?.out_of_stock_message, 'OUT OF STOCK', t(language, 'outOfStock'));
    rows.push([button(`🔴 ${outText}`, `prd:${item.id}`, 'danger')]);
  }
  rows.push([button(t(language, 'backToProducts'), item.category_id ? `cat:${item.category_id}` : 'menu:products', 'danger')]);
  return markup(rows);
}

function purchaseConfirmation(language, token, options = {}) {
  const ui = { customEmojis: options.customEmojis };
  const rows = [[button(t(language, 'payFromWallet'), `confirm:${token}`, 'success', iconId(ui, 'success_custom_emoji_id'))]];
  if (options.binanceEnabled) rows.push([button(t(language, 'payBinanceDirect'), `confirmbinance:${token}`, 'primary', iconId(ui, 'binance_custom_emoji_id'))]);
  rows.push([button(t(language, 'topUp'), 'menu:wallet', 'success')]);
  rows.push([button(t(language, 'cancel'), 'menu:products', 'danger')]);
  return markup(rows);
}

function preorderProducts(language, items, page, hasNext) {
  const rows = items.map((item) => [button(`${item.emoji || '🔜'} ${item.name} — $${item.price}`, `prd:${item.id}`, 'primary')]);
  const nav = [];
  if (page > 0) nav.push(button(t(language, 'previous'), `preorders:${page - 1}`));
  if (hasNext) nav.push(button(t(language, 'next'), `preorders:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button(t(language, 'back'), 'menu:more')]);
  return markup(rows);
}

function orders(language, items, filter, page, hasNext, ui = {}) {
  const icon = { delivered: '✅', processing: '⏳', pending: '⏳', refunded: '↩️', cancelled: '❌' };
  const rows = [
    [button(`${filter === 'all' ? '✓ ' : ''}${t(language, 'filterAll')}`, 'orders:all:0'), button(`${filter === '7d' ? '✓ ' : ''}${t(language, 'filter7d')}`, 'orders:7d:0')],
    [button(`${filter === '30d' ? '✓ ' : ''}${t(language, 'filter30d')}`, 'orders:30d:0'), button(`${filter === 'month' ? '✓ ' : ''}${t(language, 'filterMonth')}`, 'orders:month:0')],
    [button(`${filter === 'lastmonth' ? '✓ ' : ''}${t(language, 'filterLastMonth')}`, 'orders:lastmonth:0')]
  ];
  for (const item of items) rows.push([button(
    `${icon[item.status] || '•'} #${item.id} · ${item.product_name} · $${item.total_amount || item.amount}`.slice(0, 64),
    `order:${item.id}:${filter}:${page}`, undefined, iconId(ui, 'product_custom_emoji_id')
  )]);
  const nav = [];
  if (page > 0) nav.push(button(t(language, 'previous'), `orders:${filter}:${page - 1}`));
  if (hasNext) nav.push(button(t(language, 'next'), `orders:${filter}:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button(t(language, 'back'), 'menu:main')]);
  return markup(rows);
}

function orderDetails(language, filter = 'all', page = 0, ui = {}) {
  return markup([[button(t(language, 'backToOrders'), `ordersnew:${filter}:${page}`, undefined, iconId(ui, 'product_custom_emoji_id'))]]);
}

function refundOrders(language, items) {
  const rows = items.map((item) => [button(`#${item.id} · ${item.product_name} · $${item.total_amount || item.amount}`, `refund:${item.id}`)]);
  rows.push([button(t(language, 'back'), 'menu:more')]);
  return markup(rows);
}

function wallet(language, ui = {}) {
  return markup([
    [button(t(language, 'topUp'), 'wallet:topup', 'success', iconId(ui, 'price_custom_emoji_id'))],
    [button(t(language, 'depositHistory'), 'deps:0')],
    [button(t(language, 'back'), 'menu:main', 'danger')]
  ]);
}

function paymentMethods(language, methods = {}, ui = {}) {
  const rows = [];
  const binance = methods.binance || {};
  const usdt = methods.usdt_bep20 || {};
  const solana = methods.solana || {};
  if (binance.enabled !== false) rows.push([button(`◈ ${binance.display_name || 'Binance UID'} ⚡ Auto-detect`, 'pay:binance', 'primary', iconId(ui, 'binance_custom_emoji_id'))]);
  if (usdt.enabled !== false) rows.push([button(usdt.display_name || t(language, 'payUsdt'), 'pay:bep20', 'success')]);
  if (solana.enabled !== false) rows.push([button(solana.display_name || t(language, 'payLabelSolana'), 'pay:solana', 'success')]);
  rows.push([button(t(language, 'backToWallet'), 'menu:wallet', 'danger')]);
  return markup(rows);
}

function amounts(language, method, presets) {
  // Solana checkout input is denominated in USDT; SOL is calculated later from the live quote.
  const unit = 'USDT';
  const rows = [];
  for (let index = 0; index < presets.length; index += 2) {
    rows.push(presets.slice(index, index + 2).map((amount) => button(`${amount} ${unit}`, `amt:${method}:${amount}`, 'success')));
  }
  rows.push([button(t(language, 'customAmount'), `amt:${method}:custom`)]);
  rows.push([button(t(language, 'back'), 'wallet:topup')]);
  return markup(rows);
}

function solanaReservation(language, depositId) {
  return markup([
    [button(t(language, 'cancelReservation'), `dep:cancel:${depositId}`, 'danger')],
    [button(t(language, 'wallet'), 'menu:wallet')]
  ]);
}

function referralsScreen(language, link) {
  return markup([
    [urlButton(t(language, 'copyLink'), link, 'primary')],
    [button(t(language, 'back'), 'menu:main', 'danger')]
  ]);
}

function quantityReply(language, item, settings = {}) {
  const stock = item.unlimited_stock ? Number.MAX_SAFE_INTEGER : Math.max(0, Number(item.stock) || 0);
  const threshold = Math.max(1, Math.min(100, Number(settings.quantity_sequential_threshold) || 20));
  const perRow = Math.max(1, Math.min(5, Number(settings.quantity_buttons_per_row) || 3));
  const customEnabled = enabledSetting(settings.quantity_custom_enabled, true);
  let values;
  const mode = ['auto', 'sequential', 'presets'].includes(settings.quantity_mode) ? settings.quantity_mode : 'auto';
  const sequential = mode !== 'presets' && !item.unlimited_stock && stock <= threshold;
  if (sequential) {
    values = Array.from({ length: stock }, (_unused, index) => index + 1);
  } else {
    const configured = String(settings.quantity_presets || '1,2,3,5,10,20').split(',')
      .map((value) => Number(value.trim())).filter((value) => Number.isSafeInteger(value) && value > 0);
    values = [...new Set(configured)].filter((value) => item.unlimited_stock || value <= stock);
  }
  const rows = [];
  for (let index = 0; index < values.length; index += perRow) {
    rows.push(values.slice(index, index + perRow).map((value) => ({ text: String(value) })));
  }
  if (customEnabled && (item.unlimited_stock || stock > threshold)) rows.push([{ text: t(language, 'customQuantity') }]);
  rows.push([{ text: t(language, 'cancel') }]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true, one_time_keyboard: true, input_field_placeholder: t(language, 'chooseQuantity') } };
}

function removeReplyKeyboard() {
  return { reply_markup: { remove_keyboard: true } };
}

function usdtReservation(language, depositId) {
  return markup([
    [button(t(language, 'cancelReservation'), `dep:cancel:${depositId}`, 'danger')],
    [button(t(language, 'wallet'), 'menu:wallet')]
  ]);
}

function binanceCheckout(language, depositId, ui = {}) {
  return markup([
    [button(t(language, 'cancelReservation'), `dep:cancel:${depositId}`, 'danger', iconId(ui, 'binance_custom_emoji_id'))]
  ]);
}

function records(language) {
  return markup([
    [button(t(language, 'allOrders'), 'orders:all:0')],
    [button(t(language, 'notifications'), 'notes:0')],
    [button(t(language, 'depositHistory'), 'deps:0')],
    [button(t(language, 'profile'), 'menu:profile')],
    [button(t(language, 'back'), 'menu:more')]
  ]);
}

function pagination(language, prefix, page, hasNext, backCallback) {
  const rows = [];
  const nav = [];
  if (page > 0) nav.push(button(t(language, 'previous'), `${prefix}:${page - 1}`));
  if (hasNext) nav.push(button(t(language, 'next'), `${prefix}:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button(t(language, 'back'), backCallback)]);
  return markup(rows);
}

function persistentActions(language, ui = {}) {
  const shop = localizedSetting(ui.settings?.shop_button_text, '🛍️ Shop', t(language, 'shopButton'));
  const deposit = localizedSetting(ui.settings?.deposit_button_text, '➕ Deposit', t(language, 'depositButton'));
  const orders = t(language, 'myOrders');
  return {
    reply_markup: {
      keyboard: [[
        { text: iconId(ui, 'binance_custom_emoji_id') ? stripLeadingEmoji(deposit) : deposit, ...(iconId(ui, 'binance_custom_emoji_id') ? { icon_custom_emoji_id: iconId(ui, 'binance_custom_emoji_id') } : {}) },
        { text: iconId(ui, 'product_custom_emoji_id') ? stripLeadingEmoji(shop) : shop, ...(iconId(ui, 'product_custom_emoji_id') ? { icon_custom_emoji_id: iconId(ui, 'product_custom_emoji_id') } : {}) }
      ], [
        { text: iconId(ui, 'product_custom_emoji_id') ? stripLeadingEmoji(orders) : orders, ...(iconId(ui, 'product_custom_emoji_id') ? { icon_custom_emoji_id: iconId(ui, 'product_custom_emoji_id') } : {}) }
      ]],
      resize_keyboard: true,
      is_persistent: true
    }
  };
}

function admin(language) {
  return markup([
    [button(t(language, 'pendingDeposits'), 'admin:deposits')],
    [button(t(language, 'recentOrders'), 'admin:orders')]
  ]);
}

function adminDeposit(language, depositId) {
  return markup([[
    button(t(language, 'approve'), `ad:a:${depositId}`, 'success'),
    button(t(language, 'reject'), `ad:r:${depositId}`, 'danger')
  ]]);
}

module.exports = {
  button, urlButton, markup, mainMenu, moreMenu, support, faq, languages, languagesOnboarding, accessRequired,
  categories, products, product, persistentActions,
  purchaseConfirmation, preorderProducts, orders, orderDetails, refundOrders, wallet, paymentMethods,
  amounts, usdtReservation, solanaReservation, binanceCheckout, records, pagination, admin, adminDeposit,
  referralsScreen
  , quantityReply, removeReplyKeyboard
};

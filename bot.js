const crypto = require('node:crypto');
const { Telegraf } = require('telegraf');
const { config } = require('./src/config');
const { t, normalizeLanguage } = require('./src/i18n');
const keyboards = require('./src/keyboards');
const store = require('./src/services/store');
const { calculateSolAmount, getSolanaUsdtQuote } = require('./src/services/solanaPrice');

function formatSolAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : '0.000';
}

function solanaInstructions(language, configured) {
  const raw = String(configured || '').trim();
  const legacy = new Set([
    'Send exactly the requested SOL amount, then submit the transaction signature.',
    'Send exactly the required SOL amount, then submit the transaction signature.'
  ]);
  if (!raw || legacy.has(raw)) return '';
  return raw;
}
const { binancePay, orderIdValue } = require('./src/services/binancePay');
const { assertDeliveryCount, buildDeliveryView } = require('./src/services/delivery');
const { CustomEmojiService, stripLeadingEmoji } = require('./src/services/customEmojis');
const { deleteMessagesBestEffort } = require('./src/services/chatCleanup');
const { notifySuccessfulOrderAdmins } = require('./src/services/orderAdminNotifications');
const {
  parseDecimalString,
  decimalToUnits,
  unitsToDecimal,
  isAmountInRange,
  formatAmount,
  multiplyDecimal,
  isValidBep20TxId,
  isValidSolanaSignature,
  escapeHtml,
  pageNumber,
  extractStartPayload
} = require('./src/utils');

const bot = new Telegraf(config.botToken);
const customEmojiService = new CustomEmojiService();
const purchaseLocks = new Set();
const binanceVerificationLocks = new Set();
const rateLimits = new Map();
let runtimeUiCache = null;
let runtimeUiCacheAt = 0;

function isAdmin(userId) {
  return config.adminIds.includes(Number(userId));
}

function languageOf(ctx) {
  return normalizeLanguage(ctx.state.user?.language || config.defaultLanguage);
}

async function runtimeUi() {
  if (runtimeUiCache && Date.now() - runtimeUiCacheAt < 3000) return runtimeUiCache;
  try {
    const [settings, linkRows, paymentRows] = await Promise.all([
      store.getBotSettings(), store.listBotLinks(true), store.getPaymentSettings()
    ]);
    const links = {};
    for (const row of linkRows) links[row.link_key] = row;
    if (!links.channel && config.channelUrl) links.channel = { link_key: 'channel', button_text: '📢 Join Our Channel ↗', url: config.channelUrl, active: true };
    if (!links.support && (config.supportUrl || config.supportUsername)) {
      links.support = { link_key: 'support', button_text: '✉️ Contact Admin', url: config.supportUrl || `https://t.me/${String(config.supportUsername).replace(/^@/, '')}`, active: true };
    }
    const payments = Object.fromEntries(paymentRows.map((row) => [row.method_key, row]));
    const customEmojis = await customEmojiService.resolveSettings(bot.telegram, settings);
    runtimeUiCache = { settings, links, payments, customEmojis, channelUrl: links.channel?.url || '' };
    runtimeUiCacheAt = Date.now();
    return runtimeUiCache;
  } catch (error) {
    console.warn('dynamic_ui_load_failed', { message: error.message });
    return { settings: {}, links: {}, payments: {}, customEmojis: { enabled: false, icons: {} }, channelUrl: config.channelUrl || '' };
  }
}

function settingTemplate(text, values) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (_m, key) => values[key] == null ? '' : String(values[key]));
}

async function answerCallback(ctx, text, alert = false) {
  if (!ctx.callbackQuery) return;
  try {
    await ctx.answerCbQuery(text, { show_alert: alert });
  } catch (error) {
    if (!String(error.message).includes('query is too old')) console.warn('answer_callback_failed', { message: error.message });
  }
}

function settingOn(value, fallback = true) {
  if (value == null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function paymentPublicConfig(ui, key) {
  const value = ui?.payments?.[key]?.public_config;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function paymentRange(ui, key, fallbackMin, fallbackMax) {
  const values = paymentPublicConfig(ui, key);
  return { min: String(values.minimum || fallbackMin), max: String(values.maximum || fallbackMax) };
}

function paymentPresets(ui, key) {
  const values = paymentPublicConfig(ui, key).presets;
  if (!Array.isArray(values)) return config.deposit.presets;
  const clean = values.map(String).filter((value) => parseDecimalString(value) !== null);
  return clean.length ? clean.slice(0, 20) : config.deposit.presets;
}

function solanaUsdtRange(ui) {
  const values = paymentPublicConfig(ui, 'solana');
  return { min: '1', max: String(values.maximum || 1000) };
}

function customEmoji(fallback, settingKey, ui) {
  return customEmojiService.html(fallback, settingKey, ui?.customEmojis);
}

function decorateFirstEmoji(text, fallback, settingKey, ui) {
  return String(text).replace(fallback, customEmoji(fallback, settingKey, ui));
}

async function rememberTransient(ctx, messageId) {
  if (!ctx.from?.id || !messageId) return;
  await store.rememberTransientBotMessage(ctx.from.id, messageId).catch(() => {});
}

async function sendTransient(ctx, text, extra = {}) {
  const sent = await ctx.reply(text, extra);
  await rememberTransient(ctx, sent?.message_id);
  return sent;
}

async function sendPermanent(ctx, text, extra = {}) {
  return ctx.reply(text, extra);
}

async function cleanupTransientMessages(ctx, preserveIds = []) {
  if (!ctx.from?.id || !ctx.chat?.id) return;
  const state = await store.getUiState(ctx.from.id).catch(() => null);
  const preserve = new Set((preserveIds || []).map(Number));
  const ids = (state?.transient_bot_message_ids || []).map(Number).filter((id) => !preserve.has(id));
  if (ids.length) await deleteMessagesBestEffort(ctx.telegram, ctx.chat.id, ids);
  const remaining = (state?.transient_bot_message_ids || []).map(Number).filter((id) => preserve.has(id));
  await store.saveUiState(ctx.from.id, { transient_bot_message_ids: remaining }).catch(() => {});
}

async function rotateUserMessage(ctx) {
  if (!ctx.from?.id || !ctx.chat?.id || !ctx.message?.message_id) return;
  const ui = await runtimeUi();
  if (!settingOn(ui.settings.chat_cleanup_enabled, true)) return;
  const previous = await store.rotateLastUserMessage(ctx.from.id, ctx.message.message_id).catch(() => null);
  if (previous && Number(previous) !== Number(ctx.message.message_id)) {
    await deleteMessagesBestEffort(ctx.telegram, ctx.chat.id, [previous]);
  }
  await cleanupTransientMessages(ctx);
}

async function hideReplyKeyboard(ctx) {
  try {
    const sent = await ctx.reply('\u2063', keyboards.removeReplyKeyboard());
    if (sent?.message_id) {
      await rememberTransient(ctx, sent.message_id);
      await deleteMessagesBestEffort(ctx.telegram, ctx.chat.id, [sent.message_id]);
    }
  } catch (_) { /* The purchase can continue even when Telegram refuses cleanup. */ }

  // A temporary quantity keyboard replaces the persistent quick actions.
  // Reset the saved state before restoring them, otherwise the bot assumes
  // Shop / Deposit / My Orders are still visible and skips sending them.
  await store.saveUiState(ctx.from.id, {
    keyboard_initialized: false,
    keyboard_signature: null
  }).catch(() => {});
  const ui = await runtimeUi();
  await ensurePersistentKeyboard(ctx, ui);
}

async function rememberMenu(ctx, messageId) {
  if (!ctx.from?.id || !messageId) return;
  await store.saveUiState(ctx.from.id, { last_menu_message_id: messageId }).catch(() => {});
}

async function deletePreviousMenu(ctx, ui) {
  if (!ctx.from?.id || !settingOn(ui?.settings?.delete_previous_navigation_menus, true)) return;
  const state = await store.getUiState(ctx.from.id).catch(() => null);
  const messageId = state?.last_menu_message_id;
  if (!messageId || messageId === ctx.callbackQuery?.message?.message_id) return;
  await deleteMessagesBestEffort(ctx.telegram, ctx.chat.id, [messageId]);
}

async function render(ctx, text, extra = {}) {
  const options = { parse_mode: 'HTML', disable_web_page_preview: true, ...extra };
  const ui = await runtimeUi();
  const forceNew = Boolean(ctx.state.forceNewNavigation);
  ctx.state.forceNewNavigation = false;
  if (ctx.callbackQuery?.message && !forceNew) {
    try {
      const edited = await ctx.editMessageText(text, options);
      await rememberMenu(ctx, ctx.callbackQuery.message.message_id);
      return edited;
    } catch (error) {
      if (String(error.message).includes('message is not modified')) return;
      try { await ctx.deleteMessage(); } catch (_) { /* Media messages cannot always be edited as text. */ }
    }
  } else {
    await deletePreviousMenu(ctx, ui);
  }
  await cleanupTransientMessages(ctx);
  const sent = await ctx.reply(text, options);
  await rememberMenu(ctx, sent?.message_id);
  return sent;
}

async function renderPhoto(ctx, photo, caption, extra = {}) {
  const ui = await runtimeUi();
  const forceNew = Boolean(ctx.state.forceNewNavigation);
  ctx.state.forceNewNavigation = false;
  if (ctx.callbackQuery?.message && !forceNew) {
    try { await ctx.deleteMessage(); } catch (_) { /* Ignore stale menu deletion. */ }
  } else await deletePreviousMenu(ctx, ui);
  await cleanupTransientMessages(ctx);
  const sent = await ctx.replyWithPhoto(photo, { caption, parse_mode: 'HTML', ...extra });
  await rememberMenu(ctx, sent?.message_id);
  return sent;
}

async function ensurePersistentKeyboard(ctx, ui, force = false) {
  const state = await store.getUiState(ctx.from.id).catch(() => null);
  const enabled = settingOn(ui?.settings?.persistent_bottom_keyboard, true);
  if (!enabled) {
    if (state?.keyboard_initialized) {
      const sent = await ctx.reply('\u2063', { reply_markup: { remove_keyboard: true } }).catch(() => null);
      if (sent?.message_id) await rememberTransient(ctx, sent.message_id);
      await store.saveUiState(ctx.from.id, { keyboard_initialized: false, keyboard_signature: null }).catch(() => {});
    }
    return;
  }
  const language = languageOf(ctx);
  const keyboard = keyboards.persistentActions(language, ui);
  const signature = keyboard.reply_markup.keyboard.flat().map((item) => item.text).join('|');
  if (!force && state?.keyboard_initialized && state.keyboard_signature === signature) return;
  const sent = await ctx.reply('\u2063', keyboard);
  // This message owns the persistent Shop / Deposit / My Orders keyboard.
  // Do not register it as transient or delete it: some Telegram clients remove
  // the reply keyboard as soon as its source message is deleted.
  if (!sent?.message_id) return;
  await store.saveUiState(ctx.from.id, { keyboard_initialized: true, keyboard_signature: signature }).catch(() => {});
}

function errorContains(error, code) {
  return `${error.code || ''} ${error.message || ''} ${error.details || ''}`.includes(code);
}

function purchaseErrorKey(error) {
  if (errorContains(error, 'OUT_OF_STOCK')) return 'purchaseOutOfStock';
  if (errorContains(error, 'INSUFFICIENT_BALANCE')) return 'insufficientBalance';
  if (errorContains(error, 'PRODUCT_UNAVAILABLE')) return 'productUnavailable';
  if (errorContains(error, 'USER_SUSPENDED')) return 'accountSuspended';
  if (errorContains(error, 'PURCHASE_MIGRATION_REQUIRED')) return 'purchaseMigrationRequired';
  if (error.purchaseStage === 'delivery_decrypt') return 'deliveryDecryptionError';
  if (errorContains(error, 'INVENTORY_ENCRYPTION_KEY_NOT_CONFIGURED') ||
      errorContains(error, 'INVENTORY_DECRYPTION_FAILED')) return 'inventoryConfigurationError';
  if (errorContains(error, 'DELIVERY_COUNT_MISMATCH')) return 'deliveryIntegrityError';
  return 'genericError';
}

function logPurchaseFailure(event, error, context = {}) {
  const knownReasons = [
    'OUT_OF_STOCK', 'INSUFFICIENT_BALANCE', 'PRODUCT_UNAVAILABLE', 'USER_SUSPENDED',
    'PURCHASE_MIGRATION_REQUIRED', 'INVENTORY_ENCRYPTION_KEY_NOT_CONFIGURED',
    'INVENTORY_DECRYPTION_FAILED', 'DELIVERY_COUNT_MISMATCH', 'PURCHASE_RPC_EMPTY_RESULT'
  ];
  const reason = knownReasons.find((value) => errorContains(error, value)) || 'UNCLASSIFIED';
  console.error(event, {
    userId: context.userId || null,
    productId: context.productId || null,
    quantity: Number(context.quantity) || null,
    orderId: error.safeDetails?.orderId || null,
    stage: error.purchaseStage || 'unknown',
    reason,
    code: String(error.code || 'UNKNOWN').slice(0, 64),
    causeCode: error.causeCode ? String(error.causeCode).slice(0, 64) : null
  });
}

function dateFor(language, value) {
  const locale = language === 'ar' ? 'ar-PS' : language === 'hi' ? 'hi-IN' : 'en-GB';
  return new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

function rateLimited(userId) {
  const now = Date.now();
  if (rateLimits.size > 10_000) {
    for (const [id, value] of rateLimits) {
      if (now - value.startedAt > 60_000) rateLimits.delete(id);
    }
  }
  const entry = rateLimits.get(userId);
  if (!entry || now - entry.startedAt > 10_000) {
    rateLimits.set(userId, { startedAt: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > 20;
}

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  if (rateLimited(ctx.from.id)) {
    await answerCallback(ctx, t(languageOf(ctx), 'rateLimit'), true);
    return;
  }
  try {
    ctx.state.startPayload = extractStartPayload(ctx);
    ctx.state.user = await store.ensureUser(ctx.from, ctx.state.startPayload);
    return await next();
  } catch (error) {
    console.error('update_failed', { updateType: ctx.updateType, userId: ctx.from.id, message: error.message, code: error.code });
    const language = languageOf(ctx);
    await answerCallback(ctx, t(language, 'genericError'), true);
    if (!ctx.callbackQuery) await ctx.reply(t(language, 'genericError'));
  }
});

// Onboarding gate: brand-new users must pick a language (and, if Force Join
// is enabled, join every active Required Channel) before reaching anything
// else. Existing users (onboarding_completed = true from the migration) are
// never affected by this gate.
bot.use(async (ctx, next) => {
  const user = ctx.state.user;
  if (!user || user.onboarding_completed) return next();
  const isStartCommand = ctx.updateType === 'message' && /^\/start\b/.test(ctx.message?.text || '');
  const isAllowedAction = ctx.updateType === 'callback_query' && /^(lang:(en|ar|hi)|forcejoin:verify)$/.test(ctx.callbackQuery?.data || '');
  if (isStartCommand || isAllowedAction) return next();
  if (ctx.callbackQuery) await answerCallback(ctx);
  return renderOnboardingGate(ctx);
});

bot.use(async (ctx, next) => {
  await rotateUserMessage(ctx);
  return next();
});

async function checkForceJoinStatus(ctx) {
  const forceJoinEnabled = await store.isForceJoinEnabled().catch(() => false);
  if (!forceJoinEnabled) return { required: false, missing: [] };
  const channels = await store.getRequiredChannels(true).catch(() => []);
  if (!channels.length) return { required: false, missing: [] };
  const missing = [];
  for (const channel of channels) {
    try {
      const member = await ctx.telegram.getChatMember(channel.chat_ref, ctx.from.id);
      if (!['member', 'administrator', 'creator'].includes(member.status)) missing.push(channel);
    } catch (error) {
      // A single misconfigured/inaccessible channel (bot not admin, invalid
      // chat, private channel, deleted channel, user not found, ...) must
      // never crash the bot or permanently lock every user out. Skip it.
      console.error('force_join_check_failed', { channelId: channel.id, chatRef: channel.chat_ref, message: error.message });
    }
  }
  return { required: true, missing };
}

async function renderAccessRequired(ctx, missingChannels) {
  const language = languageOf(ctx);
  const text = `<b>${escapeHtml(t(language, 'accessRequiredTitle'))}</b>\n\n${escapeHtml(t(language, 'accessRequiredText'))}`;
  await render(ctx, text, keyboards.accessRequired(language, missingChannels));
}

async function renderOnboardingGate(ctx) {
  const language = languageOf(ctx);
  const uiState = await store.getUiState(ctx.from.id).catch(() => null);
  if (!uiState?.onboarding_language_chosen) {
    return render(ctx, t(language, 'chooseLanguageOnboarding'), keyboards.languagesOnboarding());
  }
  const status = await checkForceJoinStatus(ctx);
  if (!status.required || !status.missing.length) {
    ctx.state.user = await store.completeOnboarding(ctx.from.id, language);
    return showMain(ctx);
  }
  return renderAccessRequired(ctx, status.missing);
}

async function showMain(ctx) {
  const [user, stats, ui] = await Promise.all([store.getUser(ctx.from.id), store.getUserStats(ctx.from.id), runtimeUi()]);
  ctx.state.user = user;
  const language = languageOf(ctx);
  // Force a refresh so users affected by an older stale keyboard state recover
  // immediately when they send /start or return to the main menu.
  await ensurePersistentKeyboard(ctx, ui, true);
  if (user.is_suspended) return render(ctx, t(language, 'accountSuspended'), keyboards.mainMenu(language, ui));
  if (String(ui.settings.maintenance_mode || 'false').toLowerCase() === 'true' && !isAdmin(ctx.from.id)) {
    return render(ctx, `<b>${escapeHtml(t(language, 'maintenanceTitle'))}</b>\n\n${escapeHtml(t(language, 'maintenanceText'))}`, keyboards.mainMenu(language, ui));
  }
  const firstName = user.first_name || user.username || 'friend';
  const configuredWelcome = String(ui.settings.welcome_message || '').trim();
  const welcomeTemplate = configuredWelcome && configuredWelcome !== 'Welcome back, {{first_name}}!'
    ? configuredWelcome
    : t(language, 'welcomeBack');
  const welcome = settingTemplate(welcomeTemplate, { first_name: firstName });
  const text = [
    ui.settings.start_message ? escapeHtml(ui.settings.start_message) : '',
    escapeHtml(welcome), '',
    `🆔 <b>${escapeHtml(t(language, 'idLabel'))}:</b> <code>${user.telegram_id}</code>`,
    `${customEmoji('💳', 'price_custom_emoji_id', ui)} <b>${escapeHtml(t(language, 'walletBalanceLabel'))}:</b> $${formatAmount(user.wallet_balance)}`,
    `${customEmoji('🎁', 'stock_custom_emoji_id', ui)} <b>${escapeHtml(t(language, 'totalSpentLabel'))}:</b> $${formatAmount(stats.spent || '0')}`,
    '', escapeHtml(t(language, 'chooseOption')),
    ui.settings.footer ? `\n${escapeHtml(ui.settings.footer)}` : ''
  ].filter((line, index) => !(line === '' && index === 0)).join('\n');
  await render(ctx, text, keyboards.mainMenu(language, ui));
}

async function showCategories(ctx, page = 0) {
  const language = languageOf(ctx);
  const [result, summary, ui] = await Promise.all([store.listCategories(page), store.getCatalogSummary(), runtimeUi()]);
  const showOther = page === 0 && settingOn(ui.settings.show_uncategorized_products, true);
  const uncategorized = showOther ? await store.listUncategorizedProducts(0) : { items: [] };
  const hasCatalog = result.items.length || uncategorized.items.length;
  const rawText = hasCatalog ? t(language, 'productsOverview', summary) : t(language, 'noProducts');
  const text = decorateFirstEmoji(rawText, '🛍', 'product_custom_emoji_id', ui);
  await render(ctx, text, keyboards.categories(language, result.items, page, result.hasNext, {
    layout: ui.settings.category_layout || 'full',
    uncategorized: uncategorized.items,
    uncategorizedTitle: ui.settings.uncategorized_section_title && ui.settings.uncategorized_section_title !== '📦 Other Products'
      ? ui.settings.uncategorized_section_title
      : t(language, 'otherProducts'),
    customEmojis: ui.customEmojis
  }));
}

async function showProducts(ctx, categoryId, page = 0) {
  const language = languageOf(ctx);
  const [category, result, ui] = await Promise.all([
    store.getCategory(categoryId),
    store.listProducts(categoryId, page),
    runtimeUi()
  ]);
  const text = result.items.length
    ? t(language, 'productsTitle', { category: escapeHtml(category.name) })
    : t(language, 'noProducts');
  await render(ctx, decorateFirstEmoji(text, '🛍️', 'product_custom_emoji_id', ui), keyboards.products(language, result.items, categoryId, page, result.hasNext, ui));
}

async function showWallet(ctx) {
  const language = languageOf(ctx);
  const [user, ui] = await Promise.all([store.getUser(ctx.from.id), runtimeUi()]);
  ctx.state.user = user;
  const text = decorateFirstEmoji(t(language, 'walletScreen', { balance: formatAmount(user.wallet_balance) }), '💰', 'price_custom_emoji_id', ui);
  await render(ctx, text, keyboards.wallet(language, ui));
}

async function showOrders(ctx, page = 0) {
  const language = languageOf(ctx);
  return showFilteredOrders(ctx, 'all', page);
}

function warrantyLabel(language, value, unit) {
  if (!value || !unit) return t(language, 'warrantyNone');
  if (unit === 'hours') return `${value}H`;
  if (unit === 'days') return `${value} ${language === 'ar' ? 'يوم' : language === 'hi' ? 'दिन' : value === 1 ? 'Day' : 'Days'}`;
  return `${value} ${language === 'ar' ? 'شهر' : language === 'hi' ? 'महीना' : value === 1 ? 'Month' : 'Months'}`;
}

function estimatedUnitPrice(product, quantity) {
  if (!product.bulk_pricing_enabled) return String(product.price);
  const tier = (product.bulk_pricing_tiers || [])
    .filter((item) => Number(item.min_quantity) <= quantity && (item.max_quantity == null || Number(item.max_quantity) >= quantity))
    .sort((a, b) => Number(b.min_quantity) - Number(a.min_quantity))[0];
  return String(tier?.unit_price || product.price);
}

function stockLimit(product) {
  if (product.unlimited_stock) return null;
  return Math.max(0, Number(product.stock) || 0);
}

function canPurchaseQuantity(product, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2147483647) return false;
  const limit = stockLimit(product);
  return limit === null || quantity <= limit;
}

function productAvailable(product) {
  return Boolean(
    product?.active &&
    product.product_status === 'active' &&
    (product.unlimited_stock || Number(product.stock) > 0)
  );
}

async function sendPurchaseSuccess(ctx, order, language, paymentLabel = 'Wallet') {
  // The purchase RPC marks idempotent replays with already_processed=true, so
  // double-clicks and retries never create a second admin notification.
  await notifySuccessfulOrderAdmins({
    telegram: ctx.telegram,
    adminIds: config.adminIds,
    order,
    customer: ctx.from,
    paymentLabel
  }).catch((error) => {
    // Telegram notification failures must never hide delivery or fail payment.
    console.error('admin_order_notification_unexpected_failure', {
      orderId: order?.order_id || null,
      code: String(error.code || 'UNKNOWN').slice(0, 64)
    });
  });

  const ui = await runtimeUi();
  if (order.fulfillment_type === 'instant') {
    assertDeliveryCount(order, order.deliveries);
    const successIcon = customEmoji('✅', 'success_custom_emoji_id', ui);
    const base = t(language, 'instantOrderSummary', {
      orderId: order.order_id, product: escapeHtml(order.product_name), quantity: order.quantity,
      total: formatAmount(order.total_amount), payment: escapeHtml(paymentLabel), date: dateFor(language, new Date()), successIcon
    });
    const suffix = ui.settings.order_success_message ? `\n\n${escapeHtml(ui.settings.order_success_message)}` : '';
    await sendPermanent(ctx, base + suffix, { parse_mode: 'HTML', disable_web_page_preview: true });
    await sendDeliveryPayloads(ctx, order, language, ui);
  } else {
    const base = t(language, 'manualOrderSuccess', {
      orderId: order.order_id, product: escapeHtml(order.product_name), quantity: order.quantity,
      total: formatAmount(order.total_amount), eta: escapeHtml(order.delivery_time || '—'),
      warranty: warrantyLabel(language, order.warranty_value, order.warranty_unit)
    });
    const suffix = ui.settings.order_pending_message ? `\n\n${escapeHtml(ui.settings.order_pending_message)}` : '';
    await sendPermanent(ctx, base + suffix, { parse_mode: 'HTML', disable_web_page_preview: true });
  }
  await showMain(ctx);
}

async function sendDeliveryPayloads(ctx, order, language, ui, lastExtra = {}) {
  assertDeliveryCount(order, order.deliveries);
  const giftEmoji = customEmoji('🎁', 'stock_custom_emoji_id', ui);
  const result = buildDeliveryView(order, order.deliveries, language, {
    escape: escapeHtml,
    giftEmoji,
    labels: {
      title: t(language, 'deliveryHeader'), product: t(language, 'deliveryProduct'),
      description: t(language, 'deliveryDescription'), instructions: t(language, 'deliveryInstructions'),
      credentials: t(language, 'deliveryCredentials'), item: t(language, 'deliveryItem'), of: t(language, 'deliveryOf'),
      warranty: t(language, 'deliveryWarranty'), notes: t(language, 'deliveryNotes'), copyHint: t(language, 'copyHint')
    }
  });
  for (let index = 0; index < result.parts.length; index += 1) {
    const part = result.parts[index];
    const extra = index === result.parts.length - 1 ? lastExtra : {};
    if (part.type === 'message') {
      await sendPermanent(ctx, part.text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
    } else {
      await ctx.replyWithDocument({ source: Buffer.from(part.value, 'utf8'), filename: `order-${order.order_id ?? order.id}-item-${part.index}.txt` }, { caption: part.itemHeader.replace(/<[^>]+>/g, ''), ...extra });
    }
  }
}

function productCard(language, product, ui = {}) {
  const settings = ui.settings || {};
  const productEmoji = customEmoji(product.emoji || '📦', 'product_custom_emoji_id', ui);
  const priceEmoji = customEmoji('💵', 'price_custom_emoji_id', ui);
  const stockEmoji = customEmoji('🎁', 'stock_custom_emoji_id', ui);
  const soldEmoji = customEmoji('🛍️', 'sold_custom_emoji_id', ui);
  const warrantyEmoji = customEmoji('🛡️', 'warranty_custom_emoji_id', ui);
  const stock = product.unlimited_stock ? '∞' : String(product.stock ?? 0);
  const warranty = warrantyLabel(language, product.warranty_value, product.warranty_unit);
  const typeLabel = product.product_type || (product.fulfillment_type === 'instant' ? t(language, 'activationLink') : t(language, 'manualDelivery'));
  const description = product.full_description || product.description || product.short_description || '';
  const lines = [
    `${productEmoji} <b>${escapeHtml(product.name)}${product.duration ? ` — ${escapeHtml(product.duration)}` : ''}</b>`,
    description ? `\n${escapeHtml(description)}` : '',
    '',
    `${product.fulfillment_type === 'manual' ? '📎' : '🔗'} ${escapeHtml(typeLabel)}`,
    product.delivery_time_label ? `⏱️ ${escapeHtml(product.delivery_time_label)}` : '',
    '',
    `${warrantyEmoji} <b>${escapeHtml(t(language, 'warrantyLabel'))}:</b> ${escapeHtml(warranty)}`,
    `${priceEmoji} <b>${escapeHtml(t(language, 'unitPriceLabel'))}:</b> $${formatAmount(product.price)}`,
    `${stockEmoji} <b>${escapeHtml(t(language, 'stockLabel'))}:</b> ${stock}`,
    `${soldEmoji} <b>${escapeHtml(t(language, 'soldLabel'))}:</b> ${product.sold_count || 0}`
  ].filter(Boolean);
  if (product.bulk_pricing_enabled && product.bulk_pricing_tiers?.length) {
    lines.push('', `💰 <b>${escapeHtml(t(language, 'bulkPricingLabel'))}:</b>`);
    for (const tier of product.bulk_pricing_tiers) {
      const range = tier.max_quantity
        ? `${tier.min_quantity} – ${tier.max_quantity} ${t(language, 'unitsLabel')}`
        : `${tier.min_quantity}+ ${t(language, 'unitsLabel')}`;
      lines.push(`<code>${escapeHtml(range.padEnd(16, ' '))}</code>  <b>$${formatAmount(tier.unit_price)}/${escapeHtml(t(language, 'unitSuffix'))}</b>`);
    }
  }
  if (!productAvailable(product)) {
    lines.push('', `🔴 <b>${escapeHtml(t(language, 'outOfStock'))}</b>`);
  }
  return lines.join('\n');
}

async function showFilteredOrders(ctx, filter = 'all', page = 0) {
  const language = languageOf(ctx);
  if (!['all', '7d', '30d', 'month', 'lastmonth'].includes(filter)) filter = 'all';
  const [result, ui] = await Promise.all([store.listUserOrders(ctx.from.id, page, filter), runtimeUi()]);
  const labelKey = { all: 'filterAll', '7d': 'filter7d', '30d': 'filter30d', month: 'filterMonth', lastmonth: 'filterLastMonth' }[filter];
  const text = t(language, 'ordersSummary', {
    filter: t(language, labelKey), showing: result.items.length, total: result.summary.total || 0,
    delivered: result.summary.delivered || 0, spent: formatAmount(result.summary.spent || '0'), page: page + 1
  });
  await render(ctx, decorateFirstEmoji(text, '📦', 'product_custom_emoji_id', ui), keyboards.orders(language, result.items, filter, page, result.hasNext, ui));
}

async function showDeposits(ctx, page = 0) {
  const language = languageOf(ctx);
  const result = await store.listDeposits(ctx.from.id, page);
  const icons = { approved: '✅', pending: '⏳', pending_review: '⏳', rejected: '❌', expired: '⌛', cancelled: '🚫' };
  const statusKeys = {
    pending: 'statusPending', pending_review: 'statusPendingReview', approved: 'statusApproved',
    rejected: 'statusRejected', expired: 'statusExpired', cancelled: 'statusCancelled'
  };
  const lines = result.items.map((deposit) => {
    if (deposit.payment_method === 'solana') {
      const usdt = formatAmount(deposit.requested_amount || deposit.expected_amount);
      const sol = deposit.crypto_amount ? formatSolAmount(deposit.crypto_amount) : '—';
      const rate = deposit.price_used ? formatAmount(deposit.price_used, 8) : '—';
      return `${icons[deposit.status] || '•'} $${usdt} USDT → ${sol} SOL\nSolana • Rate $${rate}\n${t(language, statusKeys[deposit.status] || 'statusPending')}\n${dateFor(language, deposit.created_at)}`;
    }
    const method = deposit.payment_method === 'binance'
      ? 'Binance Pay'
      : deposit.payment_method === 'usdt_bep20' ? 'USDT (BEP20)' : 'Legacy USDT TRC20';
    return `${icons[deposit.status] || '•'} $${formatAmount(deposit.received_amount || deposit.expected_amount)} USDT\n${method}\n${t(language, statusKeys[deposit.status] || 'statusPending')}\n${dateFor(language, deposit.created_at)}`;
  });
  await render(ctx, lines.length ? `${t(language, 'depositHistory')}\n\n${lines.join('\n\n')}` : t(language, 'noDeposits'),
    keyboards.pagination(language, 'deps', page, result.hasNext, 'menu:wallet'));
}

bot.start(async (ctx) => {
  if (!ctx.state.user.onboarding_completed) return renderOnboardingGate(ctx);
  const payload = String(ctx.state.startPayload || extractStartPayload(ctx) || '');
  const match = payload.match(/^product_(\d+)$/);
  if (match) {
    try {
      const product = await store.getProduct(match[1]);
      if (product && product.product_status !== 'draft' && product.product_status !== 'inactive') {
        const language = languageOf(ctx);
        const ui = await runtimeUi();
        await ensurePersistentKeyboard(ctx, ui);
        const caption = productCard(language, product, ui);
        const image = product.telegram_file_id || (/^https:\/\//i.test(product.image_url || '') ? product.image_url : '');
        if (image) return renderPhoto(ctx, image, caption, keyboards.product(language, product, ui));
        return render(ctx, caption, keyboards.product(language, product, ui));
      }
    } catch (_) { /* Fall back to products when the deep-linked item is unavailable. */ }
    return showCategories(ctx, 0);
  }
  return showMain(ctx);
});
bot.command('cancel', async (ctx) => {
  await store.clearState(ctx.from.id);
  await showMain(ctx);
});

bot.action('menu:main', async (ctx) => { await answerCallback(ctx); await store.clearState(ctx.from.id).catch(() => {}); await showMain(ctx); });
bot.action('menu:products', async (ctx) => { await answerCallback(ctx); await showCategories(ctx, 0); });
bot.action('catalog:other', async (ctx) => { await answerCallback(ctx, t(languageOf(ctx), 'otherProducts')); });
bot.action(/^cats:(\d+)$/, async (ctx) => { await answerCallback(ctx); await showCategories(ctx, pageNumber(ctx.match[1])); });
bot.action(/^cat:(\d+)$/, async (ctx) => { await answerCallback(ctx); await showProducts(ctx, ctx.match[1], 0); });
bot.action(/^prods:(\d+):(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  await showProducts(ctx, ctx.match[1], pageNumber(ctx.match[2]));
});

bot.action(/^prd:(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const [product, ui] = await Promise.all([store.getProduct(ctx.match[1]), runtimeUi()]);
  const caption = productCard(language, product, ui);
  const image = product.telegram_file_id || (/^https:\/\//i.test(product.image_url || '') ? product.image_url : '');
  if (image) {
    try {
      await renderPhoto(ctx, image, caption, keyboards.product(language, product, ui));
      return;
    } catch (error) {
      console.warn('product_image_failed', { productId: product.id, code: error.code });
    }
  }
  await render(ctx, caption, keyboards.product(language, product, ui));
});

bot.action(/^buy:(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  await showPurchaseConfirmation(ctx, ctx.match[1], 1);
});

bot.action(/^buyqty:(\d+):(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  await showPurchaseConfirmation(ctx, ctx.match[1], Number(ctx.match[2]));
});

bot.action(/^qty:(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const product = await store.getProduct(ctx.match[1]);
  if (!productAvailable(product)) {
    return render(ctx, `🔴 <b>${escapeHtml(t(language, 'outOfStock'))}</b>`, keyboards.product(language, product));
  }
  const limit = stockLimit(product);
  const ui = await runtimeUi();
  await store.setState(ctx.from.id, 'awaiting_purchase_quantity', {
    productId: String(product.id),
    stock: limit
  });
  const prompt = limit === null
    ? t(language, 'quantityPromptUnlimited', { product: escapeHtml(product.name) })
    : t(language, 'quantityPromptStock', { product: escapeHtml(product.name), stock: limit });
  await sendTransient(ctx, prompt, keyboards.quantityReply(language, product, ui.settings, ui));
});

async function showPurchaseConfirmation(ctx, productId, quantity) {
  const language = languageOf(ctx);
  if (ctx.state.user.is_suspended) {
    await answerCallback(ctx, t(language, 'accountSuspended'), true);
    return;
  }
  const [product, user] = await Promise.all([store.getProduct(productId), store.getUser(ctx.from.id)]);
  if (!productAvailable(product)) {
    return render(ctx, `🔴 <b>${escapeHtml(t(language, 'outOfStock'))}</b>`, keyboards.product(language, product));
  }
  if (!canPurchaseQuantity(product, quantity)) {
    const limit = stockLimit(product);
    const message = limit === null
      ? t(language, 'invalidPositiveQuantity')
      : t(language, 'invalidQuantityStock', { stock: limit });
    return render(ctx, message, keyboards.product(language, product));
  }
  const unitPrice = estimatedUnitPrice(product, quantity);
  const total = multiplyDecimal(unitPrice, quantity);
  const token = crypto.randomBytes(9).toString('base64url');
  const idempotencyKey = `order:${ctx.from.id}:${crypto.randomUUID()}`;
  await store.setState(ctx.from.id, 'awaiting_purchase_confirm', {
    productId: String(product.id), quantity, token, idempotencyKey
  });
  const balanceScaled = decimalToUnits(String(user.wallet_balance));
  const totalScaled = decimalToUnits(String(total));
  const shortfallRaw = unitsToDecimal(totalScaled > balanceScaled ? totalScaled - balanceScaled : 0n);
  const confirmation = t(language, 'purchaseConfirmation', {
    product: `${product.emoji || '📦'} <b>${escapeHtml(product.name)}${product.duration ? ` — ${escapeHtml(product.duration)}` : ''}</b>`,
    quantity,
    unitPrice: formatAmount(unitPrice),
    total: formatAmount(total),
    balance: formatAmount(user.wallet_balance),
    shortfall: formatAmount(shortfallRaw)
  });
  const ui = await runtimeUi();
  const binanceEnabled = binancePay.enabled && ui.payments.binance?.enabled !== false &&
    isAmountInRange(total, config.binance.minPayment, config.deposit.max);
  await render(ctx, confirmation, keyboards.purchaseConfirmation(language, token, { binanceEnabled, customEmojis: ui.customEmojis }));
}

bot.action(/^confirmbinance:([A-Za-z0-9_-]{12})$/, async (ctx) => {
  const language = languageOf(ctx);
  const state = await store.getState(ctx.from.id);
  if (!state || state.state !== 'awaiting_purchase_confirm' || state.data.token !== ctx.match[1]) {
    await answerCallback(ctx, t(language, 'invalidRequest'), true);
    return;
  }
  if (!binancePay.enabled) {
    await answerCallback(ctx, t(language, 'binanceUnavailable'), true);
    return;
  }
  const ui = await runtimeUi();
  if (ui.payments.binance?.enabled === false) {
    await answerCallback(ctx, t(language, 'binanceUnavailable'), true);
    return;
  }
  const product = await store.getProduct(state.data.productId);
  const quantity = Number(state.data.quantity);
  if (!productAvailable(product) || !canPurchaseQuantity(product, quantity)) {
    await answerCallback(ctx, t(language, 'purchaseOutOfStock'), true);
    return;
  }
  const unitPrice = estimatedUnitPrice(product, quantity);
  const total = multiplyDecimal(unitPrice, quantity);
  if (!isAmountInRange(total, config.binance.minPayment, config.deposit.max)) {
    await answerCallback(ctx, t(language, 'invalidAmount', { min: config.binance.minPayment, max: config.deposit.max }), true);
    return;
  }
  await answerCallback(ctx);
  await createBinanceDeposit(ctx, total, {
    productId: String(product.id),
    quantity,
    idempotencyKey: state.data.idempotencyKey,
    expectedTotal: total
  });
});

bot.action(/^confirm:([A-Za-z0-9_-]{12})$/, async (ctx) => {
  const language = languageOf(ctx);
  const state = await store.getState(ctx.from.id);
  if (!state || state.state !== 'awaiting_purchase_confirm' || state.data.token !== ctx.match[1]) {
    await answerCallback(ctx, t(language, 'invalidRequest'), true);
    return;
  }
  const lockKey = String(ctx.from.id);
  if (purchaseLocks.has(lockKey)) {
    await answerCallback(ctx, t(language, 'purchaseProcessing'), true);
    return;
  }
  purchaseLocks.add(lockKey);
  await answerCallback(ctx, t(language, 'purchaseProcessing'));
  try {
    const order = await store.purchase(ctx.from.id, state.data.productId, Number(state.data.quantity), state.data.idempotencyKey);
    await store.clearState(ctx.from.id);
    await sendPurchaseSuccess(ctx, order, language, 'Wallet');
  } catch (error) {
    const key = purchaseErrorKey(error);
    logPurchaseFailure('wallet_purchase_failed', error, {
      userId: ctx.from.id,
      productId: state.data.productId,
      quantity: state.data.quantity
    });
    const send = ['deliveryIntegrityError', 'deliveryDecryptionError'].includes(key)
      ? sendPermanent : sendTransient;
    await send(ctx, t(language, key, { orderId: error.safeDetails?.orderId || '—' }));
  } finally {
    purchaseLocks.delete(lockKey);
  }
});

bot.action('menu:wallet', async (ctx) => { await answerCallback(ctx); await showWallet(ctx); });
bot.action('wallet:topup', async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const ui = await runtimeUi();
  if (ctx.state.user.is_suspended) return render(ctx, t(language, 'accountSuspended'), keyboards.wallet(language, ui));
  await render(ctx, t(language, 'paymentMethodTitle'), keyboards.paymentMethods(language, ui.payments, ui));
});
bot.action(/^deps:(\d+)$/, async (ctx) => { await answerCallback(ctx); await showDeposits(ctx, pageNumber(ctx.match[1])); });

bot.action('pay:bep20', async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const ui = await runtimeUi();
  if (ui.payments.usdt_bep20?.enabled === false) return render(ctx, t(language, 'bep20Disabled'), keyboards.wallet(language, ui));
  const publicConfig = paymentPublicConfig(ui, 'usdt_bep20');
  const address = String(publicConfig.address || config.deposit.bep20Address || '').trim();
  if (!address) {
    return render(ctx, t(language, 'usdtAddressMissing'), keyboards.paymentMethods(language, ui.payments, ui));
  }
  await render(ctx, t(language, 'amountTitle'), keyboards.amounts(language, 'bep20', paymentPresets(ui, 'usdt_bep20')));
});

bot.action(/^amt:bep20:(custom|\d+(?:\.\d{1,8})?)$/, async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const ui = await runtimeUi();
  const range = paymentRange(ui, 'usdt_bep20', config.deposit.bep20Min, config.deposit.bep20Max);
  if (ctx.match[1] === 'custom') {
    await store.setState(ctx.from.id, 'awaiting_bep20_amount');
    return render(ctx, t(language, 'enterCustomAmount', range), keyboards.markup([[keyboards.button(t(language, 'backToWallet'), 'menu:wallet')]]));
  }
  return createBep20Deposit(ctx, ctx.match[1], ui);
});

bot.action('pay:solana', async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const ui = await runtimeUi();
  if (ui.payments.solana?.enabled === false) return render(ctx, t(language, 'solanaDisabled'), keyboards.wallet(language, ui));
  const publicConfig = paymentPublicConfig(ui, 'solana');
  const address = String(publicConfig.address || '').trim();
  if (!address) return render(ctx, t(language, 'solanaAddressMissing'), keyboards.paymentMethods(language, ui.payments, ui));
  await render(ctx, t(language, 'solanaAmountTitle'), keyboards.amounts(language, 'solana', paymentPresets(ui, 'solana')));
});

bot.action(/^amt:solana:(custom|\d+(?:\.\d{1,8})?)$/, async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const ui = await runtimeUi();
  const range = solanaUsdtRange(ui);
  if (ctx.match[1] === 'custom') {
    await store.setState(ctx.from.id, 'awaiting_solana_amount');
    return render(ctx, t(language, 'enterSolanaUsdtAmount', range), keyboards.markup([[keyboards.button(t(language, 'backToWallet'), 'menu:wallet')]]));
  }
  return createSolanaDeposit(ctx, ctx.match[1], ui);
});

async function createSolanaDeposit(ctx, amount, suppliedUi = null) {
  const language = languageOf(ctx);
  const ui = suppliedUi || await runtimeUi();
  const publicConfig = paymentPublicConfig(ui, 'solana');
  const range = solanaUsdtRange(ui);
  const address = String(publicConfig.address || '').trim();
  if (!address) return sendTransient(ctx, t(language, 'solanaAddressMissing'));
  const normalizedAmount = parseDecimalString(amount);
  if (normalizedAmount === null) return sendTransient(ctx, t(language, 'invalidAmount', range));
  if (!isAmountInRange(normalizedAmount, '1', range.max)) {
    if (!isAmountInRange(normalizedAmount, '1', '999999999')) return sendTransient(ctx, t(language, 'solanaMinimumUsdt'));
    return sendTransient(ctx, t(language, 'invalidAmount', range));
  }
  let quote;
  try { quote = await getSolanaUsdtQuote(); }
  catch (error) { console.error('solana_price_fetch_failed', { code: error.code, message: error.message }); return sendTransient(ctx, t(language, 'solanaPriceUnavailable')); }
  let cryptoAmount;
  try { cryptoAmount = calculateSolAmount(normalizedAmount, quote.price); }
  catch (error) { console.error('solana_quote_calculation_failed', { code: error.code, message: error.message }); return sendTransient(ctx, t(language, 'solanaPriceUnavailable')); }
  const expiryMinutes = Math.max(1, Math.min(1440, Number(publicConfig.expiration_minutes) || 30));
  try {
    const deposit = await store.createDeposit(ctx.from.id, 'solana', normalizedAmount, expiryMinutes, address, { cryptoAmount, price: quote.price, source: quote.source, fetchedAt: quote.fetchedAt });
    await store.setState(ctx.from.id, 'awaiting_solana_txid', { depositId: deposit.id });
    await sendPermanent(ctx, t(language, 'solanaPayment', {
      usdtAmount: formatAmount(normalizedAmount), solAmount: formatSolAmount(cryptoAmount), rate: formatAmount(quote.price, 8),
      address: escapeHtml(address), network: escapeHtml(String(publicConfig.network_name || 'Solana')), minutes: expiryMinutes,
      instructions: escapeHtml(solanaInstructions(language, publicConfig.instructions))
    }), { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboards.solanaReservation(language, deposit.id) });
  } catch (error) {
    console.error('solana_deposit_create_failed', { code: error.code, message: error.message });
    return sendTransient(ctx, t(language, 'solanaPaymentUnavailable'));
  }
}

bot.action('pay:binance', async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const ui = await runtimeUi();
  if (ui.payments.binance?.enabled === false) return render(ctx, '⚠️ Binance deposits are currently disabled.', keyboards.wallet(language, ui));
  if (!binancePay.enabled) {
    return render(ctx, t(language, 'binanceUnavailable'), keyboards.paymentMethods(language, ui.payments, ui));
  }
  await render(ctx, t(language, 'amountTitle'), keyboards.amounts(language, 'binance', paymentPresets(ui, 'binance')));
});

bot.action(/^amt:binance:(custom|\d+(?:\.\d{1,8})?)$/, async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  if (ctx.match[1] === 'custom') {
    await store.setState(ctx.from.id, 'awaiting_binance_amount');
    return render(ctx, t(language, 'enterCustomAmount', { min: config.deposit.min, max: config.deposit.max }),
      keyboards.markup([[keyboards.button(t(language, 'backToWallet'), 'menu:wallet')]]));
  }
  await createBinanceDeposit(ctx, ctx.match[1]);
});

async function createBinanceDeposit(ctx, amount, purchase = null) {
  const language = languageOf(ctx);
  if (!binancePay.enabled) return sendTransient(ctx, t(language, 'binanceUnavailable'));
  const ui = await runtimeUi();
  const range = paymentRange(ui, 'binance', purchase ? config.binance.minPayment : config.deposit.min, config.deposit.max);
  if (!isAmountInRange(amount, range.min, range.max)) {
    return sendTransient(ctx, t(language, 'invalidAmount', range));
  }
  const publicConfig = paymentPublicConfig(ui, 'binance');
  const expiryMinutes = Math.max(1, Math.min(1440, Number(publicConfig.expiration_minutes) || config.binance.expiryMinutes));
  const deposit = await store.createDeposit(ctx.from.id, 'binance', amount, expiryMinutes);
  await store.setState(ctx.from.id, 'awaiting_binance_order_id', {
    depositId: deposit.id,
    purchase: purchase || null
  });
  const checkout = decorateFirstEmoji(t(language, 'binanceCheckout', {
    amount: formatAmount(deposit.expected_amount),
    paymentName: escapeHtml(String(publicConfig.payment_name || config.binance.paymentName || 'Store')),
    payId: escapeHtml(String(publicConfig.pay_id || config.binance.payId || config.binance.uid || '—')),
    instructions: escapeHtml(String(publicConfig.instructions || 'Binance → Pay → Send to the Pay ID above.')),
    minutes: expiryMinutes
  }), '🟡', 'binance_custom_emoji_id', ui);
  await sendPermanent(ctx, checkout, {
    parse_mode: 'HTML', disable_web_page_preview: true,
    ...keyboards.binanceCheckout(language, deposit.id, ui)
  });
}

async function createBep20Deposit(ctx, amount, suppliedUi = null) {
  const language = languageOf(ctx);
  const ui = suppliedUi || await runtimeUi();
  const publicConfig = paymentPublicConfig(ui, 'usdt_bep20');
  const range = paymentRange(ui, 'usdt_bep20', config.deposit.bep20Min, config.deposit.bep20Max);
  const address = String(publicConfig.address || config.deposit.bep20Address || '').trim();
  if (!address) return sendTransient(ctx, t(language, 'usdtAddressMissing'));
  if (!isAmountInRange(amount, range.min, range.max)) return sendTransient(ctx, t(language, 'invalidAmount', range));
  const expiryMinutes = Math.max(1, Math.min(1440, Number(publicConfig.expiration_minutes) || config.deposit.expiryMinutes));
  const deposit = await store.createDeposit(ctx.from.id, 'usdt_bep20', amount, expiryMinutes, address);
  await store.setState(ctx.from.id, 'awaiting_bep20_txid', { depositId: deposit.id });
  await sendPermanent(ctx, t(language, 'bep20Payment', {
    amount: formatAmount(deposit.expected_amount),
    address: escapeHtml(address),
    network: escapeHtml(String(publicConfig.network_name || config.deposit.bep20Network)),
    minutes: expiryMinutes,
    instructions: escapeHtml(String(publicConfig.instructions || 'Add any withdrawal fee on top so the full requested amount arrives.'))
  }), { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboards.usdtReservation(language, deposit.id) });
}

bot.action(/^dep:cancel:([0-9a-f-]{36})$/, async (ctx) => {
  const language = languageOf(ctx);
  const result = await store.cancelDeposit(ctx.from.id, ctx.match[1]);
  await store.clearState(ctx.from.id);
  await answerCallback(ctx, result.status === 'cancelled' ? t(language, 'reservationCancelled') : t(language, 'alreadyProcessed'));
  ctx.state.forceNewNavigation = true;
  await showWallet(ctx);
});

bot.action('menu:language', async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  await render(ctx, t(language, 'languageTitle'), keyboards.languages(language));
});
bot.action(/^lang:(en|ar|hi)$/, async (ctx) => {
  const language = ctx.match[1];
  const wasOnboarding = !ctx.state.user.onboarding_completed;
  ctx.state.user = await store.setLanguage(ctx.from.id, language);
  await answerCallback(ctx, t(language, 'languageChanged'));
  if (wasOnboarding) {
    await store.saveUiState(ctx.from.id, { onboarding_language_chosen: true }).catch(() => {});
    return renderOnboardingGate(ctx);
  }
  await store.saveUiState(ctx.from.id, { keyboard_initialized: false }).catch(() => {});
  await showMain(ctx);
});

bot.action('forcejoin:verify', async (ctx) => {
  const language = languageOf(ctx);
  const status = await checkForceJoinStatus(ctx);
  if (status.required && status.missing.length) {
    await answerCallback(ctx, t(language, 'verifyFailed'), true);
    return renderAccessRequired(ctx, status.missing);
  }
  await answerCallback(ctx, t(language, 'verifySuccess'));
  ctx.state.user = await store.completeOnboarding(ctx.from.id, language);
  return showMain(ctx);
});

bot.action('menu:orders', async (ctx) => { await answerCallback(ctx); await showFilteredOrders(ctx, 'all', 0); });
bot.action(/^orders:(all|7d|30d|month|lastmonth):(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  await showFilteredOrders(ctx, ctx.match[1], pageNumber(ctx.match[2]));
});
bot.action(/^ordersnew:(all|7d|30d|month|lastmonth):(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  ctx.state.forceNewNavigation = true;
  await showFilteredOrders(ctx, ctx.match[1], pageNumber(ctx.match[2]));
});
bot.action(/^orders:(\d+)$/, async (ctx) => { await answerCallback(ctx); await showFilteredOrders(ctx, 'all', pageNumber(ctx.match[1])); });
bot.action(/^order:(\d+):(all|7d|30d|month|lastmonth):(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  let order;
  try {
    order = await store.getOrderDetails(ctx.from.id, ctx.match[1]);
  } catch (error) {
    if (!errorContains(error, 'DELIVERY_COUNT_MISMATCH')) throw error;
    console.error('order_delivery_integrity_failed', { userId: ctx.from.id, orderId: ctx.match[1], expected: error.safeDetails?.expected, actual: error.safeDetails?.actual });
    return sendPermanent(ctx, t(language, 'deliveryIntegrityError'));
  }
  if (!order) return render(ctx, t(language, 'invalidRequest'), keyboards.orderDetails(language, ctx.match[2], pageNumber(ctx.match[3])));
  const icons = { delivered: '✅', processing: '⏳', pending: '⏳', refunded: '↩️', cancelled: '❌' };
  const ui = await runtimeUi();
  const details = t(language, 'orderDetailsV2', {
    id: order.id, statusIcon: icons[order.status] || '•', status: escapeHtml(String(order.status).toUpperCase()),
    product: escapeHtml(order.product_name), quantity: order.quantity, unitPrice: formatAmount(order.unit_price || order.amount),
    total: formatAmount(order.total_amount || order.amount), payment: escapeHtml(order.payment_method || 'wallet'),
    created: dateFor(language, order.created_at), deliveredAt: order.delivered_at ? dateFor(language, order.delivered_at) : '—',
    eta: escapeHtml(order.delivery_time_snapshot || '—'), warranty: warrantyLabel(language, order.warranty_value_snapshot, order.warranty_unit_snapshot), delivery: ''
  });
  const back = keyboards.orderDetails(language, ctx.match[2], pageNumber(ctx.match[3]), ui);
  if (order.deliveries?.length) {
    await sendDeliveryPayloads(ctx, { ...order, order_id: order.id }, language, ui, back);
  } else {
    await sendPermanent(ctx, details, { parse_mode: 'HTML', disable_web_page_preview: true, ...back });
  }
});

bot.action('menu:preorders', async (ctx) => { await answerCallback(ctx); const language = languageOf(ctx); const result = await store.listPreorderProducts(0); await render(ctx, result.items.length ? t(language, 'preordersTitle') : t(language, 'noPreorders'), keyboards.preorderProducts(language, result.items, 0, result.hasNext)); });
bot.action(/^preorders:(\d+)$/, async (ctx) => { await answerCallback(ctx); const language = languageOf(ctx); const page = pageNumber(ctx.match[1]); const result = await store.listPreorderProducts(page); await render(ctx, result.items.length ? t(language, 'preordersTitle') : t(language, 'noPreorders'), keyboards.preorderProducts(language, result.items, page, result.hasNext)); });

bot.action('menu:refunds', async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const items = await store.listRefundEligibleOrders(ctx.from.id);
  await render(ctx, items.length ? t(language, 'refundSelect') : t(language, 'noRefundOrders'), keyboards.refundOrders(language, items));
});
bot.action(/^refund:(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const order = await store.getOrderDetails(ctx.from.id, ctx.match[1]);
  if (!order) return render(ctx, t(language, 'invalidRequest'), keyboards.mainMenu(language, config));
  await store.setState(ctx.from.id, 'awaiting_refund_reason', { orderId: String(order.id) });
  await render(ctx, t(language, 'refundReasonPrompt', { orderId: order.id }), keyboards.markup([[keyboards.button(t(language, 'cancel'), 'menu:main')]]));
});
bot.action('menu:records', async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  await render(ctx, t(language, 'recordsTitle'), keyboards.records(language));
});
bot.action('menu:profile', async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const user = await store.getUser(ctx.from.id);
  await render(ctx, t(language, 'profileText', {
    telegramId: user.telegram_id,
    username: escapeHtml(user.username ? `@${user.username}` : '—'),
    language: user.language,
    balance: formatAmount(user.wallet_balance),
    status: t(language, user.is_suspended ? 'suspended' : 'active')
  }), keyboards.markup([[keyboards.button(t(language, 'back'), 'menu:main')]]));
});
bot.action(/^notes:(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const result = await store.listNotifications(ctx.state.user.id, pageNumber(ctx.match[1]));
  const text = result.items.length
    ? `${t(language, 'notifications')}\n\n${result.items.map((note) => `${escapeHtml(note.message)}\n${dateFor(language, note.created_at)}`).join('\n\n')}`
    : t(language, 'noNotifications');
  await render(ctx, text, keyboards.pagination(language, 'notes', pageNumber(ctx.match[1]), result.hasNext, 'menu:records'));
});
bot.action('menu:referrals', async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const settings = await store.getReferralSettings();
  if (!settings.enabled) return render(ctx, t(language, 'referralsDisabled'), keyboards.mainMenu(language, await runtimeUi()));
  const summary = await store.getUserReferralSummary(ctx.from.id);
  if (!summary.active || !summary.code) return render(ctx, t(language, 'referralsDisabled'), keyboards.mainMenu(language, await runtimeUi()));
  const botInfo = await ctx.telegram.getMe();
  const link = `https://t.me/${botInfo.username}?start=ref_${summary.code}`;
  await render(ctx, t(language, 'referralsScreen', {
    referred: summary.referredCount,
    purchased: summary.purchasedCount,
    percent: summary.commissionPercent,
    earnings: formatAmount(summary.totalEarnings),
    link
  }), keyboards.referralsScreen(language, link));
});

bot.action('menu:more', async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  await render(ctx, `<b>${escapeHtml(t(language, 'moreTitle'))}</b>`, keyboards.moreMenu(language));
});

bot.action('menu:about', async (ctx) => {
  await answerCallback(ctx);
  const ui = await runtimeUi();
  const language = languageOf(ctx);
  const configured = String(ui.settings.about_text || ui.settings.store_description || '').trim();
  const text = configured && configured !== 'Welcome to our digital products store. Fast ordering, secure wallet checkout, and clear delivery status.'
    ? configured : t(language, 'aboutDefault');
  await render(ctx, `<b>${escapeHtml(t(language, 'aboutTitle'))}</b>\n\n${escapeHtml(text)}`, keyboards.markup([[keyboards.button(t(language, 'back'), 'menu:main', 'danger')]]));
});

bot.action('menu:support', async (ctx) => {
  await answerCallback(ctx);
  const currentState = await store.getState(ctx.from.id).catch(() => null);
  if (currentState?.state === 'support_chat') await store.clearState(ctx.from.id).catch(() => {});
  const ui = await runtimeUi();
  const language = languageOf(ctx);
  const configured = String(ui.settings.support_text || '').trim();
  const text = configured && ![
    'Need help? Chat with an admin right here in the bot.',
    'Need help? Chat with an admin right here in the bot, or use the contact button below.'
  ].includes(configured) ? configured : t(language, 'supportDefault');
  await render(ctx, `<b>${escapeHtml(t(language, 'supportTitle'))}</b>\n\n${escapeHtml(text)}`, keyboards.support(language, ui));
});

bot.action('support:chat', async (ctx) => {
  await answerCallback(ctx);
  await store.setState(ctx.from.id, 'support_chat', {});
  const language = languageOf(ctx);
  await render(ctx, `<b>${escapeHtml(t(language, 'chatTitle'))}</b>\n\n${escapeHtml(t(language, 'chatPrompt'))}`,
    keyboards.markup([[keyboards.button(t(languageOf(ctx), 'back'), 'menu:support', 'danger')]]));
});

bot.action('support:faq', async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const items = await store.listFaqs(language, true);
  const faqText = items.length
    ? `<b>${escapeHtml(t(language, 'faqTitle'))}</b>\n\n${escapeHtml(t(language, 'faqChoose'))}`
    : `<b>${escapeHtml(t(language, 'faqTitle'))}</b>\n\n${escapeHtml(t(language, 'faqEmpty'))}`;
  await render(ctx, faqText, keyboards.faq(language, items));
});

bot.action(/^faq:(\d+)$/, async (ctx) => {
  await answerCallback(ctx);
  const language = languageOf(ctx);
  const items = await store.listFaqs(language, true);
  const item = items.find((row) => String(row.id) === String(ctx.match[1]));
  if (!item) return render(ctx, 'This FAQ item is unavailable.', keyboards.faq(language, items));
  await render(ctx, `❓ <b>${escapeHtml(item.question)}</b>\n\n${escapeHtml(item.answer)}`, keyboards.markup([[keyboards.button(t(language, 'back'), 'support:faq', 'danger')]]));
});

bot.action('menu:channel', async (ctx) => {
  const ui = await runtimeUi();
  if (ui.links.channel?.url) return answerCallback(ctx, 'Open the channel button from the main menu.', true);
  return answerCallback(ctx, t(languageOf(ctx), 'channelUnavailable'), true);
});
bot.action('menu:vip', async (ctx) => { await answerCallback(ctx, t(languageOf(ctx), 'vipUnavailable'), true); });

bot.command('admin', async (ctx) => {
  const language = languageOf(ctx);
  if (!isAdmin(ctx.from.id)) return ctx.reply(t(language, 'adminOnly'));
  await ctx.reply(t(language, 'adminPanel'), keyboards.admin(language));
});

bot.action('admin:deposits', async (ctx) => {
  const language = languageOf(ctx);
  if (!isAdmin(ctx.from.id)) return answerCallback(ctx, t(language, 'adminOnly'), true);
  await answerCallback(ctx);
  const result = await store.listDeposits(null, 0, true);
  if (!result.items.length) return ctx.reply(t(language, 'noDeposits'));
  for (const deposit of result.items) await sendAdminDeposit(ctx.telegram, ctx.chat.id, deposit, language);
});

bot.action('admin:orders', async (ctx) => {
  const language = languageOf(ctx);
  if (!isAdmin(ctx.from.id)) return answerCallback(ctx, t(language, 'adminOnly'), true);
  await answerCallback(ctx);
  const result = await store.listOrders(ctx.from.id, 0, true);
  const lines = result.items.map((order) => `#${order.id} • ${escapeHtml(order.product_name)} • $${formatAmount(order.amount)} • ${dateFor(language, order.created_at)}`);
  await ctx.reply(lines.length ? lines.join('\n') : t(language, 'noOrders'), { parse_mode: 'HTML' });
});

async function sendAdminDeposit(telegram, chatId, deposit, language = 'en') {
  const user = deposit.users || {};
  const isSolana = deposit.payment_method === 'solana';
  const legacy = deposit.payment_method === 'usdt_trc20';
  const network = isSolana ? 'Solana' : (legacy ? 'Legacy TRC20' : 'BNB Smart Chain (BEP20)');
  const title = isSolana ? '🟣 New Solana Deposit (USDT → SOL)' : `💎 New USDT Deposit — ${network}`;
  const amountLine = isSolana
    ? `Requested USDT: ${formatAmount(deposit.requested_amount)} USDT\nRequired SOL: ${formatSolAmount(deposit.crypto_amount || '0')} SOL\nSOL/USDT Rate: $${formatAmount(deposit.price_used || '0', 8)}\nPrice Source: ${escapeHtml(deposit.price_source || 'Binance Spot SOLUSDT')}`
    : `Requested Amount: ${formatAmount(deposit.requested_amount)} USDT\nExpected Amount: ${formatAmount(deposit.expected_amount)} USDT`;
  const message = `${title}\n\nUser ID: <code>${user.telegram_id || deposit.telegram_id}</code>\nUsername: ${escapeHtml(user.username ? `@${user.username}` : deposit.username || '—')}\nDeposit ID: <code>${deposit.id}</code>\n${amountLine}\nNetwork: ${network}\nReceiving Address: <code>${escapeHtml(deposit.payment_address || (legacy ? 'Historical record' : config.deposit.bep20Address))}</code>\nTxID: <code>${escapeHtml(deposit.transaction_id)}</code>\nCreated At: ${dateFor(language, deposit.created_at)}\nExpires At: ${dateFor(language, deposit.expires_at)}`;
  await telegram.sendMessage(chatId, message, { parse_mode: 'HTML', reply_markup: keyboards.adminDeposit(language, deposit.id).reply_markup });
}

bot.action(/^ad:(a|r):([0-9a-f-]{36})$/, async (ctx) => {
  const language = languageOf(ctx);
  if (!isAdmin(ctx.from.id)) return answerCallback(ctx, t(language, 'adminOnly'), true);
  const approve = ctx.match[1] === 'a';
  const result = approve
    ? await store.approveDeposit(ctx.match[2], ctx.from.id)
    : await store.rejectDeposit(ctx.match[2], ctx.from.id, 'Rejected by administrator');
  if (!result.credited && !result.changed) {
    await answerCallback(ctx, result.status === 'expired' ? t(language, 'depositExpired') : t(language, 'alreadyProcessed'), true);
    return;
  }
  await answerCallback(ctx, t(language, approve ? 'adminDepositApproved' : 'adminDepositRejected'));
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  const user = await store.getUser(result.telegram_id);
  const userLanguage = normalizeLanguage(user.language);
  await ctx.telegram.sendMessage(result.telegram_id, t(userLanguage, approve ? 'depositApproved' : 'depositRejected', {
    amount: formatAmount(result.amount)
  }));
});

function commandBody(ctx) {
  return ctx.message.text.replace(/^\/\w+(?:@\w+)?\s*/, '').trim();
}

function adminCommand(name, handler) {
  bot.command(name, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply(t(languageOf(ctx), 'adminOnly'));
    try {
      const message = await handler(ctx, commandBody(ctx));
      await ctx.reply(`✅ ${message}`);
    } catch (error) {
      await ctx.reply(`❌ ${error.message}`);
    }
  });
}

adminCommand('category_add', async (_, body) => {
  if (!body) throw new Error('Usage: /category_add Name');
  const row = await store.adminAddCategory(body);
  return `Category #${row.id} added.`;
});
adminCommand('category_edit', async (_, body) => {
  const [id, ...name] = body.split(' ');
  if (!/^\d+$/.test(id) || !name.length) throw new Error('Usage: /category_edit ID New name');
  await store.adminEditCategory(id, name.join(' '));
  return `Category #${id} updated.`;
});
for (const [command, active] of [['category_enable', true], ['category_disable', false]]) {
  adminCommand(command, async (_, body) => {
    if (!/^\d+$/.test(body)) throw new Error(`Usage: /${command} ID`);
    await store.adminToggleCategory(body, active);
    return `Category #${body} ${active ? 'enabled' : 'disabled'}.`;
  });
}
adminCommand('product_add', async (_, body) => {
  const [categoryId, name, price, stock, delivery, description = ''] = body.split('|').map((value) => value.trim());
  if (!/^\d+$/.test(categoryId) || !name || parseDecimalString(price) === null || !/^\d+$/.test(stock) || !delivery) {
    throw new Error('Usage: /product_add CategoryID|Name|Price|Stock|Delivery|Description');
  }
  const row = await store.adminAddProduct(categoryId, name, price, Number(stock), delivery, description);
  return `Product #${row.id} added.`;
});
adminCommand('product_name', async (_, body) => {
  const [id, ...name] = body.split(' ');
  if (!/^\d+$/.test(id) || !name.length) throw new Error('Usage: /product_name ID New name');
  await store.adminEditProduct(id, { name: name.join(' ') });
  return `Product #${id} updated.`;
});
adminCommand('product_description', async (_, body) => {
  const [id, ...description] = body.split(' ');
  if (!/^\d+$/.test(id) || !description.length) throw new Error('Usage: /product_description ID Description');
  await store.adminEditProduct(id, { description: description.join(' ') });
  return `Product #${id} description updated.`;
});
adminCommand('product_delivery', async (_, body) => {
  const [id, ...delivery] = body.split(' ');
  if (!/^\d+$/.test(id) || !delivery.length) throw new Error('Usage: /product_delivery ID Delivery text');
  await store.adminEditProduct(id, { delivery_text: delivery.join(' ') });
  return `Product #${id} delivery updated.`;
});
adminCommand('product_price', async (_, body) => {
  const [id, price] = body.split(/\s+/);
  if (!/^\d+$/.test(id) || parseDecimalString(price) === null) throw new Error('Usage: /product_price ID Price');
  await store.adminEditProduct(id, { price });
  return `Product #${id} price updated.`;
});
adminCommand('product_stock', async (_, body) => {
  const [id, stock] = body.split(/\s+/);
  if (!/^\d+$/.test(id) || !/^\d+$/.test(stock)) throw new Error('Usage: /product_stock ID Stock');
  await store.adminEditProduct(id, { stock: Number(stock) });
  return `Product #${id} stock updated.`;
});
for (const [command, active] of [['product_enable', true], ['product_disable', false]]) {
  adminCommand(command, async (_, body) => {
    if (!/^\d+$/.test(body)) throw new Error(`Usage: /${command} ID`);
    await store.adminEditProduct(body, { active });
    return `Product #${body} ${active ? 'enabled' : 'disabled'}.`;
  });
}
for (const [command, suspended] of [['user_suspend', true], ['user_unsuspend', false]]) {
  adminCommand(command, async (_, body) => {
    if (!/^\d+$/.test(body)) throw new Error(`Usage: /${command} TelegramID`);
    await store.adminSetSuspended(body, suspended);
    return `User ${body} ${suspended ? 'suspended' : 'unsuspended'}.`;
  });
}
adminCommand('notify', async (ctx, body) => {
  if (!body) throw new Error('Usage: /notify Message');
  await store.createNotification(body);
  let offset = 0;
  let delivered = 0;
  while (true) {
    const users = await store.listUserTelegramIds(offset, 100);
    if (!users.length) break;
    for (const user of users) {
      try { await ctx.telegram.sendMessage(user.telegram_id, `🔔 ${body}`); delivered += 1; } catch (error) {
        console.warn('notification_delivery_failed', { userId: user.telegram_id, message: error.message });
      }
    }
    if (users.length < 100) break;
    offset += users.length;
  }
  return `Notification saved and delivered to ${delivered} users.`;
});

bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  const language = languageOf(ctx);
  const text = ctx.message.text.trim();
  const ui = await runtimeUi();
  const withPlainLabels = (values) => values.filter(Boolean).flatMap((value) => [String(value), stripLeadingEmoji(value)]);
  const shopLabels = new Set(withPlainLabels([ui.settings.shop_button_text, '🛍️ Shop', '🛍️ المتجر', '🛍️ दुकान']));
  const depositLabels = new Set(withPlainLabels([ui.settings.deposit_button_text, '➕ Deposit', '➕ إيداع', '➕ जमा']));
  const ordersLabels = new Set(withPlainLabels(['📦 My Orders', '📦 طلباتي', '📦 मेरे ऑर्डर', t(language, 'myOrders')]));
  if (shopLabels.has(text)) { await store.clearState(ctx.from.id).catch(() => {}); return showCategories(ctx, 0); }
  if (depositLabels.has(text)) { await store.clearState(ctx.from.id).catch(() => {}); return showWallet(ctx); }
  if (ordersLabels.has(text)) { await store.clearState(ctx.from.id).catch(() => {}); return showFilteredOrders(ctx, 'all', 0); }
  const state = await store.getState(ctx.from.id);
  if (!state) return;
  if (state.state === 'support_chat') {
    if (!text || text.length > 4000) return ctx.reply(t(language, 'supportMessageTooLong'));
    await store.addSupportMessage(ctx.from.id, text, ctx.message.message_id);
    return sendPermanent(ctx, t(language, 'supportMessageSent'));
  }
  if (state.state === 'awaiting_purchase_quantity') {
    if (text === t(language, 'cancel')) {
      await store.clearState(ctx.from.id);
      await hideReplyKeyboard(ctx);
      const product = await store.getProduct(state.data.productId);
      return render(ctx, productCard(language, product, ui), keyboards.product(language, product, ui));
    }
    if (text === t(language, 'customQuantity')) {
      return ctx.reply(state.data.stock == null
        ? t(language, 'quantityPromptUnlimited', { product: '' })
        : t(language, 'quantityPromptStock', { product: '', stock: state.data.stock }));
    }
    const quantity = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2147483647) {
      return ctx.reply(t(language, 'invalidPositiveQuantity'));
    }
    await hideReplyKeyboard(ctx);
    return showPurchaseConfirmation(ctx, state.data.productId, quantity);
  }
  if (state.state === 'awaiting_refund_reason') {
    if (text.length < 3 || text.length > 1000) return ctx.reply(t(language, 'invalidRequest'));
    try {
      await store.createRefundRequest(ctx.from.id, state.data.orderId, text);
      await store.clearState(ctx.from.id);
      return ctx.reply(t(language, 'refundSubmitted'), keyboards.mainMenu(language, config));
    } catch (error) {
      if (errorContains(error, 'REFUND_ALREADY_OPEN')) return ctx.reply(t(language, 'refundAlreadyOpen'));
      if (errorContains(error, 'REFUND_WINDOW_EXPIRED')) return ctx.reply(t(language, 'refundWindowExpired'));
      throw error;
    }
  }
  if (state.state === 'awaiting_bep20_amount') {
    const currentUi = await runtimeUi();
    const range = paymentRange(currentUi, 'usdt_bep20', config.deposit.bep20Min, config.deposit.bep20Max);
    const amount = parseDecimalString(text);
    if (amount === null || !isAmountInRange(amount, range.min, range.max)) {
      return ctx.reply(t(language, 'invalidAmount', range));
    }
    return createBep20Deposit(ctx, amount, currentUi);
  }
  if (state.state === 'awaiting_solana_amount') {
    const currentUi = await runtimeUi();
    const range = solanaUsdtRange(currentUi);
    const amount = parseDecimalString(text);
    if (amount === null || !isAmountInRange(amount, range.min, range.max)) {
      return ctx.reply(t(language, 'invalidAmount', range));
    }
    return createSolanaDeposit(ctx, amount, currentUi);
  }
  if (state.state === 'awaiting_binance_amount') {
    const amount = parseDecimalString(text);
    if (amount === null || !isAmountInRange(amount, config.deposit.min, config.deposit.max)) {
      return ctx.reply(t(language, 'invalidAmount', { min: config.deposit.min, max: config.deposit.max }));
    }
    return createBinanceDeposit(ctx, amount);
  }
  if (state.state === 'awaiting_binance_order_id') {
    let submittedOrderId;
    try {
      submittedOrderId = orderIdValue(text);
    } catch (_) {
      return ctx.reply(t(language, 'invalidBinanceOrderId'));
    }
    const lockKey = String(ctx.from.id);
    if (binanceVerificationLocks.has(lockKey)) return ctx.reply(t(language, 'binanceChecking'));
    binanceVerificationLocks.add(lockKey);
    try {
      const deposit = await store.getBinanceDeposit(ctx.from.id, state.data.depositId);
      if (!deposit || deposit.payment_method !== 'binance') {
        await store.clearState(ctx.from.id);
        return ctx.reply(t(language, 'invalidRequest'));
      }
      const transaction = await binancePay.verifyIncomingTransaction({
        orderId: submittedOrderId,
        currency: deposit.currency || config.binance.currency,
        startTime: new Date(deposit.created_at).getTime(),
        endTime: Date.now()
      });
      const approved = await store.approveBinanceHistoryPayment(deposit.id, transaction);
      if (!approved.amount_matches) {
        await store.clearState(ctx.from.id);
        return sendPermanent(ctx, t(language, 'binanceWrongAmountWallet', {
          received: formatAmount(approved.amount),
          expected: formatAmount(approved.expected_amount)
        }));
      }

      const purchase = state.data.purchase;
      if (!purchase) {
        await store.clearState(ctx.from.id);
        return sendPermanent(ctx, t(language, 'binancePaymentVerified', { amount: formatAmount(approved.amount) }));
      }

      try {
        const order = await store.purchase(ctx.from.id, purchase.productId, Number(purchase.quantity), purchase.idempotencyKey);
        await store.markOrderPaymentMethod(order.order_id, 'binance').catch((error) => {
          console.warn('binance_order_payment_method_update_failed', { orderId: order.order_id, message: error.message });
        });
        await store.clearState(ctx.from.id);
        return sendPurchaseSuccess(ctx, order, language, 'Binance Pay');
      } catch (error) {
        await store.clearState(ctx.from.id);
        const key = purchaseErrorKey(error);
        logPurchaseFailure('binance_paid_purchase_failed', error, {
          userId: ctx.from.id,
          productId: purchase.productId,
          quantity: purchase.quantity
        });
        if (['deliveryIntegrityError', 'deliveryDecryptionError'].includes(key)) {
          return sendPermanent(ctx, t(language, key, { orderId: error.safeDetails?.orderId || '—' }));
        }
        return sendPermanent(ctx, t(language, 'binancePurchaseFallback', { amount: formatAmount(approved.amount) }));
      }
    } catch (error) {
      if (error.code === 'TRANSACTION_NOT_FOUND') return ctx.reply(t(language, 'binanceOrderNotFound'));
      if (error.code === 'INVALID_ORDER_ID' || error.code === 'INVALID_TRANSACTION_ID') return ctx.reply(t(language, 'invalidBinanceOrderId'));
      if (error.code === 'RECEIVER_MISMATCH' || error.code === 'NOT_INCOMING') return ctx.reply(t(language, 'binanceReceiverMismatch'));
      if (error.code === 'CURRENCY_MISMATCH' || errorContains(error, 'BINANCE_CURRENCY_MISMATCH')) {
        return ctx.reply(t(language, 'binanceCurrencyMismatch', { currency: config.binance.currency }));
      }
      if (error.code === 'TRANSACTION_EXPIRED' || errorContains(error, 'BINANCE_PAYMENT_EXPIRED')) {
        await store.clearState(ctx.from.id);
        return ctx.reply(t(language, 'depositExpired'));
      }
      if (errorContains(error, 'DUPLICATE_BINANCE_TRANSACTION') || error.code === '23505') return ctx.reply(t(language, 'txDuplicate'));
      console.error('binance_history_verification_failed', { userId: ctx.from.id, message: error.message, code: error.code });
      return ctx.reply(t(language, 'genericError'));
    } finally {
      binanceVerificationLocks.delete(lockKey);
    }
  }
  if (state.state === 'awaiting_bep20_txid') {
    if (!isValidBep20TxId(text)) return ctx.reply(t(language, 'invalidTxId'));
    try {
      const deposit = await store.submitUsdtTxId(ctx.from.id, state.data.depositId, text.toLowerCase());
      if (deposit.status === 'expired') {
        await store.clearState(ctx.from.id);
        return ctx.reply(t(language, 'depositExpired'));
      }
      await store.clearState(ctx.from.id);
      await sendPermanent(ctx, t(language, 'txSubmitted'));
      for (const adminId of config.adminIds) {
        try { await sendAdminDeposit(ctx.telegram, adminId, deposit, 'en'); } catch (error) {
          console.error('admin_deposit_notification_failed', { adminId, depositId: deposit.id, message: error.message });
        }
      }
    } catch (error) {
      if (errorContains(error, 'DUPLICATE_TXID') || error.code === '23505') return ctx.reply(t(language, 'txDuplicate'));
      if (errorContains(error, 'DEPOSIT_NOT_PENDING')) return ctx.reply(t(language, 'invalidRequest'));
      throw error;
    }
  }
  if (state.state === 'awaiting_solana_txid') {
    if (!isValidSolanaSignature(text)) return ctx.reply(t(language, 'invalidSolanaSignature'));
    try {
      const deposit = await store.submitUsdtTxId(ctx.from.id, state.data.depositId, text.trim());
      if (deposit.status === 'expired') {
        await store.clearState(ctx.from.id);
        return ctx.reply(t(language, 'depositExpired'));
      }
      await store.clearState(ctx.from.id);
      await sendPermanent(ctx, t(language, 'solanaPendingReview'));
      for (const adminId of config.adminIds) {
        try { await sendAdminDeposit(ctx.telegram, adminId, deposit, 'en'); } catch (error) {
          console.error('admin_deposit_notification_failed', { adminId, depositId: deposit.id, message: error.message });
        }
      }
    } catch (error) {
      if (errorContains(error, 'DUPLICATE_TXID') || error.code === '23505') return ctx.reply(t(language, 'txDuplicate'));
      if (errorContains(error, 'DEPOSIT_NOT_PENDING')) return ctx.reply(t(language, 'invalidRequest'));
      throw error;
    }
  }
});

bot.catch((error, ctx) => {
  console.error('bot_error', {
    updateType: ctx?.updateType,
    userId: ctx?.from?.id,
    message: error.message,
    code: error.code
  });
});

module.exports = { bot, customEmojiService, sendAdminDeposit, isAdmin };

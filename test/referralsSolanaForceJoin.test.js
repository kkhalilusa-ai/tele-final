const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidSolanaAddress,
  isValidSolanaSignature,
  isValidReferralCode,
  isValidMerchantCode,
  parseReferralPayload,
  extractStartPayload
} = require('../src/utils');
const { t } = require('../src/i18n');
const keyboards = require('../src/keyboards');

// ---------------------------------------------------------------------------
// Solana validation
// ---------------------------------------------------------------------------

test('accepts a well-formed Solana wallet address', () => {
  assert.equal(isValidSolanaAddress('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'), true);
  assert.equal(isValidSolanaAddress('11111111111111111111111111111111'), true);
});

test('rejects invalid Solana wallet addresses (EVM-shaped, too short, ambiguous chars)', () => {
  assert.equal(isValidSolanaAddress('0x1234567890123456789012345678901234abcd'), false); // EVM-shaped
  assert.equal(isValidSolanaAddress('short'), false);
  assert.equal(isValidSolanaAddress('0OIl' + 'A'.repeat(30)), false); // contains excluded base58 chars
  assert.equal(isValidSolanaAddress(''), false);
  assert.equal(isValidSolanaAddress(null), false);
});

test('accepts a well-formed Solana transaction signature', () => {
  const signature = '3'.repeat(87);
  assert.equal(isValidSolanaSignature(signature), true);
});

test('rejects invalid Solana transaction signatures', () => {
  assert.equal(isValidSolanaSignature('too-short'), false);
  assert.equal(isValidSolanaSignature('0x' + 'a'.repeat(64)), false); // EVM tx hash shape must not pass
  assert.equal(isValidSolanaSignature(''), false);
});

// ---------------------------------------------------------------------------
// Referral code / payload parsing
// ---------------------------------------------------------------------------

test('validates referral and merchant code shapes', () => {
  assert.equal(isValidReferralCode('AB12CD34'), true);
  assert.equal(isValidReferralCode('ab'), false); // too short
  assert.equal(isValidMerchantCode('MERCHANT01'), true);
  assert.equal(isValidMerchantCode('!!'), false);
});

test('extracts Telegram start payload before Telegraf start middleware runs', () => {
  assert.equal(extractStartPayload({ message: { text: '/start ref_AB12CD34' } }), 'ref_AB12CD34');
  assert.equal(extractStartPayload({ message: { text: '/start@MyStoreBot merchant_ACME123' } }), 'merchant_ACME123');
  assert.equal(extractStartPayload({ message: { text: '/start' } }), null);
  assert.equal(extractStartPayload({ startPayload: 'ref_READY123' }), 'ref_READY123');
});

test('parses a user referral deep-link payload', () => {
  const result = parseReferralPayload('ref_AB12CD34');
  assert.deepEqual(result, { type: 'user', code: 'AB12CD34' });
});


test('user referral payload matches the exact production link format', () => {
  assert.deepEqual(parseReferralPayload('ref_LJFWP8GH'), { type: 'user', code: 'LJFWP8GH' });
  assert.equal(extractStartPayload({ message: { text: '/start ref_LJFWP8GH' } }), 'ref_LJFWP8GH');
});

test('parses a merchant referral deep-link payload', () => {
  const result = parseReferralPayload('merchant_ACME123');
  assert.deepEqual(result, { type: 'merchant', code: 'ACME123' });
});

test('rejects malformed or unrelated deep-link payloads', () => {
  assert.equal(parseReferralPayload('product_42'), null);
  assert.equal(parseReferralPayload('ref_'), null);
  assert.equal(parseReferralPayload(''), null);
  assert.equal(parseReferralPayload(null), null);
});

// ---------------------------------------------------------------------------
// Percentage commission math (mirrors apply_order_referral_commission in SQL)
// ---------------------------------------------------------------------------

function commissionFor(orderTotal, percent) {
  return Math.round(orderTotal * percent) / 100;
}

test('default 10% commission matches the spec examples exactly', () => {
  assert.equal(commissionFor(10, 10), 1);
  assert.equal(commissionFor(25, 10), 2.5);
});

test('custom commission percentages compute proportionally', () => {
  assert.equal(commissionFor(100, 7), 7);
  assert.equal(commissionFor(40, 2.5), 1);
});

// ---------------------------------------------------------------------------
// Keyboards: Referrals button hidden by default, shown once enabled
// ---------------------------------------------------------------------------

test('Referrals button is absent from the main menu by default (feature disabled)', () => {
  const markup = keyboards.mainMenu('en', { settings: {} });
  const allButtons = markup.reply_markup.inline_keyboard.flat();
  assert.equal(allButtons.some((btn) => btn.callback_data === 'menu:referrals'), false);
});

test('Referrals button appears once menu_referrals_enabled is true', () => {
  const markup = keyboards.mainMenu('en', { settings: { menu_referrals_enabled: 'true' } });
  const allButtons = markup.reply_markup.inline_keyboard.flat();
  assert.equal(allButtons.some((btn) => btn.callback_data === 'menu:referrals'), true);
});

test('Referrals button uses the admin-configured label per language when provided', () => {
  const markup = keyboards.mainMenu('ar', {
    settings: { menu_referrals_enabled: 'true', referrals_label_ar: '🎁 مخصص' }
  });
  const allButtons = markup.reply_markup.inline_keyboard.flat();
  const referralsButton = allButtons.find((btn) => btn.callback_data === 'menu:referrals');
  assert.equal(referralsButton.text, '🎁 مخصص');
});

// ---------------------------------------------------------------------------
// Keyboards: payment methods include Solana, honoring the enabled flag
// ---------------------------------------------------------------------------

test('Solana appears in the payment methods keyboard when enabled', () => {
  const markup = keyboards.paymentMethods('en', { solana: { enabled: true, display_name: 'SOL (Solana)' } });
  const allButtons = markup.reply_markup.inline_keyboard.flat();
  assert.equal(allButtons.some((btn) => btn.callback_data === 'pay:solana'), true);
});

test('Solana is hidden from the payment methods keyboard when disabled', () => {
  const markup = keyboards.paymentMethods('en', { solana: { enabled: false } });
  const allButtons = markup.reply_markup.inline_keyboard.flat();
  assert.equal(allButtons.some((btn) => btn.callback_data === 'pay:solana'), false);
});

// ---------------------------------------------------------------------------
// Keyboards: onboarding language selection and mandatory-join screen
// ---------------------------------------------------------------------------

test('onboarding language keyboard offers exactly English, Arabic and Hindi with no escape route', () => {
  const markup = keyboards.languagesOnboarding();
  const callbacks = markup.reply_markup.inline_keyboard.flat().map((btn) => btn.callback_data);
  assert.deepEqual(callbacks.sort(), ['lang:ar', 'lang:en', 'lang:hi']);
});

test('access-required keyboard renders one join button per channel plus Verify, and supports any channel count', () => {
  for (const count of [1, 3, 5]) {
    const channels = Array.from({ length: count }, (_v, i) => ({
      id: i + 1, name: `Channel ${i + 1}`, join_url: `https://t.me/channel${i + 1}`
    }));
    const markup = keyboards.accessRequired('en', channels);
    const rows = markup.reply_markup.inline_keyboard;
    assert.equal(rows.length, count + 1); // one row per channel + Verify row
    assert.equal(rows[rows.length - 1][0].callback_data, 'forcejoin:verify');
    for (let i = 0; i < count; i += 1) assert.equal(rows[i][0].url, `https://t.me/channel${i + 1}`);
  }
});

// ---------------------------------------------------------------------------
// Locales: every new key exists and is translated (non-identity) in en/ar/hi
// ---------------------------------------------------------------------------

test('referral, Solana and force-join strings are translated in all three languages', () => {
  const keys = [
    'referralsButton', 'referralsScreen', 'referralsDisabled', 'copyLink',
    'payLabelSolana', 'solanaDisabled', 'solanaAddressMissing', 'solanaPayment',
    'invalidSolanaSignature', 'solanaPendingReview',
    'accessRequiredTitle', 'accessRequiredText', 'joinChannelButton', 'verifyButton',
    'verifyFailed', 'verifySuccess', 'chooseLanguageOnboarding'
  ];
  for (const language of ['en', 'ar', 'hi']) {
    for (const key of keys) assert.notEqual(t(language, key), key, `${language}.${key} should be translated`);
  }
});

test('all three locale files expose exactly the same set of keys', () => {
  const locales = ['en', 'ar', 'hi'].map((language) => require(`../src/locales/${language}`));
  const expected = Object.keys(locales[0]).sort();
  for (const locale of locales.slice(1)) assert.deepEqual(Object.keys(locale).sort(), expected);
});

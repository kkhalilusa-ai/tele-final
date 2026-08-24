const test = require('node:test');
const assert = require('node:assert/strict');
const { t, normalizeLanguage } = require('../src/i18n');
const keyboards = require('../src/keyboards');

test('English is the safe fallback language', () => {
  assert.equal(normalizeLanguage('invalid'), 'en');
  assert.match(t('invalid', 'welcome'), /Welcome/);
});

test('all languages expose the core store screens', () => {
  for (const language of ['en', 'ar', 'hi']) {
    for (const key of ['welcome', 'products', 'wallet', 'language', 'bep20Payment', 'depositApproved']) {
      assert.notEqual(t(language, key), key);
    }
  }
});

test('all three locales contain every translated key introduced by the upgrade', () => {
  const locales = ['en', 'ar', 'hi'].map((language) => require(`../src/locales/${language}`));
  const expected = Object.keys(locales[0]).sort();
  for (const locale of locales.slice(1)) assert.deepEqual(Object.keys(locale).sort(), expected);
  for (const key of ['preOrders', 'refundRequest', 'purchaseConfirmation', 'instantOrderSuccess', 'manualOrderSuccess', 'ordersSummary', 'refundSubmitted']) {
    for (const language of ['en', 'ar', 'hi']) assert.notEqual(t(language, key), key);
  }
});

test('product buttons use Telegram success and danger styles', () => {
  const result = keyboards.products('en', [
    { id: 1, name: 'Available', price: '4.50', stock: 1, active: true },
    { id: 2, name: 'Empty', price: '4.50', stock: 0, active: true }
  ], 1, 0, false);
  assert.equal(result.reply_markup.inline_keyboard[0][0].style, 'success');
  assert.equal(result.reply_markup.inline_keyboard[1][0].style, 'danger');
});

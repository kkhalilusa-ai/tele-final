const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDecimalString,
  decimalToUnits,
  unitsToDecimal,
  multiplyDecimal,
  isAmountInRange,
  isValidTronTxId,
  escapeHtml
} = require('../src/utils');

test('normalizes decimal input without using floating point arithmetic', () => {
  assert.equal(parseDecimalString('001.2300'), '1.23');
  assert.equal(decimalToUnits('1.000182'), 100018200n);
  assert.equal(parseDecimalString('1.123456789'), null);
  assert.equal(parseDecimalString('-1'), null);
});

test('multiplies money as scaled integers without floating point', () => {
  assert.equal(multiplyDecimal('0.59', 20), '11.8');
  assert.equal(unitsToDecimal(50000000n), '0.5');
  assert.equal(multiplyDecimal('0.00000001', 3), '0.00000003');
});

test('checks inclusive deposit limits exactly', () => {
  assert.equal(isAmountInRange('1', '1', '1000'), true);
  assert.equal(isAmountInRange('1000', '1', '1000'), true);
  assert.equal(isAmountInRange('0.99999999', '1', '1000'), false);
  assert.equal(isAmountInRange('1000.00000001', '1', '1000'), false);
});

test('validates TRON transaction hashes', () => {
  assert.equal(isValidTronTxId('a'.repeat(64)), true);
  assert.equal(isValidTronTxId('z'.repeat(64)), false);
  assert.equal(isValidTronTxId('a'.repeat(63)), false);
});

test('escapes user-controlled HTML', () => {
  assert.equal(escapeHtml('<b>"x" & y</b>'), '&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
});

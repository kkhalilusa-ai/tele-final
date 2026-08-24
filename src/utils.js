const DECIMAL_PATTERN = /^\d+(?:\.\d{1,8})?$/;
const TRON_TX_PATTERN = /^[a-fA-F0-9]{64}$/;
const EVM_TX_PATTERN = /^0x[a-fA-F0-9]{64}$/;
// Base58 alphabet (excludes 0, O, I, l) used by Solana addresses and signatures.
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const REFERRAL_CODE_PATTERN = /^[A-Za-z0-9]{4,16}$/;
const MERCHANT_CODE_PATTERN = /^[A-Za-z0-9]{4,32}$/;

function parseDecimalString(input) {
  const value = String(input || '').trim();
  if (!DECIMAL_PATTERN.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const normalized = `${BigInt(whole)}${fraction ? `.${fraction.replace(/0+$/, '')}` : ''}`.replace(/\.$/, '');
  return normalized;
}

function decimalToUnits(value, scale = 8) {
  const normalized = parseDecimalString(value);
  if (normalized === null) throw new Error('Invalid decimal value');
  const [whole, fraction = ''] = normalized.split('.');
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
}

function unitsToDecimal(value, scale = 8) {
  const units = BigInt(value);
  const divisor = 10n ** BigInt(scale);
  const whole = units / divisor;
  const fraction = String(units % divisor).padStart(scale, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function multiplyDecimal(value, quantity, scale = 8) {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('Invalid quantity');
  return unitsToDecimal(decimalToUnits(value, scale) * BigInt(quantity), scale);
}

function isAmountInRange(value, min, max) {
  const units = decimalToUnits(value);
  return units >= decimalToUnits(min) && units <= decimalToUnits(max);
}

function formatAmount(value, maxDecimals = 8) {
  const number = String(value ?? '0');
  if (!number.includes('.')) return `${number}.00`;
  const [whole, fraction] = number.split('.');
  const trimmed = fraction.slice(0, maxDecimals).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : `${whole}.00`;
}

function isValidTronTxId(value) {
  return TRON_TX_PATTERN.test(String(value || '').trim());
}

function isValidBep20TxId(value) {
  return EVM_TX_PATTERN.test(String(value || '').trim());
}

function isValidSolanaAddress(value) {
  return SOLANA_ADDRESS_PATTERN.test(String(value || '').trim());
}

function isValidSolanaSignature(value) {
  return SOLANA_SIGNATURE_PATTERN.test(String(value || '').trim());
}

function isValidReferralCode(value) {
  return REFERRAL_CODE_PATTERN.test(String(value || '').trim());
}

function isValidMerchantCode(value) {
  return MERCHANT_CODE_PATTERN.test(String(value || '').trim());
}

function extractStartPayload(ctx) {
  if (ctx && ctx.startPayload) return String(ctx.startPayload).trim() || null;
  const text = String(ctx?.message?.text || '').trim();
  const match = text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  return match?.[1]?.trim() || null;
}

function parseReferralPayload(payload) {
  const value = String(payload || '').trim();
  if (/^ref_[A-Za-z0-9]{4,16}$/.test(value)) return { type: 'user', code: value.slice(4) };
  if (/^merchant_[A-Za-z0-9]{4,32}$/.test(value)) return { type: 'merchant', code: value.slice(9) };
  return null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pageNumber(value, fallback = 0) {
  const page = Number.parseInt(value, 10);
  return Number.isInteger(page) && page >= 0 ? page : fallback;
}

module.exports = {
  parseDecimalString,
  decimalToUnits,
  unitsToDecimal,
  multiplyDecimal,
  isAmountInRange,
  formatAmount,
  isValidTronTxId,
  isValidBep20TxId,
  isValidSolanaAddress,
  isValidSolanaSignature,
  isValidReferralCode,
  isValidMerchantCode,
  parseReferralPayload,
  extractStartPayload,
  escapeHtml,
  pageNumber
};

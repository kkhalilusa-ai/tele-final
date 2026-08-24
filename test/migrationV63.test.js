const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(__dirname, '..', 'migration_v6_3_referrals_solana_forcejoin.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');

test('migration file is present, wrapped in a single transaction, and additive-only', () => {
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /^COMMIT;/m);
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /\bDROP\s+DATABASE\b/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+(users|orders|wallet_transactions|deposits)\b/i);
});

test('every new feature defaults to its safe/off state', () => {
  assert.match(sql, /\('referral_enabled',\s*'false'/);
  assert.match(sql, /\('menu_referrals_enabled',\s*'false'/);
  assert.match(sql, /\('force_join_enabled',\s*'false'/);
  assert.match(sql, /\('referral_commission_percent',\s*'10'/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT TRUE/);
});

test('referral commission is applied from inside purchase_product_v2 in the same transaction as the wallet debit', () => {
  const purchaseFn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION purchase_product_v2'));
  const debitIndex = purchaseFn.indexOf("'purchase', -v_total");
  const commissionCallIndex = purchaseFn.indexOf('PERFORM apply_order_referral_commission');
  assert.ok(debitIndex > -1, 'wallet debit insert not found in purchase_product_v2');
  assert.ok(commissionCallIndex > -1, 'apply_order_referral_commission is not called from purchase_product_v2');
  assert.ok(commissionCallIndex > debitIndex, 'commission must be applied after the wallet debit, in the same function/transaction');
});

test('referral commission crediting is idempotent per order (unique order_id + ON CONFLICT DO NOTHING)', () => {
  assert.match(sql, /order_id\s+BIGINT\s+NOT\s+NULL\s+UNIQUE\s+REFERENCES\s+orders/i);
  const commissionFn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION apply_order_referral_commission'));
  assert.match(commissionFn, /ON CONFLICT \(order_id\) DO NOTHING/);
  assert.match(commissionFn, /IF v_commission_id IS NULL THEN RETURN; END IF;/);
});

test('refund reversal is guarded so a refunded order can never be reversed twice', () => {
  const refundFn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION review_refund_request'));
  assert.match(refundFn, /WHERE order_id = v_order\.id AND status = 'credited' FOR UPDATE/);
  assert.match(refundFn, /UPDATE referral_commissions SET status = 'reversed'/);
  // Never push the beneficiary's wallet negative on reversal.
  assert.match(refundFn, /LEAST\(v_commission\.commission_amount, v_beneficiary\.wallet_balance\)/);
});

test('wallet_transactions type constraint is widened without removing existing types', () => {
  const constraint = sql.match(/wallet_transactions_type_check\s+CHECK \(type IN \(([^)]+)\)\)/)[1];
  for (const existing of ['deposit', 'purchase', 'refund', 'adjustment']) {
    assert.ok(constraint.includes(`'${existing}'`), `existing type '${existing}' must remain allowed`);
  }
  assert.ok(constraint.includes("'referral_commission'"));
  assert.ok(constraint.includes("'referral_commission_reversal'"));
});

test('deposits payment_method constraint is widened to include solana without dropping legacy methods', () => {
  const constraint = sql.match(/deposits_payment_method_check\s+CHECK \(payment_method IN \(([^)]+)\)\)/)[1];
  for (const existing of ['binance', 'usdt_bep20', 'usdt_trc20']) {
    assert.ok(constraint.includes(`'${existing}'`), `legacy payment method '${existing}' must remain allowed`);
  }
  assert.ok(constraint.includes("'solana'"));
});

test('Solana address and transaction signature are validated with base58 patterns, not EVM hex patterns', () => {
  const createDepositFn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION create_deposit'), sql.indexOf('CREATE OR REPLACE FUNCTION submit_usdt_txid'));
  assert.match(createDepositFn, /p_method = 'solana'.*\[1-9A-HJ-NP-Za-km-z\]\{32,44\}/s);
  const submitFn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION submit_usdt_txid'));
  assert.match(submitFn, /\[1-9A-HJ-NP-Za-km-z\]\{64,100\}/);
});

test('self-referral and referrer re-assignment are structurally prevented in ensure_bot_user', () => {
  const ensureFn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION ensure_bot_user'));
  assert.match(ensureFn, /IF v_was_new AND p_referral_payload/);
  assert.match(ensureFn, /v_referrer_id <> v_user_id/);
  assert.match(ensureFn, /v_link\.owner_user_id <> v_user_id/);
  assert.match(ensureFn, /WHERE id = v_user_id AND referred_by_user_id IS NULL/);
});

test('a failed channel membership check cannot crash the whole force-join flow (documented in bot.js)', () => {
  const botSrc = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
  const fn = botSrc.slice(botSrc.indexOf('async function checkForceJoinStatus'), botSrc.indexOf('async function renderAccessRequired'));
  assert.match(fn, /try\s*\{[\s\S]*getChatMember/);
  assert.match(fn, /catch\s*\(error\)/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateSolAmount, getSolanaUsdtQuote } = require('../src/services/solanaPrice');

test('ceil SOL quote so rounding never asks for less SOL', () => {
  assert.equal(calculateSolAmount('1', '200'), 0.005);
  assert.equal(calculateSolAmount('1', '199.99999999'), 0.006);
  assert.equal(calculateSolAmount('2.50', '250'), 0.01);
  assert.equal(typeof calculateSolAmount('1', '200'), 'number');
});

test('minimum Solana payment is 1 USDT', () => {
  assert.throws(() => calculateSolAmount('0.99', '200'), /SOLANA_MINIMUM_USDT/);
});

test('SOL quote uses a non-Binance provider when Binance is unavailable', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async url => {
    const value = String(url);
    calls.push(value);

    if (value.includes('binance')) {
      throw Object.assign(new Error('DNS lookup failed'), { code: 'EAI_AGAIN' });
    }

    if (value.includes('coincap')) {
      return new Response(JSON.stringify({ data: { priceUsd: '94.06' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    throw new Error('unexpected provider');
  };

  try {
    const quote = await getSolanaUsdtQuote();
    assert.equal(quote.symbol, 'SOLUSDT');
    assert.equal(quote.price, '94.06');
    assert.equal(quote.source, 'CoinCap SOL/USD');
    assert.ok(calls.some(url => url.includes('coincap')));
  } finally {
    global.fetch = originalFetch;
  }
});

test('SOL quote parses Kraken response', async () => {
  const originalFetch = global.fetch;

  global.fetch = async url => {
    const value = String(url);
    if (value.includes('coincap')) {
      throw Object.assign(new Error('CoinCap unavailable'), { code: 'EAI_AGAIN' });
    }
    if (value.includes('kraken')) {
      return new Response(JSON.stringify({
        error: [],
        result: { SOLUSDT: { c: ['94.07', '1'] } }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw Object.assign(new Error('network down'), { code: 'EAI_AGAIN' });
  };

  try {
    const quote = await getSolanaUsdtQuote();
    assert.equal(quote.price, '94.07');
    assert.equal(quote.source, 'Kraken SOL/USDT');
  } finally {
    global.fetch = originalFetch;
  }
});

test('SOL quote fails with stable code and detailed provider failures', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => {
    throw Object.assign(new Error('network down'), { code: 'EAI_AGAIN' });
  };

  try {
    await assert.rejects(
      () => getSolanaUsdtQuote(),
      error => error && error.code === 'SOL_PRICE_UNAVAILABLE' && Array.isArray(error.failures) && error.failures.length > 0
    );
  } finally {
    global.fetch = originalFetch;
  }
});

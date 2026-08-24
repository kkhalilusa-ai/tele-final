const DEFAULT_PROVIDERS = [
  {
    name: 'CoinCap',
    url: 'https://api.coincap.io/v2/assets/solana',
    parse(payload) {
      return payload?.data?.priceUsd;
    },
    quote: 'USD'
  },
  {
    name: 'Kraken',
    url: 'https://api.kraken.com/0/public/Ticker?pair=SOLUSDT',
    parse(payload) {
      const result = payload?.result || {};
      const key = Object.keys(result)[0];
      return key ? result[key]?.c?.[0] : undefined;
    },
    quote: 'USDT'
  },
  {
    name: 'KuCoin',
    url: 'https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=SOL-USDT',
    parse(payload) {
      return payload?.data?.price;
    },
    quote: 'USDT'
  },
  {
    name: 'Binance',
    url: 'https://data-api.binance.vision/api/v3/ticker/price?symbol=SOLUSDT',
    parse(payload) {
      return payload?.price;
    },
    quote: 'USDT'
  },
  {
    name: 'Binance',
    url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
    parse(payload) {
      return payload?.price;
    },
    quote: 'USDT'
  },
  {
    name: 'Binance',
    url: 'https://api1.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
    parse(payload) {
      return payload?.price;
    },
    quote: 'USDT'
  }
];

const configuredUrls = String(process.env.SOLANA_PRICE_URLS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

const providers = configuredUrls.length
  ? configuredUrls.map(url => ({ name: 'Custom', url, quote: 'USDT', parse: payload => payload?.price }))
  : DEFAULT_PROVIDERS;

const REQUEST_TIMEOUT_MS = Math.max(2000, Number(process.env.SOLANA_PRICE_TIMEOUT_MS) || 8000);
const MAX_ROUNDS = Math.max(1, Math.min(3, Number(process.env.SOLANA_PRICE_RETRIES) || 2));
const RETRY_DELAY_MS = 400;
const USDT_SCALE = 8;
const PRICE_SCALE = 12;
const SOL_SCALE = 9;

function scaledDecimal(value, scale) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error('INVALID_DECIMAL');
  const [whole, fraction = ''] = raw.split('.');
  if (fraction.length > scale) throw new Error('DECIMAL_PRECISION_EXCEEDED');
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt((fraction + '0'.repeat(scale)).slice(0, scale));
}

function unitsToDecimal(units, scale) {
  const value = BigInt(units);
  const divisor = 10n ** BigInt(scale);
  const whole = value / divisor;
  const fraction = String(value % divisor).padStart(scale, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function calculateSolAmount(usdtAmount, solUsdtPrice) {
  const usdtUnits = scaledDecimal(usdtAmount, USDT_SCALE);
  const priceUnits = scaledDecimal(solUsdtPrice, PRICE_SCALE);
  if (usdtUnits < 10n ** BigInt(USDT_SCALE)) {
    const error = new Error('SOLANA_MINIMUM_USDT');
    error.code = 'SOLANA_MINIMUM_USDT';
    throw error;
  }
  if (priceUnits <= 0n) {
    const error = new Error('SOL_PRICE_INVALID');
    error.code = 'SOL_PRICE_INVALID';
    throw error;
  }
  // Calculate safely with BigInt, then round UP to exactly 3 SOL decimals.
  // The returned value is a JavaScript Number as requested, while the calculation
  // itself stays integer-safe to avoid floating-point errors during the quote.
  const numerator = usdtUnits * 10n ** 13n;
  const exactUnits9 = (numerator + priceUnits - 1n) / priceUnits;
  const sol3Scale = 10n ** 6n;
  const roundedUnits3 = (exactUnits9 + sol3Scale - 1n) / sol3Scale;
  return Number(roundedUnits3) / 1000;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchProvider(provider) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(provider.url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'telegram-store-bot/6.5'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const error = new Error(`${provider.name} returned HTTP ${response.status}`);
      error.code = 'SOL_PRICE_API_ERROR';
      throw error;
    }

    const payload = await response.json();
    const price = String(provider.parse(payload) ?? '').trim();

    if (!/^\d+(?:\.\d+)?$/.test(price) || scaledDecimal(price, PRICE_SCALE) <= 0n) {
      const error = new Error(`${provider.name} returned an invalid SOL price.`);
      error.code = 'SOL_PRICE_INVALID';
      throw error;
    }

    return {
      symbol: 'SOLUSDT',
      price,
      source: `${provider.name} SOL/${provider.quote}`,
      fetchedAt: new Date().toISOString(),
      endpoint: provider.url
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      error.code = 'SOL_PRICE_TIMEOUT';
      error.message = `${provider.name} timed out after ${REQUEST_TIMEOUT_MS}ms.`;
    } else if (!error.code) {
      error.code = 'SOL_PRICE_NETWORK_ERROR';
    }
    error.provider = provider.name;
    error.url = provider.url;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getSolanaUsdtQuote() {
  const failures = [];

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    // Query independent providers in parallel. The first successful provider wins.
    const results = await Promise.allSettled(providers.map(fetchProvider));

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === 'fulfilled') return result.value;

      const reason = result.reason || {};
      failures.push({
        round,
        provider: providers[index].name,
        endpoint: providers[index].url,
        code: reason.code || 'SOL_PRICE_UNAVAILABLE',
        message: reason.message || String(reason)
      });
    }

    if (round < MAX_ROUNDS) await wait(RETRY_DELAY_MS * round);
  }

  const error = new Error('Unable to obtain SOL/USDT price from any configured market-data provider.');
  error.code = 'SOL_PRICE_UNAVAILABLE';
  error.failures = failures;
  throw error;
}

module.exports = {
  calculateSolAmount,
  getSolanaUsdtQuote
};

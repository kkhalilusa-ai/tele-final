const crypto = require('node:crypto');
const { config } = require('../config');
const { decimalToUnits } = require('../utils');

class BinancePayError extends Error {
  constructor(message, code = 'BINANCE_PAY_ERROR', details = {}) {
    super(message);
    this.name = 'BinancePayError';
    this.code = code;
    this.details = details;
  }
}

function signQuery(queryString, secretKey) {
  return crypto.createHmac('sha256', secretKey).update(queryString, 'utf8').digest('hex');
}

function orderIdValue(value) {
  // Accept a copied numeric ID, optionally wrapped in a harmless "Order ID"
  // label, while refusing to guess when the message contains several IDs.
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim();
  const compactDigits = normalized.replace(/\s/g, '');
  if (/^\d{8,32}$/.test(compactDigits)) return compactDigits;
  if (/\b(?:transaction|tx)\s*id\b/i.test(normalized) || /\bP_[A-Z0-9_]+\b/i.test(normalized)) {
    throw new BinancePayError('Invalid Binance Order ID', 'INVALID_ORDER_ID');
  }
  const withoutLabel = normalized.replace(/\border\s*(?:id|number|#)\b\s*[:#-]?/ig, ' ');
  const candidates = withoutLabel.match(/\d{8,32}/g) || [];
  const unique = [...new Set(candidates)];
  const residue = withoutLabel.replace(/\d{8,32}/g, '').replace(/[\s`'"#:;,.()[\]{}<>-]/g, '');
  if (unique.length !== 1 || residue) throw new BinancePayError('Invalid Binance Order ID', 'INVALID_ORDER_ID');
  return unique[0];
}

function orderIdMatches(candidate, wanted) {
  try {
    return orderIdValue(candidate) === orderIdValue(wanted);
  } catch (_) {
    return false;
  }
}

function sameAmount(left, right) {
  try {
    return decimalToUnits(String(left)) === decimalToUnits(String(right));
  } catch (_) {
    return false;
  }
}

class BinancePayClient {
  constructor(options = config.binance, fetchImpl = globalThis.fetch) {
    this.options = options;
    this.fetchImpl = fetchImpl;
    this.historyCache = null;
    this.historyCacheAt = 0;
  }

  get enabled() {
    return Boolean(this.options.isReady);
  }

  async getPayTradeHistory({ startTime, endTime, limit = 100 } = {}) {
    if (!this.enabled) {
      throw new BinancePayError('Binance account API is not configured', 'NOT_CONFIGURED');
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new BinancePayError('Fetch API is unavailable', 'FETCH_UNAVAILABLE');
    }

    const params = new URLSearchParams();
    if (Number.isFinite(Number(startTime))) params.set('startTime', String(Math.trunc(Number(startTime))));
    if (Number.isFinite(Number(endTime))) params.set('endTime', String(Math.trunc(Number(endTime))));
    params.set('limit', String(Math.max(1, Math.min(100, Number(limit) || 100))));
    params.set('recvWindow', String(this.options.recvWindow || 5000));
    params.set('timestamp', String(Date.now()));

    const unsignedQuery = params.toString();
    params.set('signature', signQuery(unsignedQuery, this.options.secretKey));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs || 8000);
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}/sapi/v1/pay/transactions?${params.toString()}`, {
        method: 'GET',
        headers: { 'X-MBX-APIKEY': this.options.apiKey },
        signal: controller.signal
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (_) {
        throw new BinancePayError(`Invalid response from Binance (${response.status})`, 'INVALID_RESPONSE');
      }
      if (!response.ok || payload.success === false || (payload.code && String(payload.code) !== '000000')) {
        const code = payload.code ? String(payload.code) : `HTTP_${response.status}`;
        throw new BinancePayError(payload.msg || payload.message || 'Binance API request failed', code, payload);
      }
      return Array.isArray(payload.data) ? payload.data : [];
    } catch (error) {
      if (error.name === 'AbortError') throw new BinancePayError('Binance API request timed out', 'TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getCachedPayTradeHistory({ startTime, endTime, limit = 100, refresh = false, maxAgeMs = 15_000 } = {}) {
    const now = Date.now();
    if (!refresh && this.historyCache && now - this.historyCacheAt < maxAgeMs) {
      return this.historyCache.slice(0, Math.max(1, Math.min(100, Number(limit) || 100)));
    }
    const rows = await this.getPayTradeHistory({ startTime, endTime, limit: 100 });
    this.historyCache = rows;
    this.historyCacheAt = now;
    return rows.slice(0, Math.max(1, Math.min(100, Number(limit) || 100)));
  }

  async testConnection() {
    const rows = await this.getCachedPayTradeHistory({ limit: 1, refresh: true });
    return {
      connected: true,
      readAccess: true,
      payHistoryAccessible: true,
      configuredUid: Boolean(this.options.uid),
      lastSyncTime: new Date(this.historyCacheAt).toISOString(),
      sampleCount: rows.length
    };
  }

  async verifyIncomingTransaction({ orderId, currency, startTime, endTime }) {
    const wantedId = orderIdValue(orderId);
    const rows = await this.getPayTradeHistory({ startTime, endTime, limit: 100 });
    // Strict Order ID verification: only Binance's `orderId` field is accepted.
    // `transactionId` is intentionally NOT used as a fallback.
    const tx = rows.find((item) => orderIdMatches(item?.orderId, wantedId));
    if (!tx) {
      throw new BinancePayError('Transaction was not found in Binance Pay history', 'TRANSACTION_NOT_FOUND');
    }

    const txCurrency = String(tx.currency || '').toUpperCase();
    if (txCurrency !== String(currency || this.options.currency || 'USDT').toUpperCase()) {
      throw new BinancePayError('Transaction currency does not match', 'CURRENCY_MISMATCH', { currency: txCurrency });
    }

    let amountUnits;
    try { amountUnits = decimalToUnits(String(tx.amount)); } catch (_) { amountUnits = 0n; }
    if (amountUnits <= 0n) {
      throw new BinancePayError('Transaction is not an incoming payment', 'NOT_INCOMING');
    }

    const transactionTime = Number(tx.transactionTime);
    if (!Number.isFinite(transactionTime)) {
      throw new BinancePayError('Transaction timestamp is invalid', 'INVALID_TRANSACTION_TIME');
    }
    if (Number.isFinite(Number(startTime)) && transactionTime < Number(startTime) - 120000) {
      throw new BinancePayError('Transaction happened before this payment request', 'TRANSACTION_TOO_EARLY');
    }
    if (Number.isFinite(Number(endTime)) && transactionTime > Number(endTime)) {
      throw new BinancePayError('Transaction happened after this payment request expired', 'TRANSACTION_EXPIRED');
    }

    const receiver = tx.receiverInfo || {};
    const expectedUid = String(this.options.uid || '').trim();
    const expectedPayId = String(this.options.payId || '').trim();
    const receiverUid = String(receiver.binanceId || '').trim();
    const receiverPayId = String(receiver.accountId || '').trim();
    const uidMatches = expectedUid && receiverUid && expectedUid === receiverUid;
    const payIdMatches = expectedPayId && receiverPayId && expectedPayId === receiverPayId;
    if ((expectedUid || expectedPayId) && !uidMatches && !payIdMatches) {
      throw new BinancePayError('Transaction receiver does not match the configured Binance account', 'RECEIVER_MISMATCH', {
        receiverUid,
        receiverPayId
      });
    }

    return {
      transactionId: String(tx.transactionId || tx.orderId || wantedId).trim(),
      orderId: String(tx.orderId || wantedId).trim(),
      submittedOrderId: wantedId,
      transactionTime,
      amount: String(tx.amount),
      currency: txCurrency,
      orderType: String(tx.orderType || ''),
      payerInfo: tx.payerInfo || {},
      receiverInfo: receiver,
      amountMatches: (expectedAmount) => sameAmount(tx.amount, expectedAmount),
      raw: tx
    };
  }
}

const binancePay = new BinancePayClient();

module.exports = {
  BinancePayClient,
  BinancePayError,
  signQuery,
  orderIdValue,
  orderIdMatches,
  sameAmount,
  binancePay
};

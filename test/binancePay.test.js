const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { BinancePayClient, signQuery, sameAmount, orderIdValue, orderIdMatches } = require('../src/services/binancePay');

test('signed Binance account API queries use HMAC-SHA256', () => {
  const query = 'timestamp=1000&recvWindow=5000';
  const signature = signQuery(query, 'secret');
  const expected = crypto.createHmac('sha256', 'secret').update(query).digest('hex');
  assert.equal(signature, expected);
});


test('normalizes one numeric Binance Order ID and rejects transaction IDs or ambiguity', () => {
  assert.equal(orderIdValue(' Order ID: #402117599683977216\n'), '402117599683977216');
  assert.equal(orderIdMatches('402117599683977216', '402117599683977216'), true);
  assert.throws(() => orderIdValue('P_A23P4HGEK2H71116'), (error) => error.code === 'INVALID_ORDER_ID');
  assert.throws(() => orderIdValue('402117599683977216 402117599683977217'), (error) => error.code === 'INVALID_ORDER_ID');
});

test('exact decimal comparison does not use floating point', () => {
  assert.equal(sameAmount('0.59000000', '0.59'), true);
  assert.equal(sameAmount('0.59000001', '0.59'), false);
});

test('verifies an incoming Binance Pay transaction from the configured receiver', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers['X-MBX-APIKEY'], 'api-key');
    assert.match(url, /\/sapi\/v1\/pay\/transactions\?/);
    assert.match(url, /signature=[a-f0-9]{64}/);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: '000000',
        message: 'success',
        data: [{
          orderId: '447818298012852224',
          orderType: 'C2C',
          transactionId: 'P_A23P4HGEK2H71116',
          transactionTime: 1710000000000,
          amount: '0.59000000',
          currency: 'USDT',
          payerInfo: { name: 'Buyer', binanceId: '11111111' },
          receiverInfo: { name: 'Store', binanceId: '263344433' }
        }]
      })
    };
  };
  const client = new BinancePayClient({
    isReady: true,
    apiKey: 'api-key',
    secretKey: 'secret',
    uid: '263344433',
    payId: '',
    currency: 'USDT',
    baseUrl: 'https://api.binance.com',
    recvWindow: 5000,
    timeoutMs: 1000
  }, fetchImpl);

  const result = await client.verifyIncomingTransaction({
    orderId: '447818298012852224',
    currency: 'USDT',
    startTime: 1709999900000,
    endTime: 1710000100000
  });
  assert.equal(result.amount, '0.59000000');
  assert.equal(result.amountMatches('0.59'), true);
});

test('rejects a transaction received by a different Binance UID', async () => {
  const client = new BinancePayClient({
    isReady: true,
    apiKey: 'api-key',
    secretKey: 'secret',
    uid: '263344433',
    payId: '',
    currency: 'USDT',
    baseUrl: 'https://api.binance.com',
    recvWindow: 5000,
    timeoutMs: 1000
  }, async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: '000000', data: [{
      orderId: '447818298012852224', orderType: 'C2C', transactionId: 'P_A23P4HGEK2H71116', transactionTime: 1710000000000,
      amount: '0.59', currency: 'USDT', receiverInfo: { binanceId: '999999999' }
    }] })
  }));

  await assert.rejects(() => client.verifyIncomingTransaction({
    orderId: '447818298012852224', currency: 'USDT',
    startTime: 1709999900000, endTime: 1710000100000
  }), (error) => error.code === 'RECEIVER_MISMATCH');
});

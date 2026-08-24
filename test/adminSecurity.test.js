'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sameOrigin, validLoginOrigin, trustedOrigins } = require('../src/admin/security');

function request(headers, protocol = 'http') {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { protocol, get(name) { return normalized[String(name).toLowerCase()]; } };
}

test('Render HTTPS origin is trusted behind an internal HTTP proxy', () => {
  const req = request({
    host: 'internal-service:10000',
    origin: 'https://my-store.onrender.com',
    'x-forwarded-host': 'my-store.onrender.com',
    'x-forwarded-proto': 'https',
    'sec-fetch-site': 'same-origin'
  });
  assert.equal(trustedOrigins(req).has('https://my-store.onrender.com'), true);
  assert.equal(sameOrigin(req), true);
  assert.equal(validLoginOrigin(req), true);
});

test('cross-site admin login is rejected even when credentials could be valid', () => {
  const req = request({
    host: 'my-store.onrender.com',
    origin: 'https://attacker.example',
    'x-forwarded-host': 'my-store.onrender.com',
    'x-forwarded-proto': 'https',
    'sec-fetch-site': 'cross-site'
  });
  assert.equal(sameOrigin(req), false);
  assert.equal(validLoginOrigin(req), false);
});

test('configured public URL is accepted when proxy host metadata is unavailable', () => {
  const req = request({ origin: 'https://store.example.com', 'sec-fetch-site': 'same-origin' });
  assert.equal(sameOrigin(req, 'https://store.example.com'), true);
});

test('Chrome same-origin login survives an internal Render host mismatch', () => {
  const req = request({
    host: 'internal-service:10000',
    origin: 'https://telegram-store-bot-1-1xvq.onrender.com',
    'x-forwarded-host': 'internal-service:10000',
    'x-forwarded-proto': 'http',
    'sec-fetch-site': 'same-origin'
  });
  assert.equal(sameOrigin(req, 'https://old-service.onrender.com'), false);
  assert.equal(validLoginOrigin(req, 'https://old-service.onrender.com'), true);
});

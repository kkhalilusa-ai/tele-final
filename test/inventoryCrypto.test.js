'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.INVENTORY_ENCRYPTION_KEY = 'ab'.repeat(32);
const { encryptPayload, decryptPayload, hashPayload, maskPayload, encryptionConfigured } = require('../src/security/inventoryCrypto');

test('AES-256-GCM inventory payloads round-trip without storing plaintext', () => {
  const plaintext = 'https://example.com/private/invite-123';
  const encrypted = encryptPayload('7', plaintext);
  assert.equal(encryptionConfigured(), true);
  assert.equal(encrypted.payload_ciphertext.includes(plaintext), false);
  assert.equal(encrypted.payload_iv.length > 8, true);
  assert.equal(encrypted.payload_auth_tag.length > 8, true);
  assert.equal(decryptPayload('7', encrypted), plaintext);
});

test('payload hashes are deterministic per product and encryption uses random IVs', () => {
  const first = encryptPayload('9', 'one-use-code');
  const second = encryptPayload('9', 'one-use-code');
  assert.equal(first.payload_hash, second.payload_hash);
  assert.notEqual(first.payload_ciphertext, second.payload_ciphertext);
  assert.notEqual(hashPayload('9', 'one-use-code'), hashPayload('10', 'one-use-code'));
});

test('tampering or using a different product context fails authentication', () => {
  const encrypted = encryptPayload('11', 'secret');
  assert.throws(() => decryptPayload('12', encrypted), /could not be opened/i);
  assert.match(maskPayload('https://secret.example/code'), /^http\*+code$/);
});

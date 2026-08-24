'use strict';

const crypto = require('node:crypto');
const { config } = require('../config');

function encryptionKey() {
  const raw = String(config.inventoryEncryptionKey || '').trim();
  let key;
  if (/^[a-fA-F0-9]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else {
    try { key = Buffer.from(raw, 'base64'); } catch (_) { key = null; }
  }
  if (!key || key.length !== 32) {
    const error = new Error('Inventory encryption is not configured. Set INVENTORY_ENCRYPTION_KEY to 32 random bytes.');
    error.code = 'INVENTORY_ENCRYPTION_KEY_NOT_CONFIGURED';
    throw error;
  }
  return key;
}

function normalizePayload(value) {
  const payload = String(value ?? '').trim();
  if (!payload || payload.length > 20_000) {
    const error = new Error('Inventory payload must contain between 1 and 20,000 characters.');
    error.code = 'INVALID_INVENTORY_PAYLOAD';
    throw error;
  }
  return payload;
}

function hashPayload(productId, payload, key = encryptionKey()) {
  return crypto.createHmac('sha256', key)
    .update(`inventory:${String(productId)}\0${normalizePayload(payload)}`, 'utf8')
    .digest('hex');
}

function encryptPayload(productId, value) {
  const key = encryptionKey();
  const payload = normalizePayload(value);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`product:${String(productId)}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return {
    payload_ciphertext: ciphertext.toString('base64'),
    payload_iv: iv.toString('base64'),
    payload_auth_tag: cipher.getAuthTag().toString('base64'),
    payload_hash: hashPayload(productId, payload, key)
  };
}

function decryptPayload(productId, encrypted) {
  const key = encryptionKey();
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(String(encrypted.payload_iv), 'base64')
    );
    decipher.setAAD(Buffer.from(`product:${String(productId)}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(String(encrypted.payload_auth_tag), 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(String(encrypted.payload_ciphertext), 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch (_) {
    const error = new Error('The encrypted delivery item could not be opened. Check INVENTORY_ENCRYPTION_KEY.');
    error.code = 'INVENTORY_DECRYPTION_FAILED';
    throw error;
  }
}

function maskPayload(value) {
  const text = String(value || '');
  if (text.length <= 8) return `${text.slice(0, 2)}${'*'.repeat(Math.max(2, text.length - 2))}`;
  return `${text.slice(0, 4)}${'*'.repeat(Math.min(18, text.length - 8))}${text.slice(-4)}`;
}

function encryptionConfigured() {
  try { encryptionKey(); return true; } catch (_) { return false; }
}

module.exports = {
  encryptPayload,
  decryptPayload,
  hashPayload,
  maskPayload,
  normalizePayload,
  encryptionConfigured
};

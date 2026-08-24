'use strict';

const ID_PATTERN = /^\d{5,30}$/;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const SETTING_FALLBACKS = Object.freeze({
  product_custom_emoji_id: '📦',
  price_custom_emoji_id: '💵',
  stock_custom_emoji_id: '🎁',
  sold_custom_emoji_id: '🛍️',
  warranty_custom_emoji_id: '🛡️',
  binance_custom_emoji_id: '🟡',
  success_custom_emoji_id: '✅'
});

function enabled(value, fallback = true) {
  if (value == null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function stripLeadingEmoji(text) {
  return String(text || '').replace(/^(?:\p{Extended_Pictographic}|[+➕◈◇☰])(?:\uFE0F|\uFE0E)?\s*/u, '').trimStart();
}

class CustomEmojiService {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs) || DEFAULT_TTL_MS;
    this.now = options.now || (() => Date.now());
    this.cache = new Map();
  }

  async validateIds(telegram, ids, options = {}) {
    const force = Boolean(options.force);
    const requested = [...new Set((ids || []).map(String).filter(Boolean))];
    const result = new Map();
    const pending = [];
    const now = this.now();

    for (const id of requested) {
      if (!ID_PATTERN.test(id)) {
        result.set(id, { valid: false, animated: false, reason: 'invalid_format' });
        continue;
      }
      const cached = this.cache.get(id);
      if (!force && cached && cached.expiresAt > now) result.set(id, cached.value);
      else pending.push(id);
    }

    for (let offset = 0; offset < pending.length; offset += 200) {
      const batch = pending.slice(offset, offset + 200);
      try {
        const stickers = await telegram.callApi('getCustomEmojiStickers', { custom_emoji_ids: batch });
        const byId = new Map((Array.isArray(stickers) ? stickers : [])
          .filter((item) => item?.custom_emoji_id)
          .map((item) => [String(item.custom_emoji_id), item]));
        for (const id of batch) {
          const sticker = byId.get(id);
          const value = sticker && (!sticker.type || sticker.type === 'custom_emoji')
            ? { valid: true, animated: Boolean(sticker.is_animated || sticker.is_video), fallback: sticker.emoji || null }
            : { valid: false, animated: false, reason: 'not_found' };
          this.cache.set(id, { value, expiresAt: now + this.ttlMs });
          result.set(id, value);
        }
      } catch (error) {
        for (const id of batch) {
          const cached = this.cache.get(id);
          result.set(id, cached?.value || { valid: false, animated: false, reason: 'telegram_unavailable' });
        }
      }
    }
    return result;
  }

  async resolveSettings(telegram, settings = {}, options = {}) {
    const featureEnabled = enabled(settings.custom_emojis_enabled, true);
    const entries = Object.entries(SETTING_FALLBACKS).map(([key, fallback]) => ({
      key, fallback, id: String(settings[key] || '').trim()
    }));
    if (!featureEnabled) {
      return { enabled: false, icons: {}, fallbacks: {}, report: entries.map((item) => ({ ...item, valid: false, animated: false, reason: 'disabled' })) };
    }
    const validation = await this.validateIds(telegram, entries.map((item) => item.id).filter(Boolean), options);
    const icons = {};
    const fallbacks = {};
    const report = entries.map((item) => {
      const status = item.id ? (validation.get(item.id) || { valid: false, animated: false, reason: 'not_checked' }) : { valid: false, animated: false, reason: 'empty' };
      if (status.valid) {
        icons[item.key] = item.id;
        if (status.fallback) fallbacks[item.key] = status.fallback;
      }
      return { ...item, ...status };
    });
    return { enabled: true, icons, fallbacks, report };
  }

  html(fallback, settingKey, resolved) {
    const id = resolved?.enabled ? resolved.icons?.[settingKey] : null;
    const unicodeFallback = resolved?.fallbacks?.[settingKey] || String(fallback).match(/\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?/u)?.[0] || '📦';
    return id ? `<tg-emoji emoji-id="${id}">${unicodeFallback}</tg-emoji>` : fallback;
  }

  button(text, settingKey, resolved) {
    const id = resolved?.enabled ? resolved.icons?.[settingKey] : null;
    return id ? { text: stripLeadingEmoji(text), icon_custom_emoji_id: id } : { text: String(text) };
  }
}

module.exports = {
  ID_PATTERN,
  SETTING_FALLBACKS,
  stripLeadingEmoji,
  CustomEmojiService
};

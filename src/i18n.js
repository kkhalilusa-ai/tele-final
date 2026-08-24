const en = require('./locales/en');
const ar = require('./locales/ar');
const hi = require('./locales/hi');

const locales = { en, ar, hi };
const supportedLanguages = Object.keys(locales);

function normalizeLanguage(language) {
  return supportedLanguages.includes(language) ? language : 'en';
}

function t(language, key, variables = {}) {
  const lang = normalizeLanguage(language);
  const template = locales[lang][key] ?? locales.en[key] ?? key;
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, name) => String(variables[name] ?? ''));
}

module.exports = { t, normalizeLanguage, supportedLanguages };

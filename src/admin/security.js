'use strict';

function requestOrigin(req) {
  const candidate = req.get('origin') || req.get('referer');
  if (!candidate) return null;
  try { return new URL(candidate).origin; } catch (_) { return null; }
}

function trustedOrigins(req, publicBaseUrl = '') {
  const origins = new Set();
  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || String(req.get('host') || '').trim();
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const protocol = forwardedProto || String(req.protocol || '').toLowerCase();
  try {
    if (host && ['http', 'https'].includes(protocol)) origins.add(new URL(`${protocol}://${host}`).origin);
    if (host && host.toLowerCase().endsWith('.onrender.com')) origins.add(new URL(`https://${host}`).origin);
    if (publicBaseUrl) origins.add(new URL(publicBaseUrl).origin);
  } catch (_) { /* Invalid forwarded values are ignored. */ }
  return origins;
}

function sameOrigin(req, publicBaseUrl = '') {
  const supplied = requestOrigin(req);
  return Boolean(supplied && trustedOrigins(req, publicBaseUrl).has(supplied));
}

function validLoginOrigin(req, publicBaseUrl = '') {
  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite === 'cross-site') return false;

  // Sec-Fetch-Site is a browser-controlled forbidden request header. Chrome
  // sends `same-origin` for this form POST even when Render's internal proxy
  // presents a different host/protocol to Express. Trust that signal for the
  // login form while the signed, short-lived pre-auth token remains mandatory.
  if (fetchSite === 'same-origin') return true;

  const hasOrigin = Boolean(req.get('origin') || req.get('referer'));
  if (hasOrigin) return sameOrigin(req, publicBaseUrl);
  return fetchSite === 'none' || fetchSite === '';
}

module.exports = { requestOrigin, trustedOrigins, sameOrigin, validLoginOrigin };

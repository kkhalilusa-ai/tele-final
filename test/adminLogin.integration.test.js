'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = '123456:TEST_TOKEN_FOR_LOCAL_INTEGRATION';
process.env.ADMIN_IDS = '123456789';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.ADMIN_WEB_USERNAME = 'render-admin';
process.env.ADMIN_WEB_PASSWORD = 'correct-password';
process.env.ADMIN_WEB_TELEGRAM_ID = '123456789';
process.env.ADMIN_SESSION_SECRET = 'ab'.repeat(32);
process.env.PUBLIC_BASE_URL = 'https://store-test.onrender.com';
process.env.RENDER = 'true';

const app = require('../index');

async function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function loginForm(base) {
  const response = await fetch(`${base}/admin/login`);
  const html = await response.text();
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'signed pre-auth token must be present');
  return match[1];
}

test('valid admin login succeeds behind Render HTTP-to-HTTPS proxy and cross-site fails', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = await loginForm(base);
    const valid = await fetch(`${base}/admin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://store-test.onrender.com',
        'x-forwarded-host': 'store-test.onrender.com',
        'x-forwarded-proto': 'https',
        'sec-fetch-site': 'same-origin'
      },
      body: new URLSearchParams({ _csrf: token, username: 'render-admin', password: 'correct-password' })
    });
    assert.equal(valid.status, 303);
    assert.equal(valid.headers.get('location'), '/admin');
    assert.match(valid.headers.get('set-cookie') || '', /tg_store_admin_session=/);

    const renderMismatchToken = await loginForm(base);
    const renderMismatch = await fetch(`${base}/admin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://telegram-store-bot-1-1xvq.onrender.com',
        'x-forwarded-host': 'internal-service:10000',
        'x-forwarded-proto': 'http',
        'sec-fetch-site': 'same-origin'
      },
      body: new URLSearchParams({ _csrf: renderMismatchToken, username: 'render-admin', password: 'correct-password' })
    });
    assert.equal(renderMismatch.status, 303);

    const crossSiteToken = await loginForm(base);
    const crossSite = await fetch(`${base}/admin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://attacker.example',
        'x-forwarded-host': 'store-test.onrender.com',
        'x-forwarded-proto': 'https',
        'sec-fetch-site': 'cross-site'
      },
      body: new URLSearchParams({ _csrf: crossSiteToken, username: 'render-admin', password: 'correct-password' })
    });
    assert.equal(crossSite.status, 403);
  } finally {
    await close(server);
  }
});

// Integration smoke test: mock Telegram signature, isolated SQLite and HTTP cookie.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupny-tg-smoke-'));
process.env.LOZHA_DATA = dir;
process.env.LOZHA_TRUST_PROXY = '1';
process.env.TELEGRAM_BOT_TOKEN = '100000001:ONLY_FOR_LOCAL_TESTS';
process.env.DUPNY_OWNER_TG_ID = '8294117388';
process.env.LOZHA_OWNER = 'IntegrationTestOwner';
process.env.LOZHA_OWNER_PASSWORD = 'integration-test-only';

const { db } = await import('../server/db.js');
const auth = await import('../server/auth.js');
const { handle, route } = await import('../server/http.js');
const { registerTelegramRoutes } = await import('../server/telegram-auth.js');
await auth.ensureOwner();
registerTelegramRoutes();
route('GET', '/api/me', async ({ req, res }) => {
  const u = auth.currentUser(req);
  const body = JSON.stringify({ user: u ? auth.publicUser(u) : null });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}, { auth: false });

const server = http.createServer(handle);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

function initData(id) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id, first_name: 'Тест Dupny', username: 'test_dupny_001' })
  });
  const check = [...params.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key,value]) => key + '=' + value).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData')
    .update(process.env.TELEGRAM_BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}
async function signedLogin(id) {
  const res = await fetch(base + '/api/telegram/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ initData: initData(id) }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, 'Telegram login must work: ' + JSON.stringify(body));
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /SameSite=None/i);
  assert.match(cookie, /;\s*Secure/i);
  assert.match(cookie, /;\s*Partitioned/i);
  assert.ok(cookie.startsWith('lozha_s='), 'Secure session cookie expected');
  const me = await fetch(base + '/api/me', {
    headers: { cookie: cookie.split(';')[0], 'x-forwarded-proto': 'https' },
  });
  assert.equal(me.status, 200);
  const profile = (await me.json()).user;
  assert.equal(profile.telegram.id, String(id));
  assert.equal(profile.role, String(id) === process.env.DUPNY_OWNER_TG_ID ? 'owner' : 'friend');
  assert.match(profile.login, /^@/);
}
try {
  // A valid signed owner gets role owner. A valid friend never inherits that role.
  await signedLogin(8294117388);
  await signedLogin(1234567890);
  // A forged Telegram payload is not authorized.
  const forged = new URLSearchParams(initData(8294117388));
  forged.set('user', JSON.stringify({ id: 8294117388, first_name: 'Fake' }));
  const bad = await fetch(base + '/api/telegram/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ initData: forged.toString() })
  });
  assert.equal(bad.status, 401, 'Invalid Telegram HMAC must be rejected');
  const response = await fetch(base + '/');
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('x-frame-options'), false, 'Telegram iframe must be allowed');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors[^;]*web\.telegram\.org/);
  console.log('[Dupny test] Telegram login, owner role, cookie, signature and iframe: PASS');
} finally {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

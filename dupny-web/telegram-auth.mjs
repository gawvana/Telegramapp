// Telegram identity only. No passwords, registration form or client-supplied role.
import crypto from 'node:crypto';
import { db, sql, tx } from './db.js';
import { route, readJson, sendJson } from './http.js';
import * as auth from './auth.js';
import { HttpError } from './util.js';

db.exec('CREATE TABLE IF NOT EXISTS telegram_accounts (' +
  'telegram_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE ' +
  'REFERENCES users(id) ON DELETE CASCADE, referred_by TEXT, created_at INTEGER NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS telegram_sessions (' +
  'session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE)');
// Referrals received from the bot are saved before the invitee opens a Mini App.
db.exec('CREATE TABLE IF NOT EXISTS pending_telegram_referrals (' +
  'invitee_id TEXT PRIMARY KEY, inviter_id TEXT NOT NULL, expires_at INTEGER NOT NULL)');
const columns = new Set(db.prepare('PRAGMA table_info(telegram_accounts)').all().map(c => c.name));
if (!columns.has('username')) db.exec('ALTER TABLE telegram_accounts ADD COLUMN username TEXT');
if (!columns.has('photo_url')) db.exec('ALTER TABLE telegram_accounts ADD COLUMN photo_url TEXT');

function validatedUser(initData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new HttpError(503, 'Вход через Telegram не настроен');
  if (typeof initData !== 'string' || initData.length < 30 || initData.length > 8192) {
    throw new HttpError(401, 'Открой Dupny из Telegram');
  }
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (params.getAll('hash').length !== 1 || !/^[a-f0-9]{64}$/i.test(hash || '')) {
    throw new HttpError(401, 'Некорректные данные Telegram');
  }
  const check = [...params.entries()].filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = crypto.createHmac('sha256', secret).update(check).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(hash, 'hex'))) {
    throw new HttpError(401, 'Подпись Telegram не совпала');
  }
  const now = Math.floor(Date.now() / 1000);
  const authDate = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(authDate) || now - authDate > 3600 || authDate > now + 60) {
    throw new HttpError(401, 'Обнови Mini App в Telegram');
  }
  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch {}
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new HttpError(401, 'Аккаунт Telegram не найден');
  }
  return { user, startParam: params.get('start_param') || '' };
}
function displayName(u) {
  return [u.first_name, u.last_name].filter(v => typeof v === 'string')
    .join(' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Пользователь Telegram';
}
function usernameOf(u) {
  return typeof u.username === 'string' && /^[A-Za-z0-9_]{5,32}$/.test(u.username)
    ? u.username : null;
}
function photoOf(u) {
  if (typeof u.photo_url !== 'string') return null;
  try {
    const url = new URL(u.photo_url);
    return url.protocol === 'https:' && u.photo_url.length < 1000 ? url.toString() : null;
  } catch { return null; }
}
function invitedBy(raw, selfId) {
  const m = /^ref_(\d{4,18})$/.exec(String(raw || ''));
  if (!m || m[1] === selfId) return null;
  return sql('SELECT telegram_id FROM telegram_accounts WHERE telegram_id = ?').get(m[1])
    ? m[1] : null;
}
async function createTelegramIdentity(tg, isOwner, referrer) {
  const password = await auth.hashPassword(crypto.randomBytes(32).toString('hex'));
  const id = String(tg.id);
  let login = 'tg_' + id;
  let suffix = 0;
  while (sql('SELECT id FROM users WHERE login_key = ?').get(auth.loginKey(login))) {
    login = 'tg_' + id + '_' + (++suffix);
  }
  return tx(() => {
    const now = Date.now();
    const res = sql('INSERT INTO users (login, login_key, name, pass, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(login, auth.loginKey(login), displayName(tg), password, isOwner ? 'owner' : 'friend', now);
    const uid = Number(res.lastInsertRowid);
    sql('INSERT INTO telegram_accounts (telegram_id, user_id, referred_by, username, photo_url, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, uid, referrer, usernameOf(tg), photoOf(tg), now);
    return uid;
  });
}
export function registerTelegramRoutes() {
  // Trust bot-originated /start payloads, not arbitrary client supplied Telegram IDs.
  route('POST', '/api/telegram/referral', async ({ req, res }) => {
    const body = await readJson(req, 2000);
    const invitee = String(body.inviteeId || '');
    const inviter = String(body.inviterId || '');
    const timestamp = Number(body.timestamp);
    const signature = String(body.signature || '');
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new HttpError(503, 'Telegram bot is not configured');
    if (!/^\d{4,18}$/.test(invitee) || !/^\d{4,18}$/.test(inviter) ||
        inviter === invitee || !Number.isSafeInteger(timestamp) ||
        Math.abs(Date.now() / 1000 - timestamp) > 300 ||
        !/^[a-f0-9]{64}$/i.test(signature)) {
      throw new HttpError(403, 'Invalid referral');
    }
    const expected = crypto.createHmac('sha256', token)
      .update(invitee + ':' + inviter + ':' + timestamp).digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
      throw new HttpError(403, 'Invalid referral signature');
    }
    const existing = sql('SELECT referred_by FROM telegram_accounts WHERE telegram_id = ?').get(invitee);
    // Never let a fresh link overwrite an established friendship.
    if (!existing?.referred_by) {
      sql('INSERT INTO pending_telegram_referrals (invitee_id, inviter_id, expires_at) ' +
        'VALUES (?, ?, ?) ON CONFLICT(invitee_id) DO UPDATE SET ' +
        'inviter_id = excluded.inviter_id, expires_at = excluded.expires_at')
        .run(invitee, inviter, Date.now() + 7 * 86400000);
    }
    sendJson(res, 200, { ok: true });
  }, { auth: false });
  // Disable legacy login and password-based invitation registration. Telegram is the only entry point.
  for (const url of ['/api/login', '/api/register']) {
    route('POST', url, () => { throw new HttpError(403, 'Открой Dupny через Telegram'); }, { auth: false });
  }
  route('POST', '/api/telegram/auth', async ({ req, res }) => {
    const body = await readJson(req, 12_000);
    const { user: tg, startParam } = validatedUser(body.initData);
    const id = String(tg.id);
    const ownerId = process.env.DUPNY_OWNER_TG_ID;
    if (!/^\d+$/.test(ownerId || '')) throw new HttpError(503, 'Владелец Mini App не настроен');
    const isOwner = id === ownerId;
    const mapping = sql('SELECT user_id FROM telegram_accounts WHERE telegram_id = ?').get(id);
    // Signed Mini App start_param wins; bot /start is a fallback when users launch
    // the Mini App from its normal menu rather than the referral-specific button.
    const pending = sql('SELECT inviter_id FROM pending_telegram_referrals ' +
      'WHERE invitee_id = ? AND expires_at > ?').get(id, Date.now());
    const referrer = invitedBy(startParam, id) ||
      invitedBy(body.referral, id) || invitedBy(pending?.inviter_id ? 'ref_' + pending.inviter_id : '', id);
    let uid = mapping?.user_id;
    // Existing users can accept a friend invitation exactly once.
    // Never replace a previously established inviter.
    if (uid && referrer) {
      sql('UPDATE telegram_accounts SET referred_by = ? ' +
        'WHERE telegram_id = ? AND referred_by IS NULL').run(referrer, id);
    }
    if (!uid && isOwner) {
      // Reuse an unmapped legacy owner to retain their media and settings.
      const legacy = sql('SELECT u.id FROM users u LEFT JOIN telegram_accounts t ON t.user_id = u.id ' +
        "WHERE u.role = 'owner' AND t.user_id IS NULL ORDER BY u.id LIMIT 1").get();
      if (legacy) {
        uid = legacy.id;
        sql('INSERT INTO telegram_accounts (telegram_id, user_id, username, photo_url, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, uid, usernameOf(tg), photoOf(tg), Date.now());
      }
    }
    if (!uid) uid = await createTelegramIdentity(tg, isOwner, referrer);
    if (referrer) sql('DELETE FROM pending_telegram_referrals WHERE invitee_id = ?').run(id);
    const current = sql('SELECT * FROM users WHERE id = ?').get(uid);
    if (!current) throw new HttpError(401, 'Аккаунт не найден');
    // The verified Telegram ID, never cookies or client JSON, decides ownership.
    const desiredRole = isOwner ? 'owner' : 'friend';
    if (current.role !== desiredRole) auth.destroyUserSessions(uid);
    tx(() => {
      sql('UPDATE users SET name = ?, role = ? WHERE id = ?').run(displayName(tg), desiredRole, uid);
      sql('UPDATE telegram_accounts SET username = ?, photo_url = ? WHERE telegram_id = ?')
        .run(usernameOf(tg), photoOf(tg), id);
    });
    const u = sql('SELECT * FROM users WHERE id = ?').get(uid);
    const session = auth.createSession(uid, req.headers['user-agent']);
    const sid = crypto.createHash('sha256').update(session).digest('hex');
    sql('INSERT INTO telegram_sessions (session_id) VALUES (?)').run(sid);
    sendJson(res, 200, {
      ok: true,
      user: auth.publicUser(u),
      inviteUrl: 'https://t.me/DupnyApp?start=ref_' + id,
    }, { 'set-cookie': auth.sessionCookie(req, session) });
  }, { auth: false });
}

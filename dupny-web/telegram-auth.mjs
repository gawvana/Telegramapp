// Telegram Mini App registration and login. Only signed initData is trusted.
import crypto from 'node:crypto';
import { db, sql, tx } from './db.js';
import { route, readJson, sendJson } from './http.js';
import * as auth from './auth.js';
import { HttpError, log } from './util.js';

db.exec(
  'CREATE TABLE IF NOT EXISTS telegram_accounts (' +
  'telegram_id TEXT PRIMARY KEY, ' +
  'user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, ' +
  'referred_by TEXT, created_at INTEGER NOT NULL)'
);
const BOT_USERNAME = 'DupnyApp';

function validateInitData(raw) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new HttpError(503, 'Telegram вход пока не настроен');
  if (typeof raw !== 'string' || raw.length > 8192 || raw.length < 30) {
    throw new HttpError(401, 'Открой приложение из Telegram');
  }
  const pairs = new URLSearchParams(raw);
  const hash = pairs.get('hash');
  if (pairs.getAll('hash').length !== 1 || !/^[a-f\d]{64}$/i.test(hash || '')) {
    throw new HttpError(401, 'Недействительные данные Telegram');
  }
  const check = [...pairs.entries()].filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(check).digest();
  if (!crypto.timingSafeEqual(computed, Buffer.from(hash, 'hex'))) {
    throw new HttpError(401, 'Проверка Telegram не пройдена');
  }
  const seconds = Number(pairs.get('auth_date'));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(seconds) || seconds > now + 60 || now - seconds > 3600) {
    throw new HttpError(401, 'Авторизация Telegram устарела, открой Mini App заново');
  }
  let user;
  try { user = JSON.parse(pairs.get('user') || 'null'); } catch {}
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new HttpError(401, 'Telegram не передал аккаунт пользователя');
  }
  return { user, startParam: pairs.get('start_param') || '' };
}
const nameOf = (u) => [u.first_name, u.last_name].filter(v => typeof v === 'string')
  .join(' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Друг';
function referrerOf(raw, tgId) {
  const m = /^ref_(\d{4,18})$/.exec(String(raw || ''));
  if (!m || m[1] === tgId) return null;
  return sql('SELECT telegram_id FROM telegram_accounts WHERE telegram_id = ?').get(m[1])
    ? m[1] : null;
}
export function registerTelegramRoutes() {
  route('POST', '/api/telegram/auth', async ({ req, res }) => {
    const body = await readJson(req, 12_000);
    const { user, startParam } = validateInitData(body.initData);
    const telegramId = String(user.id);
    const mapping = sql('SELECT user_id FROM telegram_accounts WHERE telegram_id = ?').get(telegramId);
    let created = false;
    let linked = false;
    let userId = mapping?.user_id;
    if (!mapping) {
      const already = auth.currentUser(req);
      // Existing authenticated web accounts may be linked once.
      if (already && !sql('SELECT telegram_id FROM telegram_accounts WHERE user_id = ?').get(already.id)) {
        userId = already.id;
        tx(() => {
          sql('INSERT INTO telegram_accounts (telegram_id,user_id,created_at) VALUES (?,?,?)')
            .run(telegramId, userId, Date.now());
        });
        linked = true;
      } else {
        const name = nameOf(user);
        const secretPass = await auth.hashPassword(crypto.randomBytes(32).toString('base64url'));
        const referredBy = referrerOf(startParam || body.referral, telegramId);
        let login = 'tg_' + telegramId;
        let suffix = 0;
        while (sql('SELECT id FROM users WHERE login_key = ?').get(auth.loginKey(login))) {
          suffix++;
          login = 'tg_' + telegramId + '_' + suffix;
        }
        userId = tx(() => {
          const now = Date.now();
          const r = sql('INSERT INTO users (login,login_key,name,pass,role,created_at) VALUES (?,?,?,?,?,?)')
            .run(login, auth.loginKey(login), name, secretPass, 'friend', now);
          const uid = Number(r.lastInsertRowid);
          sql('INSERT INTO telegram_accounts (telegram_id,user_id,referred_by,created_at) VALUES (?,?,?,?)')
            .run(telegramId, uid, referredBy, now);
          return uid;
        });
        created = true;
        log('Регистрация Dupny через Telegram: пользователь #' + userId);
      }
    }
    const found = sql('SELECT * FROM users WHERE id = ?').get(userId);
    if (!found) throw new HttpError(404, 'Аккаунт не найден');
    const session = auth.createSession(found.id, req.headers['user-agent']);
    sendJson(res, 200, {
      ok: true, created, linked,
      user: auth.publicUser(found),
      inviteUrl: 'https://t.me/' + BOT_USERNAME + '?start=ref_' + telegramId,
    }, { 'set-cookie': auth.sessionCookie(req, session) });
  }, { auth: false });
}

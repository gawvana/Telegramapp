// Builds Dupny from a pinned upstream Lozha source; retains existing /data volume.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { applyPrivacyPatches } from './privacy-patch.mjs';
import { applyPrivateRooms } from './private-rooms.mjs';
const src = path.resolve('site');
const commit = '6be4a3e21d4e64dd35dd5ac68f257d43e72be4d5';
const url = 'https://codeload.github.com/jas2k/lozha/tar.gz/' + commit;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dupny-build-'));
try {
  console.log('[Dupny] Loading pinned upstream source...');
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Cannot fetch upstream source: HTTP ' + response.status);
  const archive = path.join(temp, 'source.tar.gz');
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  fs.mkdirSync(src, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', src, '--strip-components=1'], { stdio: 'inherit' });
  function patch(file, from, to) {
    const old = fs.readFileSync(file, 'utf8');
    if (!old.includes(from)) throw new Error('Upstream layout changed: ' + file + ' missing ' + from.slice(0, 80));
    fs.writeFileSync(file, old.replace(from, to));
  }
  // Keep brand consistent without touching upstream repository.
  function brand(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) brand(full);
      else if (/\.(?:js|mjs|html)$/.test(item.name)) {
        const code = fs.readFileSync(full, 'utf8');
        fs.writeFileSync(full, code.replaceAll('Ложа', 'Dupny').replaceAll('Ложе', 'Dupny'));
      }
    }
  }
  brand(path.join(src, 'public'));
  brand(path.join(src, 'server'));
  fs.copyFileSync('telegram-auth.mjs', path.join(src, 'server', 'telegram-auth.js'));
  fs.copyFileSync('r2-storage.mjs', path.join(src, 'server', 'r2-storage.js'));
  fs.copyFileSync('telegram-mini.js', path.join(src, 'public', 'js', 'telegram-mini.js'));
  fs.copyFileSync('friends-telegram.js', path.join(src, 'public', 'js', 'pages', 'friends.js'));
  fs.copyFileSync('telegram-entry.js', path.join(src, 'public', 'js', 'pages', 'telegram-entry.js'));
  // R2 uses official S3-compatible AWS SDK packages only on the server.
  {
    const packageFile = path.join(src, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    pkg.dependencies ||= {};
    pkg.dependencies['@aws-sdk/client-s3'] = '^3.800.0';
    pkg.dependencies['@aws-sdk/lib-storage'] = '^3.800.0';
    fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n');
  }
  // Expose Telegram profile in every /api/me and room user result.
  {
    const file = path.join(src, 'server', 'auth.js');
    const before = fs.readFileSync(file, 'utf8');
    const expr = /export function publicUser\(u\) \{[\s\S]*?\n\}/;
    if (!expr.test(before)) throw new Error('Cannot patch upstream publicUser');
    const replacement = [
      'export function publicUser(u) {',
      '  if (!u) return null;',
      "  const t = sql('SELECT telegram_id, username, photo_url FROM telegram_accounts WHERE user_id = ?').get(u.id);",
      "  const displayLogin = t ? (t.username ? '@' + t.username : 'Telegram ID ' + t.telegram_id) : u.login;",
      "  const displayAvatar = t?.photo_url || (u.avatar ? '/avatars/' + u.avatar : '');",
      '  return { id: u.id, login: displayLogin, name: u.name, role: u.role, avatar: displayAvatar,',
      '    telegram: t ? { id: t.telegram_id, username: t.username || null } : null };',
      '}',
    ].join('\n');
    fs.writeFileSync(file, before.replace(expr, replacement));
  }
  // Reject old password sessions, even if a legacy cookie is still present.
  patch(path.join(src, 'server', 'auth.js'),
    '  req._user = userByToken(token);\n  return req._user;',
    '  req._user = userByToken(token);\n' +
    "  if (req._user && !sql('SELECT session_id FROM telegram_sessions WHERE session_id = ?').get(req._user.sid)) req._user = null;\n" +
    '  return req._user;');
  // HTTPS Mini Apps are embedded by Telegram Web on another site.
  // The old SameSite=Lax cookie was never sent inside that iframe.
  patch(path.join(src, 'server', 'auth.js'),
    [
      "export function sessionCookie(req, token) {",
      "  const secure = isSecure(req) ? '; Secure' : '';",
      "  if (!token) return \`${cookieName(req)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}\`;",
      "  return \`${cookieName(req)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}${secure}\`;",
      "}",
    ].join('\n'),
    [
      "export function sessionCookie(req, token) {",
      "  const attrs = isSecure(req) ? '; Secure; SameSite=None; Partitioned' : '; SameSite=Lax';",
      "  if (!token) return \`${cookieName(req)}=; Path=/; HttpOnly${attrs}; Max-Age=0\`;",
      "  return \`${cookieName(req)}=${token}; Path=/; HttpOnly${attrs}; Max-Age=${Math.floor(SESSION_TTL / 1000)}\`;",
      "}",
    ].join('\n'));
  patch(path.join(src, 'server', 'routes.js'),
    "import fs from 'node:fs';",
    "import { streamR2 } from './r2-storage.js';\nimport { registerTelegramRoutes } from './telegram-auth.js';\nimport fs from 'node:fs';");
  patch(path.join(src, 'server', 'routes.js'),
    '    const file = path.join(DIRS.media, params.id, params.file);',
    "    const file = path.join(DIRS.media, params.id, params.file);\n    if (!fs.existsSync(file) && await streamR2(req, res, params.id, params.file, cache)) return;");
  patch(path.join(src, 'server', 'routes.js'),
    'export function registerRoutes() {',
    'export function registerRoutes() {\n  registerTelegramRoutes();');
  // Telegram Web's iframe must be allowed, while other origins remain blocked.
  patch(path.join(src, 'server', 'http.js'),
    "  res.setHeader('X-Frame-Options', 'DENY');",
    '  // X-Frame-Options omitted: Telegram Web Mini App embeds this page.');
  patch(path.join(src, 'server', 'http.js'),
    `"frame-ancestors 'none'"`,
    `"frame-ancestors https://web.telegram.org https://*.telegram.org https://t.me https://*.t.me"`);
  patch(path.join(src, 'server', 'http.js'),
    "  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');",
    '  // COOP omitted to preserve Telegram Mini App parent messaging.');
  patch(path.join(src, 'server', 'http.js'),
    '"script-src \'self\'"',
    '"script-src \'self\' https://telegram.org"');
  patch(path.join(src, 'public', 'index.html'),
    '<script type="module" src="/js/app.js"></script>',
    '<script src="https://telegram.org/js/telegram-web-app.js"></script>\n  <script type="module" src="/js/app.js"></script>');
  patch(path.join(src, 'public', 'js', 'app.js'),
    "import { loginPage, invitePage } from './pages/auth.js';",
    "import { loginPage, invitePage } from './pages/telegram-entry.js';");
  patch(path.join(src, 'public', 'js', 'app.js'),
    "import { h, $, sleep, reduced } from './util.js';",
    "import { bootTelegram } from './telegram-mini.js';\nimport { h, $, sleep, reduced } from './util.js';");
  patch(path.join(src, 'public', 'js', 'app.js'),
    '(async function boot() {\n  try { await loadMe(); }',
    "(async function boot() {\n  if (!await bootTelegram()) { app.classList.remove('booting'); return; }\n  try { await loadMe(); }");
  // If a cookie is unavailable, never show the legacy login page.
  patch(path.join(src, 'public', 'js', 'app.js'),
    "  if (!store.me && !route.pub) {",
    "  if (window.Telegram?.WebApp && !store.me) {\n" +
    "    window.__dupnyShowLoginProblem?.();\n" +
    "    return;\n" +
    "  }\n" +
    "  if (!store.me && !route.pub) {");
  // Also block the fallback redirect when the user is already inside Telegram.
  patch(path.join(src, 'public', 'js', 'app.js'),
    "  if (store.me) await startSession();\n  app.classList.remove('booting');",
    "  if (store.me) await startSession();\n" +
    "  else if (window.Telegram?.WebApp) { window.__dupnyShowLoginProblem?.(); return; }\n" +
    "  app.classList.remove('booting');");
  // Telegram account login does not use a user-entered password.
  patch(path.join(src, 'public', 'js', 'app.js'),
    "if (store.warnPass && route.nav && route.nav !== 'settings')",
    "if (store.warnPass && !window.__dupnyMiniApp?.connected && route.nav && route.nav !== 'settings')");
  // No password, logout or profile-edit forms inside Telegram.
  patch(path.join(src, 'public', 'js', 'pages', 'settings.js'),
    '  return () => { for (const off of offs) off(); offs = []; };',
    [
      '  if (window.__dupnyMiniApp?.connected) {',
      "    for (const group of root.querySelectorAll('.group')) {",
      "      const title = group.querySelector('.eyebrow')?.textContent?.trim();",
      "      if (title === 'Пароль' || title === 'Выход') group.remove();",
      "      if (title === 'Профиль') {",
      "        for (const elem of group.querySelectorAll('label.field, button')) elem.remove();",
      "      }",
      "    }",
      "  }",
      '  return () => { for (const off of offs) off(); offs = []; };',
    ].join('\n'));
  patch(path.join(src, 'public', 'js', 'app.js'),
    'function endSession() {',
    "function endSession() {\n  if (window.__dupnyMiniApp?.connected) { location.reload(); return; }");
  patch(path.join(src, 'server', 'library.js'),
    "import path from 'node:path';",
    "import { removeR2Media } from './r2-storage.js';\nimport path from 'node:path';");
  patch(path.join(src, 'server', 'library.js'),
    '  await rmrf(mediaDir(id));',
    '  await removeR2Media(id);\n  await rmrf(mediaDir(id));');

  patch(path.join(src, 'server', 'queue.js'),
    "import fs from 'node:fs';",
    "import { archiveMediaOnce, migrateExistingMedia, verifyR2 } from './r2-storage.js';\nimport fs from 'node:fs';");
  patch(path.join(src, 'server', 'queue.js'),
    "      log(\`[\${id}] трек «\${getMedia(id)?.title}» готов\`);",
    "      log(\`[\${id}] трек «\${getMedia(id)?.title}» готов\`);");
  // Archive after ingestVideo/audio. Failures are logged without corrupting ready media.
  patch(path.join(src, 'server', 'queue.js'),
    '    }\n  } catch (e) {\n    if (!getMedia(id) || e.code === \'cancelled\') return;',
    "    }\n    await archiveMediaOnce(id);\n  } catch (e) {\n    if (!getMedia(id) || e.code === 'cancelled') return;");
  patch(path.join(src, 'server', 'queue.js'),
    "    log(\`[\${m.id}] версия \${v.label} готова (\${origin === 'site' ? 'взята с сайта' : 'пересжата'})\`);",
    "    await archiveMediaOnce(m.id);\n    log(\`[\${m.id}] версия \${v.label} готова (\${origin === 'site' ? 'взята с сайта' : 'пересжата'})\`);");
  patch(path.join(src, 'server', 'queue.js'),
    'export async function recover() {',
    'export async function recover() {\n  await verifyR2();\n  migrateExistingMedia();');

  patch(path.join(src, 'server', 'uploads.js'),
    "import fs from 'node:fs';",
    "import { r2Enabled } from './r2-storage.js';\nimport fs from 'node:fs';");
  patch(path.join(src, 'server', 'uploads.js'),
    'if (free < size * 2.1 + 200e6)',
    'if (free < size * (r2Enabled ? 2.5 : 2.1) + (r2Enabled ? 60e6 : 200e6))');
  // Telegram profiles own their data. Never create a legacy password owner.
  patch(path.join(src, 'server', 'index.js'),
    '  await ensureOwner();',
    '  // First verified Telegram owner is created on first Mini App login.');
  applyPrivacyPatches(src);
  applyPrivateRooms(src);
  console.log('[Dupny] Private libraries, media access and individual playback rooms installed.');
  console.log('[Dupny] Installing application dependencies...');
  execFileSync('npm', ['install', '--omit=dev', '--prefix', src], { stdio: 'inherit', env: process.env });
  // Fail the release before deployment if generated JavaScript is invalid.
  for (const file of [
    'server/index.js', 'server/http.js', 'server/auth.js', 'server/routes.js',
    'server/telegram-auth.js', 'server/r2-storage.js', 'server/queue.js',
    'public/js/app.js', 'public/js/telegram-mini.js', 'public/js/pages/settings.js',
    'server/rooms.js', 'server/library.js', 'public/js/pages/library.js', 'public/js/pages/music.js'
  ]) {
    execFileSync(process.execPath, ['--check', path.join(src, file)], { stdio: 'pipe' });
  }
  console.log('[Dupny] Syntax checks passed.');
  // Test real route behavior with a separate SQLite database and a fake Telegram token.
  fs.mkdirSync(path.join(src, 'tests'), { recursive: true });
  fs.copyFileSync('test-telegram.mjs', path.join(src, 'tests', 'test-telegram.mjs'));
  execFileSync(process.execPath, [
    '--experimental-sqlite', '--disable-warning=ExperimentalWarning',
    path.join(src, 'tests', 'test-telegram.mjs')
  ], { stdio: 'inherit', timeout: 45000 });

  console.log('[Dupny] Build complete.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

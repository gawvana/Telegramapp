// Builds Dupny from a pinned upstream Lozha source; retains existing /data volume.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
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
  fs.copyFileSync('telegram-mini.js', path.join(src, 'public', 'js', 'telegram-mini.js'));
  patch(path.join(src, 'server', 'routes.js'),
    "import fs from 'node:fs';",
    "import { registerTelegramRoutes } from './telegram-auth.js';\nimport fs from 'node:fs';");
  patch(path.join(src, 'server', 'routes.js'),
    'export function registerRoutes() {',
    'export function registerRoutes() {\n  registerTelegramRoutes();');
  patch(path.join(src, 'server', 'http.js'),
    '"script-src \'self\'"',
    '"script-src \'self\' https://telegram.org"');
  patch(path.join(src, 'public', 'index.html'),
    '<script type="module" src="/js/app.js"></script>',
    '<script src="https://telegram.org/js/telegram-web-app.js"></script>\n  <script type="module" src="/js/app.js"></script>');
  patch(path.join(src, 'public', 'js', 'app.js'),
    "import { h, $, sleep, reduced } from './util.js';",
    "import { bootTelegram } from './telegram-mini.js';\nimport { h, $, sleep, reduced } from './util.js';");
  patch(path.join(src, 'public', 'js', 'app.js'),
    '(async function boot() {\n  try { await loadMe(); }',
    '(async function boot() {\n  await bootTelegram();\n  try { await loadMe(); }');
  console.log('[Dupny] Installing application dependencies...');
  execFileSync('npm', ['install', '--omit=dev', '--prefix', src], { stdio: 'inherit', env: process.env });
  console.log('[Dupny] Build complete.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

// Dupny account isolation patches applied to the pinned upstream source.
import fs from 'node:fs';
import path from 'node:path';

export function applyPrivacyPatches(root) {
  function edit(name, fn) {
    const file = path.join(root, name);
    const before = fs.readFileSync(file, 'utf8');
    const after = fn(before);
    if (before === after) throw Error('Unchanged privacy file: ' + name);
    fs.writeFileSync(file, after);
  }
  function rep(s, from, to, label) {
    const matches = s.split(from).length - 1;
    if (matches !== 1) throw Error('Patch ' + label + ': matches=' + matches);
    return s.replace(from, to);
  }
  function reg(s, match, to, label) {
    if (!match.test(s)) throw Error('Patch not found: ' + label);
    return s.replace(match, to);
  }
  edit('server/library.js', s => {
    s = rep(s, "export function listMedia() {\n  return sql('SELECT * FROM media ORDER BY created_at DESC').all().map(publicMedia);\n}",
      "export function listMedia(userId) {\n  return sql('SELECT * FROM media WHERE added_by = ? ORDER BY created_at DESC').all(userId).map(publicMedia);\n}", 'private library');
    s = rep(s, "  if (m) hub.broadcast({ t: 'media', media: publicMedia(m) });",
      "  if (m && m.added_by != null) hub.broadcast({ t: 'media', media: publicMedia(m) }, (c) => c.user.id === m.added_by);", 'private media updates');
    s = rep(s, "export async function removeMedia(id) {\n  sql('DELETE FROM media WHERE id = ?').run(id);",
      "export async function removeMedia(id) {\n  const existing = getMedia(id);\n  sql('DELETE FROM media WHERE id = ?').run(id);", 'record deleted media owner');
    s = rep(s, "  hub.broadcast({ t: 'media:gone', id });",
      "  if (existing?.added_by != null) hub.broadcast({ t: 'media:gone', id }, (c) => c.user.id === existing.added_by);", 'private delete events');
    return s;
  });

  edit('server/routes.js', s => {
    s = rep(s, "const canAdd = (u, kind) => (kind === 'audio' ? canAddMusic(u) : isOwner(u));",
      "const canAdd = (_u, _kind) => true;", 'every user uploads');
    s = rep(s, "const canEdit = (u, m) => isOwner(u) || (m.kind === 'audio' && m.added_by === u.id);",
      "const canEdit = (u, m) => m.added_by === u.id;", 'only media owner edits');
    s = rep(s, "can: user ? { films: isOwner(user), music: canAddMusic(user) } : null,",
      "can: user ? { films: true, music: true } : null,", 'own videos permission');
    s = rep(s, "route('GET', '/api/media', async ({ res }) => sendJson(res, 200, { media: listMedia() }));",
      "route('GET', '/api/media', async ({ res, user }) => sendJson(res, 200, { media: listMedia(user.id) }));", 'scoped media list');
    s = rep(s, "route('GET', '/api/rooms', async ({ res }) => sendJson(res, 200, { list: roomsSummary() }));",
      "route('GET', '/api/rooms', async ({ res, user }) => sendJson(res, 200, { list: roomsSummary(user.id) }));", 'scoped rooms list');
    s = rep(s, "    sendJson(res, 200, r);\n  }, { auth: 'owner' });",
      "    sendJson(res, 200, r);\n  });", 'allow private rooms');
    s = rep(s, "route('GET', '/api/rooms/for/:mediaId', async ({ res, params }) => sendJson(res, 200, { room: roomFor(params.mediaId) }));",
      "route('GET', '/api/rooms/for/:mediaId', async ({ res, params, user }) => sendJson(res, 200, { room: roomFor(params.mediaId, user.id) }));", 'room owner check');
    s = rep(s, "route('GET', '/media/:id/:file', async ({ req, res, params }) => {",
      "route('GET', '/media/:id/:file', async ({ req, res, params, user }) => {\n    const owned = getMedia(params.id);\n    if (!owned || owned.added_by !== user.id) throw new HttpError(404, 'Файл не найден');", 'deny foreign media by direct URL');
    return s;
  });

  edit('public/js/pages/library.js', s => {
    s = rep(s, "if (store.me.role === 'owner') {", "if (store.me) {", 'start own private room');
    s = s.replaceAll("const owner = store.me.role === 'owner';", "const owner = !!store.me;");
    s = rep(s, "  const disk = owner ? h('div.disk', { hidden: true }) : null;",
      "  const disk = null;", 'remove disk card');
    s = rep(s, "    strip, disk, tray, grid, emptyBox,", "    strip, tray, grid, emptyBox,", 'remove disk slot');
    s = reg(s, /  const refreshDisk = debounce\(async \(\) => \{[\s\S]*?\n  \}, 600\);/,
      "  const refreshDisk = () => {};", 'remove disk polling');
    return s;
  });

  edit('public/js/pages/settings.js', s => {
    s = reg(s, /        h\('div\.card',\n          h\('div\.kv', h\('span', 'Диск'\)[\s\S]*?\n          h\('div\.meter', h\('i',[\s\S]*?\n/,
      "", 'remove 422MB card from settings');
    return s;
  });

  edit('public/js/pages/music.js', s =>
    rep(s, "const canEdit = (t) => store.me.role === 'owner' || t.addedBy === store.me.id;",
      "const canEdit = (t) => t.addedBy === store.me.id;", 'own music edits'));
}

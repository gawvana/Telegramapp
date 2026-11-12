// One user's films and music never appear in another user's rooms/queues.
import fs from 'node:fs';
import path from 'node:path';

export function applyPrivateRooms(root) {
  const filename = path.join(root, 'server/rooms.js');
  let s = fs.readFileSync(filename, 'utf8');
  function p(a, b, label) {
    const n = s.split(a).length - 1;
    if (n !== 1) throw Error('Private rooms patch ' + label + ': ' + n + ' matches');
    s = s.replace(a,b);
  }
  function rx(a,b,label) {
    if (!a.test(s)) throw Error('Private rooms patch missing: ' + label);
    s = s.replace(a,b);
  }
  p("let music = null;",
    [
      "const musicRooms = new Map();",
      "let savedMusic = {};",
      "function musicFor(userId) {",
      "  let r = musicRooms.get(userId);",
      "  if (r) return r;",
      "  r = new Room('music', 'music');",
      "  r.ownerId = userId;",
      "  const s = savedMusic[String(userId)];",
      "  if (s?.queue) {",
      "    r.queue = s.queue.filter(x => x && getMedia(x.trackId)?.added_by === userId && getMedia(x.trackId)?.status === 'ready');",
      "    const cur = r.queue.find(x => x.qid === s.current) || r.queue[0];",
      "    if (cur) {",
      "      r.current = cur.qid;",
      "      r.mediaId = cur.trackId;",
      "      r.position = cur.qid === s.current ? clamp(Number(s.position) || 0, 0, getMedia(cur.trackId)?.duration || 0) : 0;",
      "    }",
      "  }",
      "  musicRooms.set(userId, r);",
      "  rooms.set('music:' + userId, r);",
      "  return r;",
      "}"
    ].join('\n'), 'create per-user music queues');
  p("  summaryTimer = setTimeout(() => { summaryTimer = null; hub.broadcast({ t: 'rooms', list: roomsSummary() }); }, 150);",
    "  summaryTimer = setTimeout(() => {\n    summaryTimer = null;\n    for (const conn of hub.conns.values()) conn.send({ t: 'rooms', list: roomsSummary(conn.user.id) });\n  }, 150);",
    'private room broadcast');
  p("    setSetting('music', { queue: music.queue, current: music.current, position: music.pos() });",
    "    setSetting('musicByUser', Object.fromEntries([...musicRooms.entries()].map(([id, r]) => [String(id), { queue: r.queue, current: r.current, position: r.pos() }])));",
    'per-user music save');
  p("t: 'room:state', room: this.id, kind: this.kind",
    "t: 'room:state', room: this.kind === 'music' ? 'music' : this.id, kind: this.kind",
    'music state client compatibility');
  p("    if (this.kind === 'music') hub.broadcast(msg); else this.send(msg);",
    "    if (this.kind === 'music') hub.broadcast(msg, (c) => c.user.id === this.ownerId); else this.send(msg);",
    'private music state stream');
  p("    if (!m || m.kind !== 'video' || m.status !== 'ready') return conn.send({ t: 'toast', text: 'Этот фильм ещё не готов' });",
    "    if (!m || m.added_by !== this.ownerId || m.kind !== 'video' || m.status !== 'ready') return conn.send({ t: 'toast', text: 'Этот фильм ещё не готов' });",
    'private room media selection');
  p("    if (!t || t.kind !== 'audio' || t.status !== 'ready') return;",
    "    if (!t || t.added_by !== this.ownerId || t.kind !== 'audio' || t.status !== 'ready') return;",
    'private music add');
  p("export function roomsSummary() {\n  const list = [];",
    "export function roomsSummary(userId) {\n  const list = [];",
    'filtered room summary');
  p("  for (const r of rooms.values()) {\n    if (!r.members.size || !r.mediaId) continue;",
    "  for (const r of rooms.values()) {\n    if (r.ownerId !== userId || !r.members.size || !r.mediaId) continue;",
    'only account rooms visible');
  p("  if (!m || m.kind !== 'video') return { error: 'Фильм не найден' };",
    "  if (!m || m.added_by !== user.id || m.kind !== 'video') return { error: 'Фильм не найден' };",
    'only own video can start room');
  p("  const room = new Room(rid(6), 'film', mediaId);\n  rooms.set(room.id, room);",
    "  const room = new Room(rid(6), 'film', mediaId);\n  room.ownerId = user.id;\n  rooms.set(room.id, room);",
    'film owner id');
  rx(/  \/\/ Друзья, которые сейчас на сайте, узнают, что владелец начал смотреть\.\n  hub\.broadcast\(\{[\s\S]*?\n  \}, \(c\) => c\.user\.id !== user\.id\);/,
    '  // No public watch notification: film titles remain private to their uploader.',
    'suppress foreign video announcements');
  p("export function roomFor(mediaId) {\n  for (const r of rooms.values()) if (r.kind === 'film' && r.mediaId === mediaId) return r.id;",
    "export function roomFor(mediaId, userId) {\n  for (const r of rooms.values()) if (r.kind === 'film' && r.ownerId === userId && r.mediaId === mediaId) return r.id;",
    'only own active room');
  rx(/  if \(music\.queue\.some\(\(x\) => x\.trackId === id\)\) \{[\s\S]*?\n  \}\n\}/,
    [
      "  for (const music of musicRooms.values()) {",
      "    if (!music.queue.some(x => x.trackId === id)) continue;",
      "    const cur = music.queue.find(x => x.qid === music.current);",
      "    const wasCurrent = cur?.trackId === id;",
      "    const idx = music.qIndex(music.current);",
      "    const after = music.queue.slice(idx + 1).find(x => x.trackId !== id);",
      "    music.queue = music.queue.filter(x => x.trackId !== id);",
      "    if (wasCurrent) music.setCurrent(after?.qid ?? music.queue[0]?.qid ?? null, { play: music.playing && !!after });",
      "    else { music.seq++; music.push(); }",
      "  }",
      "}"
    ].join('\n'), 'remove own tracks from own queue');
  p("  music = new Room('music', 'music');\n  rooms.set('music', music);",
    "  savedMusic = getSetting('musicByUser', {}) || {};", 'restore per account music');
  rx(/  const ms = getSetting\('music', null\);\n  if \(ms\?\.queue\) \{[\s\S]*?\n  \}\n\n  const room = \(c, m\) => \(m\.room === 'music' \? music : rooms\.get\(m\.room\)\);/,
    "  const room = (c, m) => (m.room === 'music' ? musicFor(c.user.id) : rooms.get(m.room));",
    'remove global playlist');
  p("    const r = new Room(s.id, 'film', s.mediaId);\n    r.position",
    "    const r = new Room(s.id, 'film', s.mediaId);\n    r.ownerId = m.added_by;\n    r.position",
    'restore own room');
  p("    if (!r) return c.send({ t: 'room:gone', room: m.room });\n    r.join(c);",
    "    if (!r || r.ownerId !== c.user.id) return c.send({ t: 'room:gone', room: m.room });\n    r.join(c);",
    'deny private room joining');
  p("    if (c.user.role !== 'owner') return c.send({ t: 'toast', text: 'Менять фильм может только владелец' });",
    "    if (c.room?.ownerId !== c.user.id) return;",
    'own room change');
  p("    if (c.user.role !== 'owner') return c.send({ t: 'toast', text: 'Закрыть комнату может только владелец' });",
    "    if (c.room?.ownerId !== c.user.id) return;",
    'own room close');
  p("  hub.on('music:add', (c, m) => music.add(c, m.trackId, ['end', 'next', 'now'].includes(m.mode) ? m.mode : 'end'));",
    "  hub.on('music:add', (c, m) => musicFor(c.user.id).add(c, m.trackId, ['end', 'next', 'now'].includes(m.mode) ? m.mode : 'end'));",
    'music add handler');
  for (const [before, after] of [
    ["hub.on('music:remove', (c, m) => music.remove(m.qid));", "hub.on('music:remove', (c, m) => musicFor(c.user.id).remove(m.qid));"],
    ["hub.on('music:move', (c, m) => music.move(m.qid, m.to));", "hub.on('music:move', (c, m) => musicFor(c.user.id).move(m.qid, m.to));"],
    ["hub.on('music:jump', (c, m) => { if (music.qIndex(m.qid) >= 0) music.setCurrent(m.qid, { play: true }); });",
     "hub.on('music:jump', (c, m) => { const music = musicFor(c.user.id); if (music.qIndex(m.qid) >= 0) music.setCurrent(m.qid, { play: true }); });"],
    ["hub.on('music:next', () => music.advance(1));", "hub.on('music:next', (c) => musicFor(c.user.id).advance(1));"],
    ["hub.on('music:prev', () => music.advance(-1));", "hub.on('music:prev', (c) => musicFor(c.user.id).advance(-1));"],
    ["hub.on('music:clear', () => { music.queue = []; music.setCurrent(null); });",
     "hub.on('music:clear', (c) => { const music = musicFor(c.user.id); music.queue = []; music.setCurrent(null); });"],
    ["    c.send({ t: 'rooms', list: roomsSummary() });\n    c.send(music.state());",
     "    c.send({ t: 'rooms', list: roomsSummary(c.user.id) });\n    c.send(musicFor(c.user.id).state());"],
    ["  if (music) save();", "  save();"],
  ]) p(before, after, 'personal music handler');
  fs.writeFileSync(filename, s);
}

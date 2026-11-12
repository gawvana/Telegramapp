// Dupny R2 media archive. R2 bucket stays private; only authenticated /media routes expose objects.
import fs from 'node:fs';
import path from 'node:path';
import { S3Client, GetObjectCommand, HeadObjectCommand, HeadBucketCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { db, sql } from './db.js';
import { DIRS } from './config.js';
import { log } from './util.js';

const bucket = process.env.R2_BUCKET || '';
export const r2Enabled = Boolean(bucket && process.env.R2_ENDPOINT &&
  process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
const client = r2Enabled ? new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  },
  forcePathStyle: true,
  maxAttempts: 3
}) : null;
db.exec("CREATE TABLE IF NOT EXISTS r2_objects (" +
  "media_id TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, " +
  "uploaded_at INTEGER NOT NULL, PRIMARY KEY(media_id, filename))");

const legalId = s => /^[A-Za-z0-9_-]{6,24}$/.test(s);
const legalName = s => /^[a-z0-9_]{1,24}\.(mp4|m4a|mp3|flac|vtt|jpg)$/.test(s);
const keyFor = (id, file) => id + '/' + file;
const filePath = (id, file) => path.join(DIRS.media, id, file);
const mime = file => ({
  mp4: 'video/mp4', m4a: 'audio/mp4', mp3: 'audio/mpeg',
  flac: 'audio/flac', vtt: 'text/vtt; charset=utf-8', jpg: 'image/jpeg'
})[file.split('.').pop()] || 'application/octet-stream';

export async function verifyR2() {
  if (!r2Enabled) { log('[R2] Хранилище не настроено, используются локальные файлы'); return false; }
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    log('[R2] Соединение с приватным bucket успешно');
    return true;
  } catch (error) {
    log('[R2] Не удалось проверить доступ к bucket: ' + (error.name || 'ошибка подключения'));
    return false;
  }
}

function record(id, file) {
  return sql('SELECT size FROM r2_objects WHERE media_id = ? AND filename = ?').get(id, file);
}
async function confirmed(id, file, size) {
  try {
    const meta = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: keyFor(id, file) }));
    return Number(meta.ContentLength) === Number(size);
  } catch { return false; }
}

export async function archiveFile(id, file, { retainLocal = false } = {}) {
  if (!r2Enabled || !legalId(id) || !legalName(file)) return false;
  const local = filePath(id, file);
  let st;
  try { st = await fs.promises.stat(local); } catch { return false; }
  if (!st.isFile()) return false;
  const prior = record(id, file);
  if (!prior || Number(prior.size) !== st.size || !await confirmed(id, file, st.size)) {
    const upload = new Upload({
      client,
      params: { Bucket: bucket, Key: keyFor(id, file),
        Body: fs.createReadStream(local), ContentLength: st.size, ContentType: mime(file) },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false
    });
    await upload.done();
    if (!await confirmed(id, file, st.size)) throw new Error('Размер файла в R2 не совпал');
    sql('INSERT INTO r2_objects (media_id, filename, size, uploaded_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(media_id, filename) DO UPDATE SET size = excluded.size, uploaded_at = excluded.uploaded_at')
      .run(id, file, st.size, Date.now());
    log('[R2] Сохранено: ' + id + '/' + file + ' (' + Math.round(st.size / 1024) + ' КиБ)');
  }
  if (!retainLocal) await fs.promises.rm(local, { force: true });
  return true;
}

export async function archiveMedia(id) {
  if (!r2Enabled || !legalId(id)) return;
  const m = sql('SELECT * FROM media WHERE id = ?').get(id);
  if (!m || m.status !== 'ready') return;
  const queued = sql("SELECT COUNT(*) AS n FROM variants WHERE media_id = ? AND status IN ('queued','processing')").get(id).n;
  const files = new Map();
  if (m.poster) files.set('poster.jpg', false);
  if (m.kind === 'audio' && m.file) files.set(m.file, false);
  for (const s of sql('SELECT file FROM subtitles WHERE media_id = ?').all(id)) files.set(s.file, false);
  if (m.kind === 'video') {
    for (const v of sql("SELECT file FROM variants WHERE media_id = ? AND status = 'ready'").all(id)) {
      files.set(v.file, v.file === 'source.mp4' && queued > 0);
    }
  }
  for (const [file, retainLocal] of files) {
    try { await archiveFile(id, file, { retainLocal }); }
    catch (error) { log('[R2] Не удалось сохранить ' + id + '/' + file + ': ' + (error.name || 'ошибка')); }
  }
}

const inProgress = new Set();
export async function archiveMediaOnce(id) {
  if (inProgress.has(id)) return;
  inProgress.add(id);
  try { await archiveMedia(id); } finally { inProgress.delete(id); }
}

export function migrateExistingMedia() {
  if (!r2Enabled) return;
  setTimeout(async () => {
    const ids = sql("SELECT id FROM media WHERE status = 'ready'").all().map(m => m.id);
    for (const id of ids) await archiveMediaOnce(id).catch(err =>
      log('[R2] Ошибка фоновой миграции: ' + (err.name || 'неизвестная')));
    log('[R2] Проверка переноса существующих медиа завершена, объектов: ' + ids.length);
  }, 4000).unref();
}

export async function streamR2(req, res, id, file, cache = 'private, max-age=3600') {
  if (!r2Enabled || !record(id, file)) return false;
  const range = String(req.headers.range || '');
  const known = record(id, file);
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
    res.writeHead(416, { 'content-range': 'bytes */' + known.size, 'accept-ranges': 'bytes' });
    res.end();
    return true;
  }
  let response;
  try {
    response = await client.send(new GetObjectCommand({
      Bucket: bucket, Key: keyFor(id, file), ...(range ? { Range: range } : {})
    }));
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 416) {
      res.writeHead(416, { 'content-range': 'bytes */' + known.size, 'accept-ranges': 'bytes' });
      res.end();
      return true;
    }
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
  const h = {
    'content-type': response.ContentType || mime(file),
    'cache-control': cache,
    'accept-ranges': 'bytes',
    'content-length': Number(response.ContentLength),
  };
  if (response.ContentRange) h['content-range'] = response.ContentRange;
  if (response.ETag) h.etag = response.ETag;
  res.writeHead(response.ContentRange ? 206 : 200, h);
  if (req.method === 'HEAD') { response.Body?.destroy?.(); res.end(); return true; }
  response.Body.on('error', () => res.destroy());
  res.on('close', () => response.Body.destroy());
  response.Body.pipe(res);
  return true;
}

export async function removeR2Media(id) {
  if (!r2Enabled || !legalId(id)) return;
  for (const row of sql('SELECT filename FROM r2_objects WHERE media_id = ?').all(id)) {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyFor(id, row.filename) }));
      sql('DELETE FROM r2_objects WHERE media_id = ? AND filename = ?').run(id, row.filename);
    } catch (error) {
      log('[R2] Ошибка удаления объекта ' + id + ': ' + (error.name || 'неизвестная'));
    }
  }
}

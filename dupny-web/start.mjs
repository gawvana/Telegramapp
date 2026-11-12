// One-time, explicitly requested clean test reset.
// Runs BEFORE importing Dupny's database and never repeats the same nonce.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const DATA = path.resolve(process.env.LOZHA_DATA || path.resolve('site/data'));
const nonce = String(process.env.DUPNY_RESET_NONCE || '').trim();
async function resetOnce() {
  if (!nonce) return;
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(nonce)) throw Error('Invalid DUPNY_RESET_NONCE');
  const marker = path.join(DATA, '.dupny-reset-' + crypto.createHash('sha256').update(nonce).digest('hex').slice(0,24));
  fs.mkdirSync(DATA, { recursive: true });
  if (fs.existsSync(marker)) {
    console.log('[Dupny reset] Already completed for this reset ID.');
    return;
  }
  if (process.env.R2_BUCKET !== 'dupny-media') throw Error('Refusing reset: unexpected R2 bucket');
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw Error('Refusing reset: R2 credentials are missing');
  }
  const require = createRequire(path.resolve('site/package.json'));
  const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: 'auto', endpoint: process.env.R2_ENDPOINT, forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
  let removed = 0;
  try {
    for (let page = 0; page < 1000; page++) {
      const listing = await client.send(new ListObjectsV2Command({
        Bucket: 'dupny-media', MaxKeys: 500
      }));
      const objects = (listing.Contents || []).map(({ Key }) => ({ Key }));
      if (!objects.length) break;
      const result = await client.send(new DeleteObjectsCommand({
        Bucket: 'dupny-media', Delete: { Objects: objects, Quiet: true }
      }));
      if ((result.Errors || []).length) throw Error('Some R2 files were not deleted');
      removed += objects.length;
      if (page === 999) throw Error('R2 object count safety limit reached');
    }
    const left = await client.send(new ListObjectsV2Command({ Bucket: 'dupny-media', MaxKeys: 1 }));
    if ((left.Contents || []).length > 0) throw Error('R2 bucket not yet empty');
    console.log('[Dupny reset] R2 objects deleted: ' + removed);
  } finally {
    client.destroy();
  }

  // The application is not running yet; SQLite WAL files can be safely deleted.
  const entries = fs.readdirSync(DATA);
  for (const entry of entries) {
    if (entry.startsWith('.dupny-reset-')) continue;
    fs.rmSync(path.join(DATA, entry), { recursive: true, force: true, maxRetries: 5 });
  }
  fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), r2ObjectsRemoved: removed }), { mode: 0o600 });
  console.log('[Dupny reset] Users, SQLite database, sessions, local media and uploads cleared.');
}
await resetOnce();
await import('./site/server/index.js');

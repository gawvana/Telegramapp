// Two-account integration test: private libraries and direct file/room access.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupny-private-test-'));
process.env.LOZHA_DATA = dir;
process.env.LOZHA_TRUST_PROXY = '1';
process.env.TELEGRAM_BOT_TOKEN = '100000001:LOCAL_TEST_TOKEN';
process.env.DUPNY_OWNER_TG_ID = '8294117388';
process.env.LOZHA_OWNER = 'unused';
process.env.LOZHA_OWNER_PASSWORD = 'unused_test_password';
const { db, sql } = await import('../server/db.js');
const { handle } = await import('../server/http.js');
const { registerRoutes } = await import('../server/routes.js');
const { initRooms, roomFor } = await import('../server/rooms.js');
const { createMedia, patchMedia, mediaDir } = await import('../server/library.js');
registerRoutes();
initRooms();
const server = http.createServer(handle);
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const base = 'http://127.0.0.1:' + server.address().port;
function signedData(tgId) {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(Date.now()/1000)),
    user: JSON.stringify({id:tgId,first_name:'Test ' + tgId})
  });
  const check = [...p].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('\n');
  const secret = crypto.createHmac('sha256','WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  p.set('hash',crypto.createHmac('sha256',secret).update(check).digest('hex'));
  return p.toString();
}
async function account(tgId, referral = '') {
  const res = await fetch(base+'/api/telegram/auth',{
    method:'POST',headers:{'content-type':'application/json','x-forwarded-proto':'https'},
    body:JSON.stringify({initData:signedData(tgId), referral})
  });
  const obj=await res.json();
  assert.equal(res.status,200,JSON.stringify(obj));
  return {uid:obj.user.id,cookie:res.headers.get('set-cookie').split(';')[0]};
}
async function request(user,url,options={}) {
  const {headers={},...rest}=options;
  return fetch(base+url,{
    ...rest,
    headers:{...headers,cookie:user.cookie,'x-forwarded-proto':'https'}
  });
}
try{
  const a=await account(8294117388);
  const b=await account(1234567890);
  assert.notEqual(a.uid,b.uid);
  // Existing user accepts a link; a new user accepts a link on first login.
  await account(1234567890,'ref_8294117388');
  const invited=await account(1234567891,'ref_1234567890');
  const stranger=await account(1234567892);
  assert.equal(sql('SELECT referred_by FROM telegram_accounts WHERE user_id = ?').get(b.uid).referred_by,
    '8294117388', 'existing accounts must accept a referral link');
  assert.equal(sql('SELECT referred_by FROM telegram_accounts WHERE user_id = ?').get(invited.uid).referred_by,
    '1234567890', 'new accounts must accept referral links');
  // A second link cannot silently replace an established friend connection.
  await account(1234567891,'ref_8294117388');
  assert.equal(sql('SELECT referred_by FROM telegram_accounts WHERE user_id = ?').get(invited.uid).referred_by,
    '1234567890', 'established referrals cannot be replaced');
  const noRef = await account(1234567892, 'ref_1234567892');
  assert.equal(sql('SELECT referred_by FROM telegram_accounts WHERE user_id = ?').get(noRef.uid).referred_by,
    null, 'users cannot invite themselves');
  const friendsRes=await request(b,'/api/friends');
  assert.equal(friendsRes.status,200,'regular user can open Friends');
  const myFriends=(await friendsRes.json()).friends;
  assert.deepEqual(new Set(myFriends.map(f=>f.id)),new Set([a.uid,invited.uid]),
    'only inviter and invitees visible to regular user');
  assert.ok(!myFriends.some(f=>f.id===stranger.uid),'unrelated accounts must remain hidden');
  assert.deepEqual((await (await request(stranger,'/api/friends')).json()).friends,[],
    'users without invitations have an empty friend list');
  const navSource=fs.readFileSync(path.resolve('site/public/js/app.js'),'utf8');
  assert.match(navSource,/\{ key: 'friends', href: '\/friends', icon: 'users', label: 'Друзья' \}/,
    'Friends must appear in every navbar');
  assert.match(navSource,/mount: friendsPage, nav: 'friends' \}/,
    'Friends page must allow all signed-in users');
  const videoA=createMedia({kind:'video',title:'Private A',status:'ready',origin:'upload',addedBy:a.uid});
  const videoB=createMedia({kind:'video',title:'Private B',status:'ready',origin:'upload',addedBy:b.uid});
  const audioB=createMedia({kind:'audio',title:'Private audio B',status:'ready',origin:'upload',addedBy:b.uid});
  patchMedia(audioB,{file:'audio.m4a'});
  fs.writeFileSync(path.join(mediaDir(videoA),'source.mp4'),'private data a');
  fs.writeFileSync(path.join(mediaDir(videoB),'source.mp4'),'private data b');
  fs.writeFileSync(path.join(mediaDir(audioB),'audio.m4a'),'private audio b');
  const listA=(await (await request(a,'/api/media')).json()).media;
  const listB=(await (await request(b,'/api/media')).json()).media;
  assert.deepEqual(listA.map(x=>x.id),[videoA]);
  assert.deepEqual(new Set(listB.map(x=>x.id)),new Set([videoB,audioB]));
  const fileA=await request(a,'/media/'+videoA+'/source.mp4');
  assert.equal(fileA.status,200,'own media available');
  const fileForeign=await request(b,'/media/'+videoA+'/source.mp4');
  assert.equal(fileForeign.status,404,'foreign media must be invisible by ID');
  const fileForeignOwner=await request(a,'/media/'+audioB+'/audio.m4a');
  assert.equal(fileForeignOwner.status,404,'owner role must not bypass private media');
  const invalidPatch=await request(b,'/api/media/'+videoA,{
    method:'PATCH',headers:{'content-type':'application/json'},
    body:JSON.stringify({title:'Hacked'})
  });
  assert.equal(invalidPatch.status,403,'foreign edits forbidden');
  const deleteForeign=await request(a,'/api/media/'+audioB,{method:'DELETE'});
  assert.equal(deleteForeign.status,403,'owner cannot delete another user media');
  const myRoom=await request(b,'/api/rooms',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({mediaId:videoB})
  });
  assert.equal(myRoom.status,200,'normal user can start own room');
  const foreignRoom=await request(a,'/api/rooms',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({mediaId:videoB})
  });
  assert.equal(foreignRoom.status,400,'foreign rooms unavailable');
  assert.equal(roomFor(videoB,a.uid),null);
  const myRoomId=(await myRoom.json()).id;
  assert.equal(roomFor(videoB,b.uid),myRoomId);
  assert.equal((await (await request(a,'/api/rooms')).json()).list.length,0);
  console.log('[Dupny privacy test] Media, rooms, Friends visibility, old/new referral linking: PASS');
}finally{
  await new Promise(resolve=>server.close(resolve));
  db.close();
  fs.rmSync(dir,{recursive:true,force:true});
}

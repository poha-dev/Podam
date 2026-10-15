/* 종단 검증: 1:1 격리, 이력 복구, 파일 권한, 다중발송, 배역 자료함, 메시지 삭제.
   실행: npm test   (임시 DATA_DIR을 쓰고 끝나면 지운다) */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-e2e-'));
process.env.DATA_DIR = TMP;
process.env.PORT = '0';

/**
 * 시험용 모듈 하나를 폴더에 깔아 둔다 — **모듈 로더가 하는 일을 그대로 보려는 것**이다.
 * 코어에는 모듈이 하나도 없으므로, 모듈 구조를 검사하려면 하나를 만들어 넣어야 한다.
 * (서버를 require 하기 **전에** 깔아야 한다. 모듈은 부팅 때 한 번 읽는다.)
 */
const MODS = path.join(TMP, 'modules');
fs.mkdirSync(path.join(MODS, 'demo'), { recursive: true });
fs.writeFileSync(path.join(MODS, 'demo', 'index.js'), `'use strict';
const express = require('express');
const { db } = require('podam/db');
const { requireGm } = require('podam/guards');
const STATE = require('podam/modules/state');

const router = express.Router();
const guard = [requireGm, (req, res, next) =>
  (STATE.isEnabled(req.room, 'demo') ? next() : res.status(404).json({ error: '사용하지 않는 기능입니다' }))];

router.get('/gm/demo', guard, (req, res) =>
  res.json({ notes: db.prepare('SELECT * FROM demo_notes WHERE room_id = ?').all(req.room.id) }));

module.exports = {
  id: 'demo',
  name: '🧪 시험 모듈',
  description: '검사에서만 쓰는 모듈입니다.',
  api: 1,
  playerUi: true,
  gmTab: { key: 'demo', label: '🧪 시험' },
  events: ['mod:demo:ping'],
  schema: (d) => d.exec('CREATE TABLE IF NOT EXISTS demo_notes (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, body TEXT)'),
  router,
  socket({ socket, on }) {
    on('mod:demo:ping', (_p, ack) => ack?.({ pong: socket.data.role }));
  },
  guide: { gm: '<p>시험용</p>', player: '<p>시험용</p>' },
};
`, 'utf8');
fs.mkdirSync(path.join(MODS, 'demo', 'public'), { recursive: true });
fs.writeFileSync(path.join(MODS, 'demo', 'public', 'demo.gm.js'), '/* 시험용 화면 */\n', 'utf8');
// 앞에 _ 를 붙인 폴더는 「잠깐 꺼 둔 것」이라 실리지 않아야 한다
fs.mkdirSync(path.join(MODS, '_off'), { recursive: true });
fs.writeFileSync(path.join(MODS, '_off', 'index.js'), "module.exports = { id: 'off', name: '꺼둠' };\n", 'utf8');

const { io } = require('socket.io-client');

let BASE = '';
let pass = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  OK  ${label}`); pass++; }
  catch (e) { console.error(`  X   ${label}\n      ${e.message}`); process.exitCode = 1; }
};
const section = (n, title) => console.log(`\n[${n}] ${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, { method = 'GET', headers = {}, body, form } = {}) {
  const opts = { method, headers: { ...headers } };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

/** 소켓을 열고 auth:ok까지 기다린다. 받은 message 이벤트를 모아둔다. */
function connect(auth) {
  return new Promise((resolve, reject) => {
    const sock = io(BASE, { auth, transports: ['websocket'] });
    const received = [];
    const reactions = [];
    const verdicts = [];
    const stage = [];            // 공용 대화 (TRPG)
    const boards = [];           // 무대 상태 (TRPG)
    const rolls = [];            // 주사위 (TRPG)
    const charFeed = [];         // 캐릭터 목록 (TRPG)
    const charMoves = [];        // 무대 위 토큰 자리
    sock.on('message', (m) => received.push(m));
    sock.on('reaction', (r) => reactions.push(r));
    sock.on('verdict:event', (e) => verdicts.push(e));
    sock.on('trpg:msg', (m) => stage.push(m));
    sock.on('trpg:board', (b) => boards.push(b));
    sock.on('trpg:roll', (r) => rolls.push(r));
    sock.on('chars:list', (c) => charFeed.push(c.chars));
    sock.on('chars:move', (m) => charMoves.push(m));
    sock.on('auth:error', (e) => reject(new Error(e.error)));
    sock.on('connect_error', reject);
    sock.on('auth:ok', (data) => resolve({ sock, received, reactions, verdicts, stage, boards, rolls, charFeed, charMoves, hello: data }));
  });
}

const ask = (sock, event, payload) => new Promise((r) => sock.emit(event, payload, r));

(async function main() {
  const { server } = require('../src/server.js');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  BASE = `http://127.0.0.1:${server.address().port}`;

  section(1, '방 개설');
  const created = await api('/api/rooms', {
    method: 'POST',
    body: { name: '테스트 세션', password: 'redmansion', gmPassword: 'gmsecret', gmNickname: '진행자김' },
  });
  check('방이 생성된다', () => assert.strictEqual(created.status, 200));
  const room = created.data.room;
  const linkToken = created.data.linkToken;
  const gmToken = created.data.gmToken;        // 방을 만든 사람의 개인 세션
  const GM = { 'x-gm-token': gmToken };
  check('한글 방 이름이 보존된다', () => assert.strictEqual(room.name, '테스트 세션'));
  check('방 코드가 6자리다', () => assert.strictEqual(room.code.length, 6));
  check('암호 유무가 알려진다', () => assert.strictEqual(room.hasPassword, true));

  const peek = await api(`/api/rooms/by-code/${room.code}`);
  check('암호 원문은 공개되지 않는다', () => assert.strictEqual(peek.data.room.password, undefined));
  check('방을 만든 사람이 첫 GM이 된다', () => assert.strictEqual(created.data.gm.nickname, '진행자김'));
  const gmSees = await api('/api/gm/room', { headers: GM });
  check('GM에게는 암호가 보인다', () => assert.strictEqual(gmSees.data.room.password, 'redmansion'));

  section(2, '플레이어 입장');
  const noPass = await api(`/api/rooms/by-code/${room.code}/join`, { method: 'POST', body: { nickname: '몰래' } });
  check('암호 없이 입장 불가 (401)', () => assert.strictEqual(noPass.status, 401));
  const wrongPass = await api(`/api/rooms/by-code/${room.code}/join`, {
    method: 'POST', body: { nickname: '몰래', password: '틀린암호' },
  });
  check('틀린 암호는 거부 (401)', () => assert.strictEqual(wrongPass.status, 401));

  const P = 'redmansion';
  const joinA = await api(`/api/rooms/by-code/${room.code}/join`, { method: 'POST', body: { nickname: '앨리스', password: P } });
  const joinB = await api(`/api/rooms/by-code/${room.code}/join`, { method: 'POST', body: { nickname: '밥', password: P } });
  check('A 입장 성공', () => assert.strictEqual(joinA.status, 200));
  check('B 입장 성공', () => assert.strictEqual(joinB.status, 200));
  const dup = await api(`/api/rooms/by-code/${room.code}/join`, { method: 'POST', body: { nickname: '앨리스', password: P } });
  check('중복 닉네임은 거부된다', () => assert.strictEqual(dup.status, 409));
  const A = joinA.data, B = joinB.data;

  section(3, '플레이어 목록은 GM만');
  const noAuth = await api('/api/gm/participants');
  check('인증 없이 참가자 목록 조회 불가', () => assert.strictEqual(noAuth.status, 403));
  const asPlayer = await api('/api/gm/participants', { headers: { 'x-player-token': A.token } });
  check('플레이어 토큰으로도 조회 불가', () => assert.strictEqual(asPlayer.status, 403));
  const plist = await api('/api/gm/participants', { headers: GM });
  check('GM은 2명을 본다', () => assert.strictEqual(plist.data.participants.length, 2));

  section(4, '1:1 격리');
  const gm = await connect({ gmToken });
  const a = await connect({ playerToken: A.token });
  const b = await connect({ playerToken: B.token });
  check('A의 초기 이력은 비어 있다', () => assert.strictEqual(a.hello.messages.length, 0));

  a.sock.emit('player:send', { body: 'A의 비밀입니다' });
  await sleep(250);
  await api('/api/gm/send', { method: 'POST', headers: GM, body: { targets: [A.participant.id], body: 'A에게만 답장' } });
  await sleep(250);

  check('A는 자기 메시지 2건을 받는다', () => assert.strictEqual(a.received.length, 2));
  check('B는 아무것도 받지 않는다', () =>
    assert.strictEqual(b.received.length, 0, `B가 받은 것: ${JSON.stringify(b.received)}`));
  check('GM은 2건 모두 받는다', () => assert.strictEqual(gm.received.length, 2));

  section(5, '대상 위조 시도');
  b.sock.emit('player:send', { body: '위조 시도', participantId: A.participant.id });
  await sleep(250);
  check('위조해도 A에게 새 메시지가 가지 않는다', () => assert.strictEqual(a.received.length, 2));
  check('B 자신의 스레드에는 들어간다', () => assert.strictEqual(b.received.length, 1));

  section(6, '파일 — 자료함 업로드와 발송');
  const fd = new FormData();
  fd.append('files', new Blob([Buffer.from('%PDF-1.4 공용')], { type: 'application/pdf' }), '공용_지도.pdf');
  const up = await api('/api/gm/library', { method: 'POST', headers: GM, form: fd });
  check('자료함 업로드 성공', () => assert.strictEqual(up.status, 200));
  const commonFileId = up.data.files[0].id;
  check('한글 파일명이 보존된다', () => assert.strictEqual(up.data.files[0].name, '공용_지도.pdf'));
  check('배역 없이 올리면 공용', () => assert.strictEqual(up.data.files[0].roleId, null));

  await api('/api/gm/send', { method: 'POST', headers: GM, body: { targets: [A.participant.id], fileId: commonFileId } });
  await sleep(250);
  check('A가 파일 메시지를 받는다', () => assert.ok(a.received.at(-1).file));

  const okDl = await fetch(`${BASE}/f/${commonFileId}?t=${encodeURIComponent(A.token)}`);
  check('A는 자기 파일을 받을 수 있다', () => assert.strictEqual(okDl.status, 200));
  const badDl = await fetch(`${BASE}/f/${commonFileId}?t=${encodeURIComponent(B.token)}`);
  check('B는 A의 파일에 접근할 수 없다 (404)', () => assert.strictEqual(badDl.status, 404));
  const anonDl = await fetch(`${BASE}/f/${commonFileId}`);
  check('인증 없이 접근 불가 (404)', () => assert.strictEqual(anonDl.status, 404));
  const gmDl = await fetch(`${BASE}/f/${commonFileId}?gm=${encodeURIComponent(gmToken)}`);
  check('GM은 접근할 수 있다', () => assert.strictEqual(gmDl.status, 200));

  section(7, '첨부 가능한 형식');
  // 브라우저가 zip에 붙이는 MIME은 제각각이라, 확장자로 판정되는지 본다.
  const okTypes = [
    ['증거사진모음.zip', 'application/octet-stream'],
    ['대본.docx', 'application/octet-stream'],
    ['명단.xlsx', 'application/vnd.ms-excel'],
    ['설정.hwp', 'application/octet-stream'],
    ['배경음.mp3', 'audio/mpeg'],
    ['현장영상.mp4', 'video/mp4'],
  ];
  for (const [name, mime] of okTypes) {
    const f = new FormData();
    f.append('files', new Blob([Buffer.from('x')], { type: mime }), name);
    const r = await api('/api/gm/library', { method: 'POST', headers: GM, form: f });
    check(`${name} 업로드 허용`, () => assert.strictEqual(r.status, 200));
  }

  const blocked = ['evil.exe', 'run.bat', 'hack.js', 'page.html', 'icon.svg', 'noext'];
  for (const name of blocked) {
    const f = new FormData();
    f.append('files', new Blob([Buffer.from('x')], { type: 'application/octet-stream' }), name);
    const r = await api('/api/gm/library', { method: 'POST', headers: GM, form: f });
    check(`${name} 차단 (415)`, () => assert.strictEqual(r.status, 415));
  }

  // 브라우저에서 실행될 수 있는 것은 인라인으로 내주지 않는다.
  const zipFile = (await api('/api/gm/library', { headers: GM })).data.files.find((x) => x.name.endsWith('.zip'));
  const zipRes = await fetch(`${BASE}/f/${zipFile.id}?gm=${encodeURIComponent(gmToken)}`);
  check('zip은 첨부(attachment)로 내려온다', () =>
    assert.ok(zipRes.headers.get('content-disposition').startsWith('attachment')));
  check('MIME 스니핑이 막혀 있다', () =>
    assert.strictEqual(zipRes.headers.get('x-content-type-options'), 'nosniff'));

  section(8, '다중 발송');
  const before = { a: a.received.length, b: b.received.length };
  const multi = await api('/api/gm/send', { method: 'POST', headers: GM, body: { all: true, body: '전체 공지입니다' } });
  await sleep(250);
  check('2명에게 발송되었다고 보고한다', () => assert.strictEqual(multi.data.count, 2));
  check('A가 1건 더 받는다', () => assert.strictEqual(a.received.length, before.a + 1));
  check('B가 1건 더 받는다', () => assert.strictEqual(b.received.length, before.b + 1));
  check('공지로 표시된다', () => assert.strictEqual(a.received.at(-1).kind, 'broadcast'));

  section(9, '이력 복구');
  a.sock.disconnect();
  await sleep(200);
  const a2 = await connect({ playerToken: A.token });
  check('재접속 시 전체 이력이 복구된다', () =>
    assert.strictEqual(a2.hello.messages.length, 4, `받은 이력 ${a2.hello.messages.length}건`));
  check('복구된 이력에 파일이 포함된다', () =>
    assert.ok(a2.hello.messages.some((m) => m.file?.name === '공용_지도.pdf')));
  check('복구된 이력에 B의 대화는 없다', () =>
    assert.ok(!a2.hello.messages.some((m) => (m.body || '').includes('위조'))));

  section(10, '배역과 사람별 자료함');
  const madeRoles = await api('/api/gm/roles', { method: 'POST', headers: GM, body: { names: ['집사', '의사'] } });
  check('배역 2개가 만들어진다', () => assert.strictEqual(madeRoles.data.roles.length, 2));
  const butler = madeRoles.data.roles.find((r) => r.name === '집사');
  const doctor = madeRoles.data.roles.find((r) => r.name === '의사');

  const assigned = await api(`/api/gm/participants/${A.participant.id}/role`, {
    method: 'PUT', headers: GM, body: { roleId: butler.id },
  });
  check('A에게 집사 배역이 배정된다', () =>
    assert.strictEqual(assigned.data.roles.find((r) => r.id === butler.id).holder.nickname, '앨리스'));

  const rf = new FormData();
  rf.append('files', new Blob([Buffer.from('%PDF-1.4 집사용')], { type: 'application/pdf' }), '집사_핸드아웃.pdf');
  rf.append('roleId', butler.id);
  const roleUp = await api('/api/gm/library', { method: 'POST', headers: GM, form: rf });
  check('배역 자료함에 업로드된다', () => assert.strictEqual(roleUp.data.files[0].roleId, butler.id));
  const roleFileId = roleUp.data.files[0].id;

  const lib = await api('/api/gm/library', { headers: GM });
  check('집사 자료함에 1개', () =>
    assert.strictEqual(lib.data.files.filter((f) => f.roleId === butler.id).length, 1));
  check('공용 자료함에는 배역 없는 자료만', () =>
    assert.ok(lib.data.files.filter((f) => !f.roleId).length >= 1));

  const moved = await api(`/api/gm/library/${roleFileId}`, {
    method: 'PATCH', headers: GM, body: { roleId: doctor.id },
  });
  check('자료를 다른 배역으로 옮긴다', () => assert.strictEqual(moved.status, 200));
  const lib2 = await api('/api/gm/library', { headers: GM });
  check('의사 자료함으로 옮겨졌다', () =>
    assert.strictEqual(lib2.data.files.filter((f) => f.roleId === doctor.id).length, 1));

  const stolen = await api(`/api/gm/participants/${B.participant.id}/role`, {
    method: 'PUT', headers: GM, body: { roleId: butler.id },
  });
  check('한 배역은 한 사람에게만 붙는다', () =>
    assert.strictEqual(stolen.data.roles.find((r) => r.id === butler.id).holder.nickname, '밥'));

  const rolesNoAuth = await api('/api/gm/roles');
  check('배역 목록은 GM 전용 (403)', () => assert.strictEqual(rolesNoAuth.status, 403));

  const delRole = await api(`/api/gm/roles/${doctor.id}`, { method: 'DELETE', headers: GM });
  check('배역 삭제 성공', () => assert.strictEqual(delRole.status, 200));
  const lib3 = await api('/api/gm/library', { headers: GM });
  check('배역을 지워도 자료는 남는다 (공용으로 내려감)', () =>
    assert.ok(lib3.data.files.some((f) => f.id === roleFileId && !f.roleId)));

  section(11, '메시지 삭제');
  const aMine = a2.hello.messages.find((m) => m.sender === 'player');
  const delOk = await ask(a2.sock, 'message:delete', { messageId: aMine.id });
  check('플레이어가 자기 메시지를 지운다', () => assert.ok(delOk.ok));
  await sleep(250);

  const a3 = await connect({ playerToken: A.token });
  const goneA = a3.hello.messages.find((m) => m.id === aMine.id);
  check('지운 메시지는 내용 없이 표시된다', () => assert.ok(goneA.deleted && goneA.body === null));

  const gmMsg = a3.hello.messages.find((m) => m.sender === 'gm' && !m.deleted && !m.file);
  const denied = await ask(a3.sock, 'message:delete', { messageId: gmMsg.id });
  check('플레이어는 GM 메시지를 못 지운다', () => assert.ok(denied.error));

  const fileMsg = a3.hello.messages.find((m) => m.file);
  const dlBefore = await fetch(`${BASE}/f/${fileMsg.file.id}?t=${encodeURIComponent(A.token)}`);
  check('지우기 전에는 파일이 받아진다', () => assert.strictEqual(dlBefore.status, 200));
  const gmDel = await ask(gm.sock, 'message:delete', { messageId: fileMsg.id });
  check('GM이 자기 메시지를 지운다', () => assert.ok(gmDel.ok));
  await sleep(250);
  const dlAfter = await fetch(`${BASE}/f/${fileMsg.file.id}?t=${encodeURIComponent(A.token)}`);
  check('지운 뒤에는 파일도 404', () => assert.strictEqual(dlAfter.status, 404));

  // 공지는 한 번에 여러 명에게 갔으므로 한 번의 삭제로 모두에게서 사라져야 한다.
  const bcA = a3.hello.messages.find((m) => m.kind === 'broadcast');
  await ask(gm.sock, 'message:delete', { messageId: bcA.id });
  await sleep(300);
  const a4 = await connect({ playerToken: A.token });
  const b2 = await connect({ playerToken: B.token });
  check('공지가 A에게서 사라진다', () =>
    assert.ok(a4.hello.messages.find((m) => m.id === bcA.id).deleted));
  check('공지가 B에게서도 함께 사라진다', () =>
    assert.ok(b2.hello.messages.filter((m) => m.kind === 'broadcast').every((m) => m.deleted)));
  a4.sock.disconnect();
  b2.sock.disconnect();

  section(12, '내보내기');
  const exp = await fetch(`${BASE}/api/gm/export?gm=${encodeURIComponent(gmToken)}`);
  const html = await exp.text();
  check('내보내기 200', () => assert.strictEqual(exp.status, 200));
  check('두 참가자가 모두 들어 있다', () => assert.ok(html.includes('앨리스') && html.includes('밥')));
  check('보낸 GM 이름이 기록에 남는다', () => assert.ok(html.includes('진행자김')));
  check('지운 대화 내용은 빠진다', () => assert.ok(!html.includes('A의 비밀입니다')));
  check('삭제 흔적은 남는다', () => assert.ok(html.includes('삭제된 메시지')));
  check('배역 이름이 함께 나온다', () => assert.ok(html.includes('집사')));
  const expNoAuth = await fetch(`${BASE}/api/gm/export?gm=wrong`);
  check('잘못된 토큰은 403', () => assert.strictEqual(expNoAuth.status, 403));

  section(13, '여러 GM');
  const noGmPass = await api('/api/gm/login', {
    method: 'POST', body: { roomId: room.id, linkToken, nickname: '서브 GM' },
  });
  check('GM 암호 없이 로그인 불가 (401)', () => assert.strictEqual(noGmPass.status, 401));

  const badLink = await api('/api/gm/login', {
    method: 'POST', body: { roomId: room.id, linkToken: 'wrong', password: 'gmsecret', nickname: '서브 GM' },
  });
  check('잘못된 GM 링크는 거부 (403)', () => assert.strictEqual(badLink.status, 403));

  const gm2Login = await api('/api/gm/login', {
    method: 'POST', body: { roomId: room.id, linkToken, password: 'gmsecret', nickname: '서브 GM' },
  });
  check('두 번째 GM 로그인 성공', () => assert.strictEqual(gm2Login.status, 200));
  const GM2 = { 'x-gm-token': gm2Login.data.token };

  const dupGm = await api('/api/gm/login', {
    method: 'POST', body: { roomId: room.id, linkToken, password: 'gmsecret', nickname: '서브 GM' },
  });
  check('GM 닉네임 중복 거부 (409)', () => assert.strictEqual(dupGm.status, 409));

  const gmList = await api('/api/gm/gms', { headers: GM2 });
  check('GM이 2명으로 보인다', () => assert.strictEqual(gmList.data.gms.length, 2));

  const gm2Sees = await api('/api/gm/participants', { headers: GM2 });
  check('서브 GM도 플레이어 전원을 본다', () => assert.strictEqual(gm2Sees.data.participants.length, 2));
  const gm2Thread = await api(`/api/gm/threads/${B.participant.id}`, { headers: GM2 });
  check('서브 GM도 남의 스레드를 읽는다', () => assert.strictEqual(gm2Thread.status, 200));

  const gm2 = await connect({ gmToken: gm2Login.data.token });
  const bBefore2 = b.received.length;
  await api('/api/gm/send', { method: 'POST', headers: GM2, body: { targets: [B.participant.id], body: '서브 GM이 보냅니다' } });
  await sleep(300);
  check('서브 GM의 발송이 플레이어에게 간다', () => assert.strictEqual(b.received.length, bBefore2 + 1));
  check('보낸 GM의 이름이 실린다', () => assert.strictEqual(b.received.at(-1).senderName, '서브 GM'));
  check('첫 GM도 그 메시지를 본다', () => assert.ok(gm.received.some((m) => m.senderName === '서브 GM')));

  section(14, 'GM끼리의 대화');
  const gmChatSeen = [];
  gm.sock.on('gm:message', (m) => gmChatSeen.push(m));
  const gm2ChatSeen = [];
  gm2.sock.on('gm:message', (m) => gm2ChatSeen.push(m));
  const playerSawGmChat = [];
  a3.sock.on('gm:message', (m) => playerSawGmChat.push(m));

  await ask(gm.sock, 'gm:chat', { channel: 'all', body: 'GM 전체방 테스트' });
  await sleep(300);
  check('GM 전체방이 두 GM 모두에게 간다', () =>
    assert.ok(gmChatSeen.length === 1 && gm2ChatSeen.length === 1));
  check('플레이어에게는 GM 대화가 가지 않는다', () => assert.strictEqual(playerSawGmChat.length, 0));

  await ask(gm2.sock, 'gm:chat', { channel: created.data.gm.id, body: '1:1 귓속말' });
  await sleep(300);
  check('1:1 GM 대화가 상대에게 간다', () =>
    assert.ok(gmChatSeen.some((m) => m.body === '1:1 귓속말')));
  check('1:1 대화에 보낸 GM 이름이 붙는다', () =>
    assert.strictEqual(gmChatSeen.at(-1).senderName, '서브 GM'));

  const gmHist = await api('/api/gm/chat/all', { headers: GM2 });
  check('GM 전체방 이력을 읽는다', () => assert.strictEqual(gmHist.data.messages.length, 1));
  const gmHistNoAuth = await api('/api/gm/chat/all', { headers: { 'x-player-token': A.token } });
  check('플레이어는 GM 대화를 못 읽는다 (403)', () => assert.strictEqual(gmHistNoAuth.status, 403));

  // 전체방은 여럿이 보는 자리다 — 자기가 쓴 것만 거둬들일 수 있어야 한다.
  const gmDelSeen = [];
  gm2.sock.on('gm:message:deleted', (d) => gmDelSeen.push(d));
  const myGmMsg = gmChatSeen.find((m) => m.body === 'GM 전체방 테스트');
  const gcDelOther = await ask(gm2.sock, 'gm:chat:delete', { messageId: myGmMsg.id });
  check('남이 쓴 GM 전체방 글은 못 지운다', () => assert.ok(gcDelOther.error));
  const gcDelMine = await ask(gm.sock, 'gm:chat:delete', { messageId: myGmMsg.id });
  await sleep(300);
  check('내가 쓴 GM 전체방 글은 지운다', () => assert.ok(gcDelMine.ok));
  check('지운 사실이 다른 GM에게도 간다', () =>
    assert.ok(gmDelSeen.some((d) => d.id === myGmMsg.id)));
  const gmHist2 = await api('/api/gm/chat/all', { headers: GM2 });
  check('지운 글은 이력에서 본문이 사라진다', () =>
    assert.ok(gmHist2.data.messages.every((m) => m.body !== 'GM 전체방 테스트')));
  const gcDelAgain = await ask(gm.sock, 'gm:chat:delete', { messageId: myGmMsg.id });
  check('두 번 지워도 조용히 넘어간다', () => assert.ok(gcDelAgain.ok));
  const gcDelPlayer = await ask(a3.sock, 'gm:chat:delete', { messageId: myGmMsg.id });
  check('플레이어는 GM 글을 못 지운다', () => assert.ok(gcDelPlayer.error));

  section(15, '닉네임 바꾸기');
  const renamed = await api('/api/me/nickname', {
    method: 'PUT', headers: { 'x-player-token': B.token }, body: { nickname: '밥2' },
  });
  check('플레이어가 이름을 바꾼다', () => assert.strictEqual(renamed.data.nickname, '밥2'));
  const dupName = await api('/api/me/nickname', {
    method: 'PUT', headers: { 'x-player-token': B.token }, body: { nickname: '앨리스' },
  });
  check('남이 쓰는 이름으로는 못 바꾼다 (409)', () => assert.strictEqual(dupName.status, 409));

  await sleep(200);
  const bAfterRename = await connect({ playerToken: B.token });
  check('바뀐 이름이 이력의 이름표에도 반영된다', () =>
    assert.ok(bAfterRename.hello.messages.filter((m) => m.sender === 'player')
      .every((m) => m.senderName === '밥2')));
  bAfterRename.sock.disconnect();

  const gmRenamed = await api('/api/gm/me/nickname', {
    method: 'PUT', headers: GM2, body: { nickname: '부진행자' },
  });
  check('GM도 이름을 바꾼다', () => assert.strictEqual(gmRenamed.data.nickname, '부진행자'));

  // ── 이름 색 ────────────────────────────────────────────────────────────────
  // 각자 자기 색을 고르고, 모두가 같은 색을 본다. 색 값은 style 에 그대로 들어가므로
  // 서버가 #rrggbb 말고는 받지 않아야 한다.
  const myColor = await api('/api/me/color', {
    method: 'PUT', headers: { 'x-player-token': B.token }, body: { color: '#FF8800' },
  });
  check('플레이어가 이름 색을 고른다', () => assert.strictEqual(myColor.data.color, '#ff8800'));
  const badColor = await api('/api/me/color', {
    method: 'PUT', headers: { 'x-player-token': B.token }, body: { color: 'red; background:url(x)' },
  });
  check('이상한 색 값은 막는다 (400)', () => assert.strictEqual(badColor.status, 400));
  const gmColor = await api('/api/gm/me/color', { method: 'PUT', headers: GM2, body: { color: '#22cc99' } });
  check('GM도 이름 색을 고른다', () => assert.strictEqual(gmColor.data.color, '#22cc99'));

  const seenByGm = await api('/api/gm/participants', { headers: GM });
  check('GM 목록에 플레이어 색이 실린다', () =>
    assert.strictEqual(seenByGm.data.participants.find((p) => p.id === B.participant.id).color, '#ff8800'));
  const gmsSeen = await api('/api/gm/gms', { headers: GM });
  check('GM 목록에 GM 색이 실린다', () =>
    assert.ok(gmsSeen.data.gms.some((g) => g.color === '#22cc99')));

  await sleep(200);
  const bColored = await connect({ playerToken: B.token });
  check('말풍선 이름표에도 색이 따라온다', () =>
    assert.ok(bColored.hello.messages.filter((m) => m.sender === 'player')
      .every((m) => m.senderColor === '#ff8800')));
  const meColored = await api('/api/me', { headers: { 'x-player-token': B.token } });
  check('내 색을 다시 받아 온다', () => assert.strictEqual(meColored.data.participant.color, '#ff8800'));

  // GM 색도 같은 길로 간다. 다만 **NPC 이름 뒤에 숨은 GM**의 색은 플레이어에게 가면 안 된다 —
  // 색만 보고 「아까 그 NPC도 이 사람이었구나」를 알아차릴 수 있기 때문이다.
  await api('/api/gm/send', {
    method: 'POST', headers: GM2, body: { targets: [B.participant.id], body: '내 이름으로 한마디' },
  });
  await sleep(250);
  check('GM이 자기 이름으로 한 말에는 색이 실린다', () =>
    assert.strictEqual(bColored.received.at(-1).senderColor, '#22cc99'));
  await api('/api/gm/send', {
    method: 'POST', headers: GM2,
    body: { targets: [B.participant.id], body: '누구시오?', npcName: '문지기' },
  });
  await sleep(250);
  check('NPC 이름으로 한 말에는 색이 실리지 않는다', () =>
    assert.strictEqual(bColored.received.at(-1).senderColor, null));
  check('NPC 뒤의 GM 이름도 플레이어에게는 안 간다', () =>
    assert.strictEqual(bColored.received.at(-1).gmName, undefined));
  const gmThread = await api(`/api/gm/threads/${B.participant.id}`, { headers: GM });
  check('GM 화면에는 NPC 뒤의 GM 이름과 색이 실린다', () => {
    const seen = gmThread.data.messages.filter((m) => m.npcName === '문지기').at(-1);
    assert.ok(seen && seen.gmName === '부진행자' && seen.gmColor === '#22cc99');
  });
  bColored.sock.disconnect();

  const cleared = await api('/api/me/color', {
    method: 'PUT', headers: { 'x-player-token': B.token }, body: { color: '' },
  });
  check('색을 없앨 수 있다', () => assert.strictEqual(cleared.data.color, null));
  const colorNoAuth = await api('/api/me/color', { method: 'PUT', body: { color: '#123456' } });
  check('토큰 없이는 색을 못 바꾼다 (401)', () => assert.strictEqual(colorNoAuth.status, 401));

  section(16, '드래그로 정한 순서');
  const order = [B.participant.id, A.participant.id];
  const savedOrder = await api('/api/gm/participants/order', { method: 'PUT', headers: GM, body: { ids: order } });
  check('순서 저장 성공', () => assert.strictEqual(savedOrder.status, 200));
  const reordered = await api('/api/gm/participants', { headers: GM });
  check('저장한 순서대로 나온다', () =>
    assert.deepStrictEqual(reordered.data.participants.map((p) => p.id), order));

  const libNow = (await api('/api/gm/library', { headers: GM })).data.files;
  const libOrder = libNow.map((f) => f.id).reverse();
  await api('/api/gm/library/order', { method: 'PUT', headers: GM, body: { ids: libOrder } });
  const libAfter = (await api('/api/gm/library', { headers: GM })).data.files;
  check('자료 순서도 저장된다', () =>
    assert.deepStrictEqual(libAfter.map((f) => f.id), libOrder));

  section(17, '플레이어 기록 내보내기');
  const mine = await fetch(`${BASE}/api/me/export?t=${encodeURIComponent(A.token)}`);
  const mineHtml = await mine.text();
  check('플레이어가 자기 기록을 받는다', () => assert.strictEqual(mine.status, 200));
  check('내 대화만 들어 있다', () => assert.ok(mineHtml.includes('앨리스') && !mineHtml.includes('밥2')));
  const notMine = await fetch(`${BASE}/api/me/export`);
  check('인증 없이는 거부 (403)', () => assert.strictEqual(notMine.status, 403));

  // 기록만 남고 그림이 사라지면 복기를 못 한다 — 파일 안에 함께 담는다.
  const shotPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const shotForm = new FormData();
  shotForm.append('files', new Blob([shotPng], { type: 'image/png' }), '단서사진.png');
  const shotUp = await api('/api/gm/library', { method: 'POST', headers: GM, form: shotForm });
  const shotId = shotUp.data.files[0].id;
  const shotSent = await api('/api/gm/send', {
    method: 'POST', headers: GM, body: { targets: [A.participant.id], fileId: shotId },
  });
  check('그림을 하나 보낸다', () => assert.strictEqual(shotSent.status, 200));

  const withShot = await (await fetch(`${BASE}/api/me/export?t=${encodeURIComponent(A.token)}`)).text();
  check('내보낸 기록에 그림이 박혀 있다', () => assert.ok(withShot.includes('src="data:image/png;base64,')));
  check('그림을 몇 장 담았는지 적는다', () => assert.ok(withShot.includes('그림 1장 포함')));
  check('파일 이름도 그대로 남는다', () => assert.ok(withShot.includes('단서사진.png')));
  check('박아 넣은 그림이 원본과 같다', () => {
    const got = /src="data:image\/png;base64,([^"]+)"/.exec(withShot);
    assert.ok(got, '그림이 없다');
    assert.ok(Buffer.from(got[1], 'base64').equals(shotPng));
  });

  const gmWithShot = await (await fetch(`${BASE}/api/gm/export?gm=${encodeURIComponent(created.data.gmToken)}`)).text();
  check('GM 전체 기록에도 그림이 담긴다', () => assert.ok(gmWithShot.includes('src="data:image/png;base64,')));

  // 그림이 아닌 첨부는 이름만 남는다 (기록 파일이 무거워지지 않게).
  const docForm = new FormData();
  docForm.append('files', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), '조사보고서.pdf');
  const docUp = await api('/api/gm/library', { method: 'POST', headers: GM, form: docForm });
  await api('/api/gm/send', {
    method: 'POST', headers: GM, body: { targets: [A.participant.id], fileId: docUp.data.files[0].id },
  });
  const withDoc = await (await fetch(`${BASE}/api/me/export?t=${encodeURIComponent(A.token)}`)).text();
  check('그림이 아닌 파일은 이름만 남는다', () =>
    assert.ok(withDoc.includes('조사보고서.pdf') && !withDoc.includes('data:application/pdf')));

  section(18, '라운드 타이머');
  const tSet = await api('/api/gm/timer', {
    method: 'POST', headers: GM, body: { action: 'set', ms: 60000, label: '1라운드', sound: 'chime' },
  });
  check('시간을 정한다', () => assert.strictEqual(tSet.data.timer.remainingMs, 60000));
  check('이름과 소리가 실린다', () =>
    assert.ok(tSet.data.timer.label === '1라운드' && tSet.data.timer.sound === 'chime'));

  const seenTimer = [];
  b.sock.on('timer', (t) => seenTimer.push(t));

  const tStart = await api('/api/gm/timer', { method: 'POST', headers: GM, body: { action: 'start' } });
  await sleep(300);
  check('시작하면 실행 중이 된다', () => assert.strictEqual(tStart.data.timer.running, true));
  check('플레이어에게도 전달된다', () => assert.ok(seenTimer.some((t) => t.running)));

  await sleep(1100);
  const tPause = await api('/api/gm/timer', { method: 'POST', headers: GM, body: { action: 'pause' } });
  check('멈추면 남은 시간이 줄어 있다', () =>
    assert.ok(tPause.data.timer.remainingMs < 60000 && tPause.data.timer.remainingMs > 55000));
  check('멈춘 상태로 바뀐다', () => assert.strictEqual(tPause.data.timer.running, false));

  const tReset = await api('/api/gm/timer', { method: 'POST', headers: GM, body: { action: 'reset' } });
  check('되돌리면 처음 시간으로', () => assert.strictEqual(tReset.data.timer.remainingMs, 60000));

  const tRe = await api('/api/gm/timer', {
    method: 'POST', headers: GM, body: { action: 'start', ms: 30000 },
  });
  check('시간을 새로 줘서 다시 시작할 수 있다', () =>
    assert.ok(tRe.data.timer.running && tRe.data.timer.remainingMs <= 30000));

  const tNoAuth = await api('/api/gm/timer', { method: 'POST', body: { action: 'pause' } });
  check('플레이어는 타이머를 못 만진다 (403)', () => assert.strictEqual(tNoAuth.status, 403));

  await api('/api/gm/timer', { method: 'POST', headers: GM, body: { action: 'clear' } });
  check('치울 수 있다', async () => {});

  section(19, 'NPC 이름으로 말하기');
  const npcBefore = b.received.length;
  await api('/api/gm/send', {
    method: 'POST', headers: GM,
    body: { targets: [B.participant.id], body: '누구요?', npcName: '집사 노인' },
  });
  await sleep(300);
  check('플레이어에게는 NPC 이름으로 보인다', () =>
    assert.strictEqual(b.received.at(-1).senderName, '집사 노인'));
  check('플레이어에게 실제 GM 이름은 가지 않는다', () =>
    assert.strictEqual(b.received.at(-1).gmName, undefined));
  check('GM에게는 실제 발신자가 함께 온다', () => {
    const seen = gm.received.filter((m) => m.npcName === '집사 노인').at(-1);
    return assert.ok(seen && seen.gmName);
  });
  check('플레이어 수신 건수가 늘었다', () => assert.strictEqual(b.received.length, npcBefore + 1));

  section(20, '배역별 일괄 발송');
  // 배역 두 개에 사람과 자료를 붙인다
  const r2 = await api('/api/gm/roles', { method: 'POST', headers: GM, body: { names: ['탐정', '기자'] } });
  const det = r2.data.roles.find((r) => r.name === '탐정');
  const rep = r2.data.roles.find((r) => r.name === '기자');
  await api(`/api/gm/participants/${A.participant.id}/role`, {
    method: 'PUT', headers: GM, body: { roleId: det.id },
  });
  await api(`/api/gm/participants/${B.participant.id}/role`, {
    method: 'PUT', headers: GM, body: { roleId: rep.id },
  });
  for (const [role, name] of [[det, '탐정_1'], [det, '탐정_2'], [rep, '기자_1']]) {
    const f = new FormData();
    f.append('files', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), name + '.pdf');
    f.append('roleId', role.id);
    await api('/api/gm/library', { method: 'POST', headers: GM, form: f });
  }

  const prev = await api('/api/gm/send-role-batch/preview', { headers: GM });
  check('무엇이 나갈지 미리 보여준다', () =>
    assert.ok(prev.data.plan.some((p) => p.file === '탐정_1.pdf')));

  const aBefore = a3.received.length, bBefore3 = b.received.length;
  const batch1 = await api('/api/gm/send-role-batch', { method: 'POST', headers: GM });
  await sleep(400);
  check('배역을 맡은 두 명에게 나간다', () => assert.strictEqual(batch1.data.sent.length, 2));
  check('A는 탐정 1번을 받는다', () =>
    assert.strictEqual(a3.received.at(-1).file.name, '탐정_1.pdf'));
  check('B는 기자 1번을 받는다', () =>
    assert.strictEqual(b.received.at(-1).file.name, '기자_1.pdf'));

  const batch2 = await api('/api/gm/send-role-batch', { method: 'POST', headers: GM });
  await sleep(400);
  check('다시 누르면 다음 자료로 넘어간다', () =>
    assert.ok(batch2.data.sent.some((x) => x.file === '탐정_2.pdf')));
  check('보낼 게 없는 배역은 건너뛴다', () =>
    assert.ok(batch2.data.skipped.some((x) => x.role === '기자')));

  const batch3 = await api('/api/gm/send-role-batch', { method: 'POST', headers: GM });
  check('전부 보냈으면 아무것도 안 나간다', () => assert.strictEqual(batch3.data.sent.length, 0));

  section(21, '질문지 (제출함)');
  const askRes = await api('/api/gm/ask', {
    method: 'POST', headers: GM,
    body: {
      question: '최종 지목',
      items: ['범인은 누구인가?', '그 근거는?'],
      targets: [A.participant.id, B.participant.id],
    },
  });
  check('질문지를 보낸다', () => assert.strictEqual(askRes.data.count, 2));
  const pollId = askRes.data.poll.id;
  check('항목이 2개다', () => assert.strictEqual(askRes.data.poll.items.length, 2));
  await sleep(300);
  check('플레이어가 질문 메시지를 받는다', () => {
    const m = b.received.at(-1);
    return assert.ok(m.kind === 'ask' && m.pollId === pollId);
  });

  const ans1 = await ask(a3.sock, 'player:answer', { pollId, itemIndex: 0, body: '집사입니다' });
  check('1번에 답한다', () => assert.ok(ans1.ok));
  const ans2 = await ask(a3.sock, 'player:answer', { pollId, itemIndex: 1, body: '발자국 때문' });
  check('2번에도 따로 답한다', () => assert.ok(ans2.ok));
  const ans3 = await ask(a3.sock, 'player:answer', { pollId, itemIndex: 0, body: '아니 의사입니다' });
  check('같은 항목에 다시 내서 답을 수정할 수 있다', () => assert.ok(ans3.ok));
  await sleep(20);
  await ask(a3.sock, 'player:answer', { pollId, itemIndex: 0, body: '중간 답' });
  await sleep(20);
  await ask(a3.sock, 'player:answer', { pollId, itemIndex: 0, body: '집사' });
  await sleep(20);
  await ask(a3.sock, 'player:answer', { pollId, itemIndex: 0, body: '아니 의사입니다' });
  await sleep(300);

  const gathered = await api(`/api/gm/ask/${pollId}`, { headers: GM });
  const alice = gathered.data.poll.people.find((p) => p.nickname === '앨리스');
  check('GM은 사람별로 항목을 묶어 본다', () =>
    assert.ok(alice.answers[0].length === 2 && alice.answers[1].length === 1));
  check('마지막 답이 수정한 답이다', () =>
    assert.strictEqual(alice.answers[0].at(-1).body, '아니 의사입니다'));
  check('여러 번 고치면 직전 답만 남고 그 이전 답은 지워진다', () =>
    assert.deepStrictEqual(alice.answers[0].map((a) => a.body), ['집사', '아니 의사입니다']));
  const mineNow = await ask(a3.sock, 'ask:fetch', { pollId });
  check('플레이어 쪽에서도 마지막 답이 수정한 답이다', () =>
    assert.strictEqual(mineNow.mine[0].at(-1).body, '아니 의사입니다'));
  check('아직 답 안 한 사람은 미제출로 보인다', () => {
    const bob = gathered.data.poll.people.find((p) => p.nickname !== '앨리스');
    return assert.strictEqual(bob.answers[0].length, 0);
  });

  const badItem = await ask(b.sock, 'player:answer', { pollId, itemIndex: 5, body: 'x' });
  check('없는 항목에는 답할 수 없다', () => assert.ok(badItem.error));

  // 마감하면 더 못 낸다
  await api(`/api/gm/ask/${pollId}/close`, { method: 'POST', headers: GM });
  await sleep(200);
  const afterClose2 = await ask(a3.sock, 'player:answer', { pollId, itemIndex: 0, body: '늦은 답' });
  check('마감 뒤에는 제출 불가', () => assert.ok(afterClose2.error));

  // 답을 내도 항목마다 대화 말풍선이 생기지 않아야 한다
  check('답을 내도 대화 말풍선이 생기지 않는다', () =>
    assert.ok(!a3.received.some((m) => m.kind === 'answer')));

  // 정리하기 — GM 전체방으로만 가고 플레이어에게는 가지 않는다
  const gmSeen = [];
  gm.sock.on('gm:message', (m) => gmSeen.push(m));
  const bBefore4 = b.received.length;
  const sum = await api(`/api/gm/ask/${pollId}/summary`, { method: 'POST', headers: GM });
  await sleep(400);
  check('사람별·항목별로 정리된다', () => assert.ok(sum.data.summary.includes('아니 의사입니다')));
  check('답 안 한 사람은 미제출로 표시된다', () => assert.ok(sum.data.summary.includes('미제출')));
  check('정리 글이 GM 전체방에 올라간다', () =>
    assert.ok(gmSeen.some((m) => m.channel === 'all' && m.body.includes('[집계]'))));
  check('플레이어에게는 가지 않는다', () => assert.strictEqual(b.received.length, bBefore4));

  // GM이 잘못 보낸 질문지를 지운다
  await api(`/api/gm/ask/${pollId}/close`, { method: 'POST', headers: GM });   // 다시 열어 둔다
  const askMsg = a3.received.find((m) => m.kind === 'ask' && m.pollId === pollId);
  const delAsk = await ask(gm.sock, 'message:delete', { messageId: askMsg.id });
  check('GM이 질문지를 지운다', () => assert.ok(delAsk.ok));
  await sleep(300);
  const afterDel = await ask(a3.sock, 'player:answer', { pollId, itemIndex: 0, body: '지운 뒤' });
  check('지운 질문지에는 답할 수 없다', () => assert.ok(afterDel.error));
  const bHist = await connect({ playerToken: B.token });
  check('받은 사람 모두에게서 지워진다', () =>
    assert.ok(bHist.hello.messages.filter((m) => m.pollId === pollId && m.kind === 'ask').every((m) => m.deleted)));
  bHist.sock.disconnect();

  const askNoAuth = await api(`/api/gm/ask/${pollId}`, { headers: { 'x-player-token': A.token } });
  check('플레이어는 집계를 못 본다 (403)', () => assert.strictEqual(askNoAuth.status, 403));

  section(22, '미리 저장하는 질문지');
  const tpl = await api('/api/gm/ask-templates', {
    method: 'POST', headers: GM,
    body: { title: '1라운드 조사', items: ['어디를 조사했나?', '무엇을 찾았나?'] },
  });
  check('질문지를 저장한다', () => assert.strictEqual(tpl.data.templates.length, 1));
  const tplId = tpl.data.templates[0].id;
  check('문항이 저장된다', () => assert.strictEqual(tpl.data.templates[0].items.length, 2));

  const fromTpl = await api('/api/gm/ask', {
    method: 'POST', headers: GM, body: { templateId: tplId, all: true },
  });
  check('저장해 둔 질문지를 한 번에 뿌린다', () =>
    assert.strictEqual(fromTpl.data.poll.question, '1라운드 조사'));
  check('문항이 그대로 실린다', () => assert.strictEqual(fromTpl.data.poll.items.length, 2));

  const tplDel = await api(`/api/gm/ask-templates/${tplId}`, { method: 'DELETE', headers: GM });
  check('질문지를 지운다', () => assert.strictEqual(tplDel.data.templates.length, 0));

  section(23, '예약 발송 제거 확인');
  const sched = await api('/api/gm/scheduled', { headers: GM });
  check('예약 API가 더 이상 없다 (404)', () => assert.strictEqual(sched.status, 404));

  section(24, '대화에 붙이는 표시(반응)');
  await api('/api/gm/send', { method: 'POST', headers: GM, body: { targets: [B.participant.id], body: '표시 대상' } });
  await sleep(250);
  const markMsg = b.received.at(-1);
  const gmMark = await ask(gm.sock, 'reaction:toggle', { scope: 'msg', messageId: markMsg.id, emoji: 'OK' });
  check('GM이 표시를 붙인다', () => assert.ok(gmMark.ok));
  await sleep(200);
  check('플레이어에게 표시가 전달된다', () =>
    assert.ok(b.reactions.some((r) => r.messageId === markMsg.id && r.reactions[0].emoji === 'OK')));

  const plMark = await ask(b.sock, 'reaction:toggle', { scope: 'msg', messageId: markMsg.id, emoji: 'OK' });
  check('플레이어도 같은 표시를 누를 수 있다', () => assert.ok(plMark.ok));
  check('같은 표시는 눌린 사람 수로 모인다', () =>
    assert.strictEqual(plMark.reactions[0].actors.length, 2));

  const undo = await ask(b.sock, 'reaction:toggle', { scope: 'msg', messageId: markMsg.id, emoji: 'OK' });
  check('다시 누르면 내 표시만 취소된다', () =>
    assert.strictEqual(undo.reactions[0].actors.length, 1));

  const steal = await ask(a3.sock, 'reaction:toggle', { scope: 'msg', messageId: markMsg.id, emoji: 'X' });
  check('남의 스레드 메시지에는 표시할 수 없다', () => assert.ok(steal.error));

  const histMark = await connect({ playerToken: B.token });
  check('다시 들어와도 표시가 남아 있다', () =>
    assert.ok(histMark.hello.messages.find((m) => m.id === markMsg.id).reactions[0].emoji === 'OK'));
  histMark.sock.disconnect();

  section(25, 'GM끼리 파일 주고받기');
  const gfd = new FormData();
  gfd.append('files', new Blob([Buffer.from('%PDF-1.4 GM용')], { type: 'application/pdf' }), 'GM_참고.pdf');
  const gmUp = await api('/api/gm/chat/all/upload', { method: 'POST', headers: GM, form: gfd });
  check('GM 전체방에 파일을 보낸다', () => assert.strictEqual(gmUp.status, 200));
  await sleep(250);
  const gmFileMsg = gm2ChatSeen.filter((m) => m.file).at(-1);
  check('다른 GM에게 첨부가 도착한다', () => assert.ok(gmFileMsg && gmFileMsg.file.name === 'GM_참고.pdf'));
  check('플레이어에게는 가지 않는다', () =>
    assert.ok(!b.received.some((m) => m.file && m.file.name === 'GM_참고.pdf')));
  const gmFileDl = await fetch(`${BASE}/f/${gmFileMsg.file.id}?t=${encodeURIComponent(B.token)}`);
  check('플레이어는 GM 첨부를 내려받을 수 없다 (404)', () => assert.strictEqual(gmFileDl.status, 404));

  const gmMarkRes = await ask(gm.sock, 'reaction:toggle', { scope: 'gm', messageId: gmFileMsg.id, emoji: 'OK' });
  check('GM 대화에도 표시를 붙인다', () => assert.ok(gmMarkRes.ok));

  const chatExport = await fetch(`${BASE}/api/gm/chat-export?gm=${encodeURIComponent(gmToken)}`);
  const chatHtml = await chatExport.text();
  check('GM 대화만 따로 내보낸다', () => assert.ok(chatHtml.includes('GM 전체방')));
  check('내보낸 기록에 첨부 이름이 있다', () => assert.ok(chatHtml.includes('GM_참고.pdf')));

  section(26, '자료함 일괄 비우기');
  const cfd = new FormData();
  cfd.append('files', new Blob([Buffer.from('%PDF-1.4 비우기용')], { type: 'application/pdf' }), '비울자료.pdf');
  cfd.append('roleId', butler.id);
  await api('/api/gm/library', { method: 'POST', headers: GM, form: cfd });

  const clrRole = await api('/api/gm/library/clear', { method: 'POST', headers: GM, body: { scope: butler.id } });
  check('배역 자료함을 비운다', () => assert.strictEqual(clrRole.status, 200));
  const afterRole = (await api('/api/gm/library', { headers: GM })).data.files;
  check('그 배역 자료만 사라진다', () => assert.ok(!afterRole.some((f) => f.roleId === butler.id)));
  check('다른 자료는 남는다', () => assert.ok(afterRole.length > 0));
  const goneRole = await api('/api/gm/library/clear', { method: 'POST', headers: GM, body: { scope: 'nope' } });
  check('없는 배역은 거부된다 (404)', () => assert.strictEqual(goneRole.status, 404));

  const clrAll = await api('/api/gm/library/clear', { method: 'POST', headers: GM, body: { scope: 'all' } });
  check('전부 비우기가 동작한다', () => assert.ok(clrAll.data.removed > 0));
  const afterAll = (await api('/api/gm/library', { headers: GM })).data.files;
  check('자료함이 비었다', () => assert.strictEqual(afterAll.length, 0));
  const keptMsg = await connect({ playerToken: A.token });
  check('이미 보낸 자료는 대화에 그대로 남는다', () =>
    assert.ok(keptMsg.hello.messages.some((m) => m.file)));
  keptMsg.sock.disconnect();

  section(27, '방 만들기 암호 설정');
  const cfg = await api('/api/config');
  check('설정을 안 하면 암호 없이 만들 수 있다', () =>
    assert.strictEqual(cfg.data.needsCreatePassword, false));
  const freeRoom = await api('/api/rooms', { method: 'POST', body: { name: '암호 없이' } });
  check('실제로도 그냥 만들어진다', () => assert.strictEqual(freeRoom.status, 200));

  section(28, '기본 제공 알림음·표시 목록');
  const presets = await api('/api/presets');
  check('목록 API가 열려 있다', () => assert.strictEqual(presets.status, 200));
  check('소리와 표시를 함께 준다', () =>
    assert.ok(Array.isArray(presets.data.sounds) && Array.isArray(presets.data.emojis)));

  section(29, '난입 막기 — 입장 잠금과 내보내기');
  // 별도의 방에서 확인한다 (앞 섹션들이 쓰는 방을 흔들지 않도록).
  const guardRoom = await api('/api/rooms', { method: 'POST', body: { name: '난입 테스트', gmNickname: 'GM' } });
  const GGM = { 'x-gm-token': guardRoom.data.gmToken };
  const gCode = guardRoom.data.room.code;

  const inFirst = await api(`/api/rooms/by-code/${gCode}/join`, { method: 'POST', body: { nickname: '먼저온사람' } });
  check('잠그기 전에는 들어올 수 있다', () => assert.strictEqual(inFirst.status, 200));

  const locked = await api('/api/gm/lock', { method: 'POST', headers: GGM, body: { locked: true } });
  check('입장을 잠근다', () => assert.strictEqual(locked.data.locked, true));

  const intruder = await api(`/api/rooms/by-code/${gCode}/join`, { method: 'POST', body: { nickname: '난입자' } });
  check('잠근 뒤에는 새로 못 들어온다 (423)', () => assert.strictEqual(intruder.status, 423));

  const stillIn = await connect({ playerToken: inFirst.data.token });
  check('이미 들어온 사람은 그대로 접속된다', () => assert.strictEqual(stillIn.hello.role, 'player'));
  stillIn.sock.disconnect();

  const unlocked = await api('/api/gm/lock', { method: 'POST', headers: GGM, body: { locked: false } });
  check('다시 열 수 있다', () => assert.strictEqual(unlocked.data.locked, false));
  const inAgain = await api(`/api/rooms/by-code/${gCode}/join`, { method: 'POST', body: { nickname: '나중에온사람' } });
  check('열면 다시 들어올 수 있다', () => assert.strictEqual(inAgain.status, 200));

  // 내보내기
  const victim = await connect({ playerToken: inAgain.data.token });
  let kickedNotice = null;
  victim.sock.on('kicked', (payload) => { kickedNotice = payload; });

  const kickRes = await api(`/api/gm/participants/${inAgain.data.participant.id}`, { method: 'DELETE', headers: GGM });
  check('플레이어를 내보낸다', () => assert.strictEqual(kickRes.status, 200));
  await sleep(400);
  check('내보낸 사람에게 알림이 간다', () => assert.ok(kickedNotice && kickedNotice.error));
  check('연결이 끊긴다', () => assert.strictEqual(victim.sock.connected, false));

  const listAfterKick = (await api('/api/gm/participants', { headers: GGM })).data.participants;
  check('GM 목록에서 사라진다', () =>
    assert.ok(!listAfterKick.some((p) => p.nickname === '나중에온사람')));
  check('남은 사람은 그대로 보인다', () =>
    assert.ok(listAfterKick.some((p) => p.nickname === '먼저온사람')));

  const reuse = await api('/api/me', { headers: { 'x-player-token': inAgain.data.token } });
  check('내보낸 사람의 토큰은 더 이상 통하지 않는다', () => assert.ok(reuse.status === 401 || reuse.status === 403, String(reuse.status)));
  let rejoinFailed = false;
  try { const s2 = await connect({ playerToken: inAgain.data.token }); s2.sock.disconnect(); }
  catch { rejoinFailed = true; }
  check('소켓으로도 다시 붙지 못한다', () => assert.ok(rejoinFailed));

  const bcast = await api('/api/gm/send', { method: 'POST', headers: GGM, body: { all: true, body: '전체 공지' } });
  check('전체 발송 대상에서도 빠진다', () => assert.strictEqual(bcast.data.count, 1));

  const kickAgain = await api(`/api/gm/participants/${inAgain.data.participant.id}`, { method: 'DELETE', headers: GGM });
  check('이미 내보낸 사람은 다시 내보낼 수 없다 (404)', () => assert.strictEqual(kickAgain.status, 404));

  const otherRoomKick = await api(`/api/gm/participants/${A.participant.id}`, { method: 'DELETE', headers: GGM });
  check('다른 방 플레이어는 내보낼 수 없다 (404)', () => assert.strictEqual(otherRoomKick.status, 404));

  const asPlayerKick = await api(`/api/gm/participants/${inFirst.data.participant.id}`, {
    method: 'DELETE', headers: { 'x-player-token': inFirst.data.token },
  });
  check('플레이어는 남을 내보낼 수 없다 (403)', () => assert.strictEqual(asPlayerKick.status, 403));

  const kickedNick = await api(`/api/rooms/by-code/${gCode}/join`, { method: 'POST', body: { nickname: '나중에온사람' } });
  check('내보낸 사람의 닉네임은 다시 쓸 수 있다', () => assert.strictEqual(kickedNick.status, 200));

  // 여기서 같은 이름이 두 줄(내보낸 사람 + 새 사람)이 되었다.
  // 이 상태에서 **서버를 다시 켤 수 있어야 한다** — 예전에는 부팅 때 옛 유니크 인덱스를
  // 다시 만들려다 UNIQUE 위반으로 서버가 아예 뜨지 못했다.
  const boot = require('child_process').spawnSync(
    process.execPath, ['-e', "require('./src/db.js')"],
    { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: TMP }, encoding: 'utf8' }
  );
  check('같은 이름이 남아 있어도 서버가 다시 뜬다', () =>
    assert.strictEqual(boot.status, 0, String(boot.stderr || '').slice(0, 200)));

  section(30, '룸 셋팅');
  // 준비물(배역·자료·질문지)만 담아 다른 방에서 그대로 되살릴 수 있어야 한다.
  const noAuthBundle = await fetch(`${BASE}/api/gm/bundle`);
  check('인증 없이 룸 셋팅을 받을 수 없다 (403)', () => assert.strictEqual(noAuthBundle.status, 403));

  // 내보낼 것을 준비한다 (앞 섹션에서 자료함을 비웠으므로 다시 넣는다).
  const packRole = (await api('/api/gm/roles', { method: 'POST', headers: GM, body: { names: ['집사', '정원사'] } }))
    .data.roles.find((r) => r.name === '집사');
  const pfd = new FormData();
  pfd.append('files', new Blob([Buffer.from('%PDF-1.4 룸 셋팅용 자료')], { type: 'application/pdf' }), '집사_1막.pdf');
  pfd.append('roleId', packRole.id);
  await api('/api/gm/library', { method: 'POST', headers: GM, form: pfd });
  const pfd2 = new FormData();
  pfd2.append('files', new Blob([Buffer.from('%PDF-1.4 공용')], { type: 'application/pdf' }), '전체_지도.pdf');
  await api('/api/gm/library', { method: 'POST', headers: GM, form: pfd2 });
  await api('/api/gm/ask-templates', {
    method: 'POST', headers: GM, body: { title: '룸 셋팅 질문', items: ['하나?', '둘?'] },
  });

  const bundleRes = await fetch(`${BASE}/api/gm/bundle?gm=${encodeURIComponent(gmToken)}`);
  const bundleBuf = Buffer.from(await bundleRes.arrayBuffer());
  check('룸 셋팅을 내려받는다', () => assert.strictEqual(bundleRes.status, 200));
  check('zip 형식이다', () => assert.strictEqual(bundleBuf.subarray(0, 4).toString('binary'), 'PK\u0003\u0004'));

  // 비밀이 새지 않아야 한다 — 이 검사가 이 기능의 핵심이다.
  const asText = bundleBuf.toString('utf8');
  check('입장 암호가 담기지 않는다', () => assert.ok(!asText.includes('redmansion')));
  check('플레이어 이름이 담기지 않는다', () => assert.ok(!asText.includes('앨리스')));
  check('대화 내용이 담기지 않는다', () => assert.ok(!asText.includes('A의 비밀입니다')));

  // 새 방에 가져온다
  const newRoom = await api('/api/rooms', { method: 'POST', body: { name: '룸 셋팅 받는 방', gmNickname: 'GM' } });
  const NGM = { 'x-gm-token': newRoom.data.gmToken };
  const impFd = new FormData();
  impFd.append('bundle', new Blob([bundleBuf], { type: 'application/zip' }), 'pack.zip');
  const imported = await api('/api/gm/bundle/import', { method: 'POST', headers: NGM, form: impFd });
  check('룸 셋팅을 가져온다', () => assert.strictEqual(imported.status, 200));
  check('배역과 자료와 질문지가 함께 들어온다', () =>
    assert.ok(imported.data.roles >= 2 && imported.data.files === 2 && imported.data.askTemplates >= 1,
      JSON.stringify(imported.data)));

  const newRoles = (await api('/api/gm/roles', { headers: NGM })).data.roles;
  check('배역 이름이 그대로 복원된다', () => {
    const names = newRoles.map((r) => r.name);
    return assert.ok(names.includes('집사') && names.includes('정원사'), names.join(','));
  });

  const newLib = (await api('/api/gm/library', { headers: NGM })).data.files;
  check('한글 파일명이 보존된다', () => assert.ok(newLib.some((f) => f.name === '집사_1막.pdf')));
  check('자료가 원래 배역에 다시 붙는다', () => {
    const butlerId = newRoles.find((r) => r.name === '집사').id;
    const f = newLib.find((x) => x.name === '집사_1막.pdf');
    return assert.strictEqual(f.roleId, butlerId);
  });
  check('공용 자료는 공용으로 남는다', () =>
    assert.strictEqual(newLib.find((f) => f.name === '전체_지도.pdf').roleId, null));
  check('자료 순서가 유지된다', () =>
    assert.deepStrictEqual(newLib.map((f) => f.name), ['집사_1막.pdf', '전체_지도.pdf']));

  const copied = await fetch(`${BASE}/f/${newLib.find((f) => f.name === '집사_1막.pdf').id}?gm=${encodeURIComponent(newRoom.data.gmToken)}`);
  const copiedBody = Buffer.from(await copied.arrayBuffer());
  check('파일 원본이 그대로 옮겨진다', () =>
    assert.strictEqual(copiedBody.toString('utf8'), '%PDF-1.4 룸 셋팅용 자료'));

  const newTpls = (await api('/api/gm/ask-templates', { headers: NGM })).data.templates;
  check('질문지 템플릿이 복원된다', () => assert.ok(newTpls.some((t) => t.title === '룸 셋팅 질문')));

  const newPlayers = (await api('/api/gm/participants', { headers: NGM })).data.participants;
  check('플레이어는 따라오지 않는다', () => assert.strictEqual(newPlayers.length, 0));

  // 같은 룸 셋팅을 한 번 더 — 배역은 이름이 같으면 재사용하고 자료만 늘어난다
  const again = new FormData();
  again.append('bundle', new Blob([bundleBuf], { type: 'application/zip' }), 'pack.zip');
  const twice = await api('/api/gm/bundle/import', { method: 'POST', headers: NGM, form: again });
  check('같은 배역 이름은 새로 만들지 않는다', () => assert.strictEqual(twice.data.roles, 0));
  check('자료는 한 번 더 들어온다', () => assert.strictEqual(twice.data.files, 2));

  // 싹 바꾸기
  const replaceFd = new FormData();
  replaceFd.append('bundle', new Blob([bundleBuf], { type: 'application/zip' }), 'pack.zip');
  replaceFd.append('mode', 'replace');
  await api('/api/gm/bundle/import', { method: 'POST', headers: NGM, form: replaceFd });
  const afterReplace = (await api('/api/gm/library', { headers: NGM })).data.files;
  check('싹 바꾸기는 이전 자료를 남기지 않는다', () => assert.strictEqual(afterReplace.length, 2));

  // 망가진 룸 셋팅와 위험한 룸 셋팅
  const junk = new FormData();
  junk.append('bundle', new Blob([Buffer.from('이건 zip이 아닙니다')], { type: 'application/zip' }), 'x.zip');
  const junkRes = await api('/api/gm/bundle/import', { method: 'POST', headers: NGM, form: junk });
  check('zip이 아니면 거부한다 (400)', () => assert.strictEqual(junkRes.status, 400));

  const Zip = require('../src/zip.js');
  const evilPath = path.join(TMP, 'evil.zip');
  const ew = Zip.createWriter(fs.createWriteStream(evilPath));
  await ew.addBuffer('manifest.json', Buffer.from(JSON.stringify({
    format: 'mm-bundle', version: 1, roles: [],
    files: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: '나쁜파일.html', size: 4 }],
    askTemplates: [],
  }), 'utf8'));
  await ew.addBuffer('../../탈출.pdf', Buffer.from('escape'));
  await ew.addBuffer('files/aaaaaaaaaaaaaaaaaaaaaaaa.bin', Buffer.from('evil'));
  await ew.finish();
  const evilBuf = fs.readFileSync(evilPath);

  const beforeEvil = (await api('/api/gm/library', { headers: NGM })).data.files.length;
  const evilFd = new FormData();
  evilFd.append('bundle', new Blob([evilBuf], { type: 'application/zip' }), 'evil.zip');
  const evilRes = await api('/api/gm/bundle/import', { method: 'POST', headers: NGM, form: evilFd });
  check('보낼 수 없는 형식이 들었으면 거부한다 (415)', () => assert.strictEqual(evilRes.status, 415));
  const afterEvil = (await api('/api/gm/library', { headers: NGM })).data.files.length;
  check('거부된 룸 셋팅은 아무것도 남기지 않는다', () => assert.strictEqual(afterEvil, beforeEvil));
  check('룸 셋팅 바깥으로 파일이 빠져나가지 않는다', () =>
    assert.ok(!fs.existsSync(path.join(TMP, '탈출.pdf')) && !fs.existsSync(path.join(os.tmpdir(), '탈출.pdf'))));

  section(31, '모듈 구조');
  // 모듈은 폴더 하나다. 코어는 <데이터폴더>/modules 를 훑어 싣는다.
  const cat = await api('/api/modules');
  check('모듈 목록은 로그인 없이 볼 수 있다', () => assert.strictEqual(cat.status, 200));
  check('폴더에 넣어 둔 모듈이 실린다', () =>
    assert.ok(cat.data.modules.some((m) => m.id === 'demo')));
  check('앞에 _ 를 붙인 폴더는 안 실린다', () =>
    assert.ok(!cat.data.modules.some((m) => m.id === 'off')));
  check('목록에는 방 정보가 섞이지 않는다', () =>
    assert.ok(cat.data.modules.every((m) => !('enabled' in m) && !('roomId' in m))));

  const modFile = await fetch(`${BASE}/modules/demo.gm.js`);
  check('모듈이 자기 화면 파일을 내놓는다', () => assert.strictEqual(modFile.status, 200));

  const plainRoom = await api('/api/rooms', { method: 'POST', body: { name: '모듈 없음', gmNickname: 'GM' } });
  const PGM = { 'x-gm-token': plainRoom.data.gmToken };
  const plainMods = (await api('/api/gm/room', { headers: PGM })).data.room.modules;
  check('아무것도 안 고르면 꺼져 있다', () => assert.deepStrictEqual(plainMods, []));

  const offRead = await api('/api/gm/demo', { headers: PGM });
  check('모듈이 꺼진 방에서는 막힌다 (404)', () => assert.strictEqual(offRead.status, 404));
  const turnedOn = await api('/api/gm/modules', { method: 'PUT', headers: PGM, body: { id: 'demo', on: true } });
  check('모듈을 켤 수 있다', () => assert.deepStrictEqual(turnedOn.data.enabled, ['demo']));
  check('켠 뒤에는 조회된다', async () => {});
  const onRead = await api('/api/gm/demo', { headers: PGM });
  check('켜면 곧바로 쓸 수 있다 (재접속 불필요)', () => assert.strictEqual(onRead.status, 200));
  const turnedOff = await api('/api/gm/modules', { method: 'PUT', headers: PGM, body: { id: 'demo', on: false } });
  check('다시 끌 수 있다', () => assert.deepStrictEqual(turnedOff.data.enabled, []));
  const offAgain = await api('/api/gm/demo', { headers: PGM });
  check('끈 뒤에는 404', () => assert.strictEqual(offAgain.status, 404));

  const badId = await api('/api/gm/modules', { method: 'PUT', headers: PGM, body: { ids: ['demo', '없는모듈'] } });
  check('모르는 모듈 id는 조용히 버린다', () => assert.deepStrictEqual(badId.data.enabled, ['demo']));

  // 모듈을 켠 방에서만 소켓 이벤트가 듣는다
  const mRoom = await api('/api/rooms', {
    method: 'POST', body: { name: '시험 모듈 방', gmNickname: 'GM', modules: ['demo'] },
  });
  check('방을 만들 때 모듈을 켤 수 있다', () => assert.strictEqual(mRoom.status, 200));
  const mPeek = await api(`/api/rooms/by-code/${mRoom.data.room.code}`);
  check('방 밖에서는 어떤 모듈을 쓰는지 알 수 없다', () =>
    assert.strictEqual(mPeek.data.room.modules, undefined));
  const mJoin = await api(`/api/rooms/by-code/${mRoom.data.room.code}/join`,
    { method: 'POST', body: { nickname: '참가자' } });
  const mPlayer = await connect({ playerToken: mJoin.data.token });
  check('방에 들어오면 쓰는 법이 필요한 모듈은 알려준다', () =>
    assert.deepStrictEqual(mPlayer.hello.modules, ['demo']));
  const pinged = await ask(mPlayer.sock, 'mod:demo:ping', {});
  check('켜진 방에서는 모듈 이벤트가 듣는다', () => assert.strictEqual(pinged.pong, 'player'));
  // 모듈을 안 켜 둔 방을 따로 만들어 비교한다
  const offRoom = await api('/api/rooms', { method: 'POST', body: { name: '모듈 꺼진 방', gmNickname: 'GM' } });
  const offJoin = await api(`/api/rooms/by-code/${offRoom.data.room.code}/join`,
    { method: 'POST', body: { nickname: '딴방' } });
  const offPlayer = await connect({ playerToken: offJoin.data.token });
  const offPing = await ask(offPlayer.sock, 'mod:demo:ping', {});
  check('꺼진 방에서는 모듈 이벤트가 막힌다', () => assert.ok(offPing.error));
  [mPlayer, offPlayer].forEach((c) => c.sock.disconnect());

  const guides = await api('/api/modules/guides');
  check('가이드도 모듈을 따라온다', () =>
    assert.ok(guides.data.guides.some((g) => g.id === 'demo')));

  section(32, '자동 백업');
  const BK = require('../src/backup.js');
  const bkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-backup-'));
  const bkDir = path.join(bkRoot, '없던폴더');            // 폴더를 만들어 주는지도 함께 본다

  const bkOff = await BK.runBackup({});
  check('백업 폴더를 정하지 않으면 아무것도 하지 않는다', () =>
    assert.ok(bkOff.skipped && !bkOff.ok));

  const bk1 = await BK.runBackup({ dir: bkDir, keep: 2 });
  check('백업이 만들어진다', () => assert.ok(bk1.ok, bk1.error));
  check('없는 폴더는 만들어 준다', () => assert.ok(fs.existsSync(path.join(bkDir, 'db'))));

  // 스냅샷을 실제로 열어본다 — WAL 모드에서 최신 내용이 빠지지 않았는지가 핵심이다.
  const Database = require('better-sqlite3');
  const snap = new Database(bk1.snapshot, { readonly: true });
  const roomsInSnap = snap.prepare('SELECT code FROM rooms').all().map((r) => r.code);
  const msgCount = snap.prepare('SELECT COUNT(*) n FROM messages').get().n;
  snap.close();
  check('스냅샷을 열어 방 목록을 읽을 수 있다', () => assert.ok(roomsInSnap.length > 0));
  check('방금 만든 방이 스냅샷에 들어 있다', () => assert.ok(roomsInSnap.includes(room.code)));
  check('대화도 함께 들어 있다', () => assert.ok(msgCount > 0));

  const upFiles = fs.readdirSync(path.join(bkDir, 'uploads'));
  check('올린 자료가 복사된다', () => assert.ok(upFiles.length > 0));
  check('복사본 내용이 원본과 같다', () => {
    const one = upFiles[0];
    return assert.deepStrictEqual(
      fs.readFileSync(path.join(bkDir, 'uploads', one)),
      fs.readFileSync(path.join(TMP, 'uploads', one)));
  });
  check('임시 파일이 남지 않는다', () =>
    assert.ok(![...fs.readdirSync(path.join(bkDir, 'db')), ...upFiles].some((n) => n.endsWith('.tmp'))));

  const bk2 = await BK.runBackup({ dir: bkDir, keep: 2 });
  check('두 번째부터는 이미 있는 자료를 건너뛴다', () =>
    assert.ok(bk2.copied === 0 && bk2.skipped > 0));

  const bk3 = await BK.runBackup({ dir: bkDir, keep: 2 });
  check('세 번 돌려도 모두 성공한다', () => assert.ok(bk3.ok));
  const snaps = fs.readdirSync(path.join(bkDir, 'db')).filter((n) => n.endsWith('.sqlite'));
  check('보관 개수를 넘으면 오래된 것부터 지운다', () => assert.strictEqual(snaps.length, 2));

  // 폴더 자리에 파일을 두면 만들 수 없다 — 그래도 서버는 멀쩡해야 한다.
  const bkBlocked = path.join(bkRoot, '막힌곳');
  fs.writeFileSync(bkBlocked, 'not a directory');
  const bkFail = await BK.runBackup({ dir: bkBlocked, keep: 2 });
  check('쓸 수 없는 곳이면 예외 없이 실패를 알린다', () => assert.ok(!bkFail.ok && bkFail.error));

  // 백업 폴더가 데이터 폴더 안이면 백업이 백업을 복사하게 되므로 막는다.
  process.env.BACKUP_DIR = path.join(TMP, 'self');
  check('데이터 폴더 안은 백업 대상이 될 수 없다', () =>
    assert.strictEqual(BK.resolveConfig().reason, 'inside-data'));
  delete process.env.BACKUP_DIR;
  fs.rmSync(bkRoot, { recursive: true, force: true });

  section(35, '방 닫기');
  await api('/api/gm/close', { method: 'POST', headers: GM });
  await sleep(200);
  const afterClose = await api(`/api/rooms/by-code/${room.code}/join`, { method: 'POST', body: { nickname: '지각생', password: P } });
  check('닫힌 방에는 입장 불가 (410)', () => assert.strictEqual(afterClose.status, 410));
  // '닫기'는 세션 종료가 아니라 플레이어를 멈추는 것이다. GM은 계속 쓸 수 있어야 한다.
  const sendAfter = await api('/api/gm/send', { method: 'POST', headers: GM, body: { targets: [A.participant.id], body: 'x' } });
  check('닫혀 있어도 GM은 보낼 수 있다', () => assert.strictEqual(sendAfter.status, 200));

  const reopened = await api('/api/gm/close', { method: 'POST', headers: GM, body: { closed: false } });
  check('방을 다시 열 수 있다', () => assert.strictEqual(reopened.data.closed, false));
  const rejoin = await api(`/api/rooms/by-code/${room.code}/join`, { method: 'POST', body: { nickname: '지각생', password: P } });
  check('다시 열면 입장된다', () => assert.strictEqual(rejoin.status, 200));

  const closedAgain = await api('/api/gm/close', { method: 'POST', headers: GM, body: { closed: true } });
  check('다시 닫을 수 있다', () => assert.strictEqual(closedAgain.data.closed, true));

  section(35, '방 삭제');
  const badCode = await api('/api/gm/room', { method: 'DELETE', headers: GM, body: { confirmCode: '아무거나' } });
  check('코드가 틀리면 안 지워진다 (400)', () => assert.strictEqual(badCode.status, 400));
  // 화면에서는 방 코드를 감췄으므로, 세션 이름으로도 지울 수 있어야 한다.
  const tossRoom = await api('/api/rooms', { method: 'POST', body: { name: '이름으로 지울 방', gmNickname: 'GM' } });
  const TOSS = { 'x-gm-token': tossRoom.data.gmToken };
  const wrongName = await api('/api/gm/room', { method: 'DELETE', headers: TOSS, body: { confirmCode: '다른 이름' } });
  check('이름이 틀리면 안 지워진다 (400)', () => assert.strictEqual(wrongName.status, 400));
  const byName = await api('/api/gm/room', { method: 'DELETE', headers: TOSS, body: { confirmCode: '이름으로 지울 방' } });
  check('세션 이름으로 지울 수 있다', () => assert.strictEqual(byName.status, 200));

  const { db: tdb, UPLOAD_DIR: TUP } = require('../src/db.js');
  const storedBefore = tdb.prepare('SELECT stored FROM files WHERE room_id = ?').all(room.id).map((f) => f.stored);
  const gone = await api('/api/gm/room', { method: 'DELETE', headers: GM, body: { confirmCode: room.code } });
  check('코드가 맞으면 지워진다', () => assert.strictEqual(gone.status, 200));
  const after = await api(`/api/rooms/by-code/${room.code}`);
  check('지운 방은 찾을 수 없다 (404)', () => assert.strictEqual(after.status, 404));
  await sleep(300);
  check('올린 파일도 디스크에서 지워진다', () => {
    assert.ok(storedBefore.length > 0);
    assert.ok(storedBefore.every((s) => !fs.existsSync(path.join(TUP, s))));
  });

  section(35, '자동 정리');
  const { sweep, GRACE_DAYS } = require('../src/cleanup.js');
  const mk = async (name) => (await api('/api/rooms', { method: 'POST', body: { name, gmNickname: 'GM' } })).data.room;
  const oldRoom = await mk('오래된 방');
  const recentExpired = await mk('막 만료된 방');
  const liveRoom = await mk('살아있는 방');
  const DAYMS = 86400_000;
  tdb.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?').run(Date.now() - (GRACE_DAYS + 1) * DAYMS, oldRoom.id);
  tdb.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?').run(Date.now() - 2 * DAYMS, recentExpired.id);
  const swept = sweep();
  check('보관 기간 + 유예 기간이 지난 방만 지운다', () =>
    assert.deepStrictEqual(swept.map((r) => r.id), [oldRoom.id]));
  const oldAfter = await api(`/api/rooms/by-code/${oldRoom.code}`);
  check('오래된 방은 사라졌다', () => assert.strictEqual(oldAfter.status, 404));
  const recentAfter = await api(`/api/rooms/by-code/${recentExpired.code}`);
  check('막 만료된 방은 유예 기간 동안 남아 있다', () => assert.strictEqual(recentAfter.status, 200));
  const liveAfter = await api(`/api/rooms/by-code/${liveRoom.code}`);
  check('만료 전 방은 그대로다', () => assert.strictEqual(liveAfter.status, 200));

  console.log(`\n${process.exitCode ? '실패 있음' : '전부 통과'} — ${pass}개 확인\n`);

  [gm, gm2, a2, a3, b].forEach((c) => c.sock.disconnect());
  await sleep(400); // 소켓 정리가 끝난 뒤에 DB를 닫는다
  await cleanup(server);
  process.exit(process.exitCode || 0);
})().catch(async (e) => {
  console.error('테스트 중단:', e);
  await cleanup();
  process.exit(1);
});

/** SQLite 핸들을 닫아야 Windows에서 임시 폴더를 지울 수 있다. */
async function cleanup(server) {
  try { server?.close(); } catch {}
  try { require('../src/db.js').db.close(); } catch {}
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

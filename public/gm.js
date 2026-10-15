/* GM 대시보드 */
'use strict';
const $ = (id) => document.getElementById(id);

// GM 링크는 /gm.html#<roomId>:<linkToken>. 프래그먼트라 서버로 전송되지 않는다.
const [ROOM_ID, LINK_TOKEN] = (location.hash.slice(1) || '').split(':');
const SESSION_KEY = `mm.gm.${ROOM_ID}`;
const COMMON = '__common';                 // 배역에 속하지 않는 공용 자료함
const GM_ALL = 'all';                      // GM 전체방 채널
const stars = MM.bookmarks(`mm.star.gm.${ROOM_ID}`);

let socket = null;
let room = null;
let myGm = null;                           // { id, nickname }
let sidebarPanel = null;                   // 좌우 칸 조절 손잡이 (모듈이 넓게 보기에 쓴다)
let rightPanel = null;
let MY_ACTOR = '';                         // 표시(반응)에서 '나'를 가리키는 값
let participants = [];
let gms = [];
let roles = [];
let libFiles = [];
let viewRoleId = COMMON;
const selected = new Set();                // 체크된 발송 대상 (플레이어)
let openThreadId = null;                   // 열린 플레이어 스레드
let openGmChannel = null;                  // 열린 GM 대화 ('all' 또는 상대 GM id)
const threadCache = new Map();
const gmCache = new Map();
let typingTimer = null, lastSentTyping = false;
let timer = null;
let npcName = '';
const askCache = new Map();     // pollId -> 집계

// 쓰다 만 글은 대화마다 따로 둔다. 하나를 같이 쓰면 GM 대화에 쓰던 글이
// 플레이어 창으로 따라와 그대로 나가는 사고가 난다.
const drafts = new Map();       // 'p:<참가자id>' | 'gm:<채널>' -> 쓰던 글
const draftKey = () => (openGmChannel ? `gm:${openGmChannel}` : openThreadId ? `p:${openThreadId}` : '');

/** 지금 대화의 초안을 담아두고 입력창을 비운다. */
function stashDraft() {
  const key = draftKey();
  if (!key) return;
  const text = $('input').value;
  if (text.trim()) drafts.set(key, text); else drafts.delete(key);
  $('input').value = '';
}

/** 옮겨간 대화에서 쓰던 글을 되살린다. */
function restoreDraft() {
  const key = draftKey();
  $('input').value = (key && drafts.get(key)) || '';
  MM.autoGrow($('input'));
}

const token = () => localStorage.getItem(SESSION_KEY);
const AUTH = () => ({ 'x-gm-token': token() });

// ── 부팅 ─────────────────────────────────────────────────────────────────────
(async function boot() {
  if (!ROOM_ID || !LINK_TOKEN) return fail('링크에 인증 정보가 없습니다');

  let roomInfo;
  try {
    roomInfo = (await MM.api(`/api/rooms/by-id/${ROOM_ID}?link=${encodeURIComponent(LINK_TOKEN)}`)).room;
  } catch (e) {
    return fail(e.message);
  }

  if (token()) {
    try {
      const meRes = await MM.api('/api/gm/me', { headers: AUTH() });
      myGm = meRes.gm;
      gms = meRes.gms;
      return enter();
    } catch {
      localStorage.removeItem(SESSION_KEY);   // 만료된 세션
    }
  }

  $('gateMsg').textContent = `${roomInfo.name} — GM으로 입장합니다`;
  if (roomInfo.hasGmPassword) $('gmPassField').classList.remove('hidden');
  $('loginForm').classList.remove('hidden');
  (roomInfo.hasGmPassword ? $('gmPass') : $('gmNick')).focus();
})();

$('gmEnterBtn').addEventListener('click', async () => {
  const nickname = $('gmNick').value.trim();
  if (!nickname) { $('gateErr').textContent = '닉네임을 입력해 주세요'; return; }
  $('gmEnterBtn').disabled = true;
  $('gateErr').textContent = '';
  MM.Sound.unlock();
  MM.Desktop.ask();
  try {
    const res = await MM.api('/api/gm/login', {
      method: 'POST',
      body: { roomId: ROOM_ID, linkToken: LINK_TOKEN, password: $('gmPass').value, nickname },
    });
    localStorage.setItem(SESSION_KEY, res.token);
    myGm = res.gm;
    enter();
  } catch (e) {
    $('gateErr').textContent = e.message;
    $('gmEnterBtn').disabled = false;
  }
});
$('gmNick').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gmEnterBtn').click(); });
$('gmPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gmNick').focus(); });

async function enter() {
  try {
    room = (await MM.api('/api/gm/room', { headers: AUTH() })).room;
    participants = (await MM.api('/api/gm/participants', { headers: AUTH() })).participants;
    gms = (await MM.api('/api/gm/gms', { headers: AUTH() })).gms;
  } catch (e) {
    return fail(e.message);
  }
  MY_ACTOR = `gm:${myGm.id}`;
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('roomName').textContent = room.name;
  MM.Title.setBase(`GM — ${room.name}`);
  paintPasswords();
  paintMe();
  paintRoomState();
  await MM.Sound.loadPresets();      // 서버에 깔아 둔 알림음·표시를 먼저 읽는다
  MM.mountSoundPicker($('soundKit'), $('soundBtn'), $('soundVol'));
  MM.enableLightbox($('msgs'));
  MM.enableLightbox($('starList'));

  // 말풍선에 마우스를 올리면 나오는 표시 버튼
  MM.mountReactions($('msgs'), {
    onToggle: (messageId, emoji) => socket?.emit('reaction:toggle',
      { scope: openGmChannel ? 'gm' : 'msg', messageId, emoji },
      (res) => { if (res?.error) MM.toast(res.error, true); }),
  });
  renderStars();

  const h = location.hostname;
  const localOnly = h === 'localhost' || h === '127.0.0.1' || h === '::1'
    || /^10\./.test(h) || /^192\.168\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /\.local$/.test(h);
  if (localOnly) $('localWarn').classList.remove('hidden');

  renderParticipants();
  mountMyColor();
  renderGms();
  connect();
  await loadRoles();
  await loadLibrary();

  // 켜 둔 모듈의 화면을 붙인 뒤 탭 정리를 켠다 (모듈 탭까지 포함해서 다루도록)
  loadModulePanels().then(() =>
    MM.mountTabs($('rtabs'), { key: `gm.${ROOM_ID}`, tabAttr: 'rtab', panelAttr: 'rpanel' }));

  MM.makeSortable($('plist'), '.pitem', saveParticipantOrder);
  MM.makeSortable($('libList'), '.lib-item', saveLibraryOrder);

  // 좌우 패널 너비 조절 + 접기
  // 오른쪽 칸은 모듈(TRPG 무대 등)을 크게 보고 싶을 때가 있어 창 크기까지 넓힐 수 있게 둔다.
  // 가운데 1:1 대화는 최소 폭만 남는다.
  sidebarPanel = MM.makeResizable(document.querySelector('.sidebar'),
    { side: 'left', key: 'gm.sidebar', min: 200, max: 520, toggleEl: $('toggleLeft') });
  rightPanel = MM.makeResizable(document.querySelector('.rightbar'), {
    side: 'right', key: 'gm.rightbar', min: 220, toggleEl: $('toggleRight'),
    max: () => Math.max(620, window.innerWidth - 300),
  });

  // 대화창에 그냥 끌어다 놓으면 바로 발송한다 (자료함을 거치지 않는다)
  timer = MM.mountTimer($('timerBar'), {
    keepVisible: true,
    onDone: (t) => {
      MM.Sound.play(t.sound || 'alert');
      MM.alertIncoming('시간 종료', t.label || '라운드가 끝났습니다', 'timer');
    },
  });
  mountTimerControls();
  mountNpc();
  loadAskTemplates();

  MM.makeDropzone($('msgs'), dropSend, () => {
    if (openGmChannel) return 'GM 대화에 바로 보냅니다';
    const names = participants.filter((p) => selected.has(p.id)).map((p) => p.nickname);
    if (names.length === 0) return null;
    return names.length === 1
      ? `${names[0]} 님에게 바로 보냅니다`
      : `${names.length}명에게 바로 보냅니다`;
  });

  document.addEventListener('click', () => MM.Sound.unlock(), { once: true });
  document.addEventListener('keydown', () => MM.Sound.unlock(), { once: true });
}

function fail(msg) {
  $('gateMsg').textContent = '접속할 수 없습니다';
  $('loginForm').classList.add('hidden');
  $('gateErr').textContent = msg;
}

// 어깨너머로 보이지 않게 기본은 가려 둔다. 눈 아이콘을 누르면 보인다.
const shownPass = { room: false, gm: false };

const EYE_ON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" '
  + 'stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" '
  + 'stroke-width="2"><path d="M1 12s4-7 11-7c2.2 0 4.1.7 5.7 1.6M23 12s-4 7-11 7c-2.2 0-4.1-.7-5.7-1.6"/>'
  + '<path d="M9.9 9.9a3 3 0 104.2 4.2"/><path d="M2 2l20 20"/></svg>';

function paintPasswords() {
  const mask = (v, show) => (!v ? '없음' : show ? v : '•'.repeat(Math.min(v.length, 8)));
  $('passText').textContent = mask(room.password, shownPass.room);
  $('gmPassText').textContent = mask(room.gmPassword, shownPass.gm);
  $('passEye').innerHTML = shownPass.room ? EYE_OFF : EYE_ON;
  $('gmPassEye').innerHTML = shownPass.gm ? EYE_OFF : EYE_ON;
  $('passEye').title = shownPass.room ? '암호 가리기' : '암호 보기';
  $('gmPassEye').title = shownPass.gm ? 'GM 암호 가리기' : 'GM 암호 보기';
}

$('passEye').addEventListener('click', () => { shownPass.room = !shownPass.room; paintPasswords(); });
$('gmPassEye').addEventListener('click', () => { shownPass.gm = !shownPass.gm; paintPasswords(); });
function paintMe() {
  $('myName').textContent = myGm.nickname;
  $('myName').style.color = myGm.color || '';
}

/** 내 이름 색. 다른 GM·플레이어도 같은 색으로 본다. */
function mountMyColor() {
  MM.mountColorPick($('myColorPick'), {
    value: myGm.color,
    save: async (color) => {
      try {
        const res = await MM.api('/api/gm/me/color', { method: 'PUT', headers: AUTH(), body: { color } });
        myGm.color = res.color;
        paintMe();
      } catch (e) { MM.toast(e.message, true); }
    },
  });
}

/** 방이 닫혀 있으면 버튼이 '방 열기'가 되고, 위쪽에 표시가 남는다. */
function paintRoomState() {
  const closed = !!room.closed;
  $('closeRoomBtn').textContent = closed ? '▶ 방 열기' : '방 닫기';
  $('closeRoomBtn').classList.toggle('primary', closed);
  $('closeRoomBtn').classList.toggle('ghost', !closed);

  // 입장 잠금은 '난입 방지'용이라 방 닫기와 다르다 — 이미 들어온 사람은 그대로 쓴다.
  const locked = !!room.joinLocked;
  $('lockJoinBtn').textContent = locked ? '🔒 입장 잠김' : '🔓 입장 열림';
  $('lockJoinBtn').classList.toggle('danger', locked);
  $('lockJoinBtn').classList.toggle('ghost', !locked);

  const tags = [closed ? '닫힘' : null, locked ? '입장 잠김' : null].filter(Boolean);
  $('roomName').textContent = room.name + (tags.length ? ` (${tags.join(' · ')})` : '');
}

$('lockJoinBtn').addEventListener('click', async () => {
  const next = !room.joinLocked;
  try {
    const res = await MM.api('/api/gm/lock', { method: 'POST', headers: AUTH(), body: { locked: next } });
    room.joinLocked = res.locked;
    paintRoomState();
    MM.toast(res.locked
      ? '입장을 잠갔습니다 — 새로 들어올 수 없습니다 (지금 있는 사람은 그대로)'
      : '입장을 다시 열었습니다');
  } catch (e) { MM.toast(e.message, true); }
});

$('changePass').addEventListener('click', async (e) => {
  e.preventDefault();
  const next = prompt('새 입장 암호 (비우면 암호 없이 입장)', room.password || '');
  if (next === null) return;
  try {
    const res = await MM.api('/api/gm/password', { method: 'PUT', headers: AUTH(), body: { password: next } });
    room.password = res.password;
    paintPasswords();
    MM.toast(res.password ? '암호를 바꿨습니다 — 플레이어에게 알려주세요' : '암호를 없앴습니다');
  } catch (err) { MM.toast(err.message, true); }
});

$('renameMe').addEventListener('click', async (e) => {
  e.preventDefault();
  const next = prompt('새 GM 닉네임', myGm.nickname);
  if (next === null) return;
  try {
    const res = await MM.api('/api/gm/me/nickname', { method: 'PUT', headers: AUTH(), body: { nickname: next } });
    myGm.nickname = res.nickname;
    paintMe();
    MM.toast('닉네임을 바꿨습니다');
  } catch (err) { MM.toast(err.message, true); }
});

$('copyGmInvite').addEventListener('click', async (e) => {
  e.preventDefault();
  await MM.copyAndTell(location.href, room.gmPassword
    ? 'GM 링크를 복사했습니다 — GM 암호도 함께 알려주세요'
    : 'GM 링크를 복사했습니다');
});

// ── 소켓 ─────────────────────────────────────────────────────────────────────
function connect() {
  socket = io({ auth: { gmToken: token() } });

  socket.on('connect', () => setConn('연결됨', true));
  socket.on('disconnect', () => setConn('재연결 중…', false));
  socket.on('connect_error', () => setConn('재연결 중…', false));
  socket.on('auth:error', ({ error }) => fail(error));

  socket.on('message', (m) => {
    const list = threadCache.get(m.threadId);
    if (list) list.push(m);

    if (m.threadId === openThreadId) {
      const atBottom = isAtBottom();
      appendMessage(m);
      if (atBottom || m.sender === 'gm') scrollDown();
      if (m.sender === 'player') socket.emit('gm:open', { participantId: m.threadId });
    } else if (m.sender === 'player') {
      const p = participants.find((x) => x.id === m.threadId);
      if (p) p.unread = (p.unread || 0) + 1;
      renderParticipants();
    }

    if (m.sender === 'player') {
      MM.alertIncoming(m.senderName || '플레이어',
        m.body || (m.file ? `📎 ${m.file.name}` : ''), m.threadId);
    }
  });

  // GM끼리의 대화
  socket.on('gm:message', (m) => {
    const key = m.channel === GM_ALL ? GM_ALL : m.channel;
    const list = gmCache.get(key);
    if (list) list.push(m);

    const viewing = openGmChannel && channelKeyOf(openGmChannel) === key;
    if (viewing) {
      const atBottom = isAtBottom();
      appendGmMessage(m);
      if (atBottom || m.fromGmId === myGm.id) scrollDown();
    } else if (m.fromGmId !== myGm.id) {
      bumpGmUnread(key);
    }
    if (m.fromGmId !== myGm.id) {
      MM.alertIncoming(`${m.senderName} (GM)`, m.body || '', 'gmchat');
    }
  });

  // 대화에 붙인 표시
  socket.on('reaction', ({ scope, messageId, threadId, reactions }) => {
    const pool = scope === 'gm'
      ? [...gmCache.values()]
      : [threadCache.get(threadId) || []];
    for (const list of pool) {
      const hit = list.find((m) => m.id === messageId);
      if (hit) hit.reactions = reactions;
    }
    const el = document.querySelector(`.msg[data-id="${messageId}"] .rx`);
    if (el) el.outerHTML = MM.reactionsHtml(reactions, MY_ACTOR);
  });

  socket.on('gm:message:deleted', ({ id, channel }) => {
    const list = gmCache.get(channel);
    const hit = list?.find((m) => m.id === id);
    if (hit) { hit.deleted = true; hit.body = null; delete hit.file; }
    const el = document.querySelector(`.msg[data-id="${id}"]`);
    if (el) el.remove();
    stars.remove(id);
    renderStars();
  });

  socket.on('message:deleted', ({ id, threadId }) => {
    const hit = threadCache.get(threadId)?.find((m) => m.id === id);
    if (hit) { hit.deleted = true; hit.body = null; delete hit.file; }
    const el = document.querySelector(`.msg[data-id="${id}"]`);
    if (el) renderDeleted(el);
    stars.remove(id);
    renderStars();
  });

  socket.on('participant:kicked', ({ id, nickname }) => {
    participants = participants.filter((p) => p.id !== id);
    selected.delete(id);
    threadCache.delete(id);
    if (openThreadId === id) {           // 보고 있던 대화라면 빈 화면으로 돌아간다
      openThreadId = null;
      $('threadName').textContent = '플레이어를 선택하세요';
      $('threadSub').textContent = '';
      $('msgs').innerHTML = '<div class="empty">내보낸 플레이어입니다.</div>';
    }
    renderParticipants();
    MM.toast(`${nickname} 님이 목록에서 빠졌습니다`);
  });

  socket.on('room:lock', ({ locked }) => {
    room.joinLocked = locked;
    paintRoomState();
  });

  socket.on('participant:joined', (p) => {
    if (!participants.some((x) => x.id === p.id)) {
      participants.push(p);
      renderParticipants();
      MM.toast(`${p.nickname} 님이 입장했습니다 — 배역을 배정하세요`);
      MM.alertIncoming('입장', `${p.nickname} 님이 입장했습니다`, 'join');
    }
  });

  socket.on('participant:renamed', (p) => {
    const hit = participants.find((x) => x.id === p.id);
    if (hit) Object.assign(hit, p);
    renderParticipants();
    if (p.id === openThreadId) openThread(p.id, true);
  });

  socket.on('participant:presence', ({ id, online }) => {
    const p = participants.find((x) => x.id === id);
    if (p) { p.online = online; renderParticipants(); }
  });

  socket.on('gm:joined', (g) => {
    if (!gms.some((x) => x.id === g.id)) {
      gms.push(g);
      renderGms();
      MM.toast(`GM ${g.nickname} 님이 들어왔습니다`);
    }
  });
  socket.on('gm:changed', ({ gms: fresh }) => { gms = fresh; renderGms(); });
  socket.on('gm:presence', ({ id, online }) => {
    const g = gms.find((x) => x.id === id);
    if (g) { g.online = online; renderGms(); }
  });

  socket.on('names:changed', async () => {
    try {
      participants = (await MM.api('/api/gm/participants', { headers: AUTH() })).participants;
      gms = (await MM.api('/api/gm/gms', { headers: AUTH() })).gms;
    } catch { }
    renderParticipants();
    renderGms();
    threadCache.clear();
    gmCache.clear();
    if (openThreadId) openThread(openThreadId, true);
    else if (openGmChannel) openGmChat(openGmChannel, true);
  });

  socket.on('thread:read', ({ threadId }) => {
    const list = threadCache.get(threadId);
    if (list) list.forEach((m) => { if (m.sender !== 'player') m.readByPlayer = true; });
    if (threadId === openThreadId) renderThread(threadId);
  });

  socket.on('typing', ({ threadId, on }) => {
    if (threadId !== openThreadId) return;
    const p = participants.find((x) => x.id === threadId);
    $('typing').textContent = on ? `${p?.nickname || '플레이어'} 님이 입력 중…` : '';
  });

  socket.on('timer', (t) => timer.set(t));

  socket.on('ask:update', (poll) => {
    if (!poll) return;
    // 가장 최근 답 시각이 바뀌면 새 답이나 수정이 들어온 것이다.
    const latest = (d) => Math.max(0, ...(d?.people || []).flatMap(
      (p) => p.answers.flatMap((a) => (a || []).map((x) => x.createdAt))));
    const before = latest(askCache.get(poll.id));
    askCache.set(poll.id, poll);
    paintAsk(poll.id);
    if (latest(poll) > before) {
      MM.alertIncoming('답변 도착', `${poll.question} — 제출 ${poll.doneCount}/${poll.askedCount}명`, 'ask');
    }
  });

  socket.on('ask:closed', ({ pollId }) => {
    if (askCache.has(pollId)) refreshAsk(pollId);
  });

  socket.on('room:state', ({ closed }) => {
    room.closed = closed;
    paintRoomState();
    MM.toast(closed ? '방을 닫았습니다 — 플레이어가 보낼 수 없습니다' : '방을 다시 열었습니다');
  });

  socket.on('room:deleted', () => {
    alert('이 방이 삭제되었습니다.');
    location.href = '/';
  });
}

// ── 타이머 조작 ──────────────────────────────────────────────────────────────
/** "10" → 10분, "1:30" → 1분 30초 */
function parseTime(text) {
  const t = String(text || '').trim();
  if (!t) return NaN;
  if (t.includes(':')) {
    const [m, s] = t.split(':');
    return (Number(m) * 60 + Number(s || 0)) * 1000;
  }
  return Number(t) * 60 * 1000;
}

async function timerCmd(action, extra = {}) {
  try {
    const res = await MM.api('/api/gm/timer', {
      method: 'POST', headers: AUTH(),
      body: { action, label: $('tmLabel').value, sound: $('tmSound').value, ...extra },
    });
    timer.set(res.timer);
  } catch (e) { MM.toast(e.message, true); }
}

// ── NPC 이름으로 말하기 ──────────────────────────────────────────────────────
const NPC_KEY = `mm.npc.${ROOM_ID}`;

function mountNpc() {
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem(NPC_KEY) || '[]'); } catch { }
  const paint = () => {
    $('npcList').innerHTML = recent.map((n) => `<option value="${MM.esc(n)}">`).join('');
  };
  paint();

  $('npcName').addEventListener('change', () => {
    npcName = $('npcName').value.trim().slice(0, 30);
    $('npcName').classList.toggle('on', !!npcName);
    if (npcName && !recent.includes(npcName)) {
      recent.unshift(npcName);
      recent = recent.slice(0, 12);
      try { localStorage.setItem(NPC_KEY, JSON.stringify(recent)); } catch { }
      paint();
    }
    MM.toast(npcName ? `이제 "${npcName}" 이름으로 나갑니다` : `내 이름(${myGm.nickname})으로 돌아왔습니다`);
  });
  $('npcName').addEventListener('input', () => { npcName = $('npcName').value.trim().slice(0, 30); });
}

// ── 배역별 일괄 발송 ─────────────────────────────────────────────────────────
$('roleBatchBtn').addEventListener('click', async () => {
  try {
    const { plan } = await MM.api('/api/gm/send-role-batch/preview', { headers: AUTH() });
    const willSend = plan.filter((p) => p.file);
    if (willSend.length === 0) {
      return MM.toast('보낼 자료가 없습니다 (배역 배정과 자료함을 확인하세요)', true);
    }
    const lines = willSend.map((p) => `· ${p.role} → ${p.to} : ${p.file}`);
    const skipped = plan.filter((p) => !p.file).map((p) => `· ${p.role} — ${p.reason}`);
    const msg = `다음 자료를 보냅니다.\n\n${lines.join('\n')}` +
      (skipped.length ? `\n\n[건너뜀]\n${skipped.join('\n')}` : '') + '\n\n계속할까요?';
    if (!confirm(msg)) return;

    const res = await MM.api('/api/gm/send-role-batch', { method: 'POST', headers: AUTH() });
    MM.Sound.play('send');
    MM.toast(`${res.sent.length}명에게 보냈습니다`);
    await loadLibrary();          // '다음 발송' 표시를 옮긴다
  } catch (e) { MM.toast(e.message, true); }
});

// ── 질문지 보관함 ────────────────────────────────────────────────────────────
let askTemplates = [];

async function loadAskTemplates() {
  try {
    askTemplates = (await MM.api('/api/gm/ask-templates', { headers: AUTH() })).templates;
  } catch { askTemplates = []; }
  renderAskTemplates();
}

function renderAskTemplates() {
  $('askTplList').innerHTML = askTemplates.length === 0
    ? '<div class="empty">저장해 둔 질문지가 없습니다.</div>'
    : askTemplates.map((t) => `
      <div class="lib-item" data-id="${t.id}">
        <div class="nm">❓ ${MM.esc(t.title)}</div>
        <div class="faint" style="margin-bottom:6px">${t.items.length}문항</div>
        <div class="acts">
          <button class="primary" data-asksend="${t.id}">선택한 사람에게 보내기</button>
          <button class="ghost" data-asktpldel="${t.id}">삭제</button>
        </div>
      </div>`).join('');
}

$('askSaveBtn').addEventListener('click', async () => {
  const title = $('askTitle').value.trim();
  if (!title) return MM.toast('제목을 입력해 주세요', true);
  const items = $('askItems').value.split('\n')
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
  try {
    askTemplates = (await MM.api('/api/gm/ask-templates', {
      method: 'POST', headers: AUTH(), body: { title, items },
    })).templates;
    $('askTitle').value = ''; $('askItems').value = '';
    renderAskTemplates();
    MM.toast('질문지를 저장했습니다');
  } catch (e) { MM.toast(e.message, true); }
});

$('askTplList').addEventListener('click', async (e) => {
  const sendId = e.target.dataset?.asksend;
  const delId = e.target.dataset?.asktpldel;
  if (sendId) return sendAsk({ templateId: sendId });
  if (delId) {
    if (!confirm('이 질문지를 지울까요?')) return;
    try {
      askTemplates = (await MM.api(`/api/gm/ask-templates/${delId}`, {
        method: 'DELETE', headers: AUTH(),
      })).templates;
      renderAskTemplates();
    } catch (err) { MM.toast(err.message, true); }
  }
});

function mountTimerControls() {
  $('tmSound').innerHTML = MM.Sound.list
    .map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  $('tmSound').value = 'alert';

  $('tmStart').addEventListener('click', () => {
    const ms = parseTime($('tmMinutes').value);
    // 시간을 적었으면 그 시간으로 새로 시작하고, 비었으면 남은 시간부터 이어간다.
    timerCmd('start', Number.isFinite(ms) && ms > 0 ? { ms } : {});
  });
  $('tmPause').addEventListener('click', () => timerCmd('pause'));
  $('tmReset').addEventListener('click', () => timerCmd('reset'));
  $('tmClear').addEventListener('click', () => timerCmd('clear'));
  $('tmMinutes').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('tmStart').click(); }
  });
  $('tmSound').addEventListener('change', () => {
    MM.Sound.preview($('tmSound').value);
    timerCmd('sound-only');
  });
  $('tmLabel').addEventListener('change', () => timerCmd('label-only'));
}

function setConn(text, ok) {
  const el = $('connChip');
  el.textContent = text;
  el.classList.toggle('on', !!ok);
}

// ── 플레이어 목록 ────────────────────────────────────────────────────────────
function renderParticipants() {
  const list = $('plist');
  if (participants.length === 0) {
    list.innerHTML = '<div class="empty">아직 입장한 플레이어가 없습니다.<br>플레이어 링크를 배포하세요.</div>';
    updateTargetChip();
    return;
  }
  const roleOptions = (current) =>
    ['<option value="">— 배역 없음 —</option>']
      .concat(roles.map((r) => {
        const takenBy = r.holder && r.holder.id !== current ? ` (${r.holder.nickname})` : '';
        return `<option value="${r.id}"${r.id === current ? ' selected' : ''}>${MM.esc(r.name)}${MM.esc(takenBy)}</option>`;
      })).join('');

  // 끌어서 정한 순서를 그대로 쓴다 — 자동 정렬하면 자리가 계속 바뀐다.
  list.innerHTML = participants.map((p) => `
    <div class="pitem${p.id === openThreadId ? ' active' : ''}" data-id="${p.id}" draggable="true">
      <span class="grip" title="끌어서 순서 변경">⠿</span>
      <input type="checkbox" data-check="${p.id}" ${selected.has(p.id) ? 'checked' : ''}>
      <span class="dot${p.online ? ' on' : ''}" title="${p.online ? '접속 중' : '오프라인'}"></span>
      <span class="pname"${p.color ? ` style="color:${p.color}"` : ''}>${MM.esc(p.nickname)}
        ${p.roleName ? `<span class="rolechip">${MM.esc(p.roleName)}</span>` : ''}</span>
      ${p.unread ? `<span class="badge">${p.unread}</span>` : ''}
      <select class="roleassign" data-assign="${p.id}" title="배역 배정">${roleOptions(p.roleId)}</select>
      <button class="kick" data-kick="${p.id}" title="이 플레이어를 내보내기">⨯</button>
    </div>`).join('');
  updateTargetChip();
}

async function saveParticipantOrder(ids) {
  participants.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  try {
    await MM.api('/api/gm/participants/order', { method: 'PUT', headers: AUTH(), body: { ids } });
  } catch (e) { MM.toast(e.message, true); }
}

$('plist').addEventListener('change', async (e) => {
  const pid = e.target.dataset?.assign;
  if (!pid) return;
  try {
    const { roles: fresh } = await MM.api(`/api/gm/participants/${pid}/role`, {
      method: 'PUT', headers: AUTH(), body: { roleId: e.target.value || null },
    });
    roles = fresh;
    participants = (await MM.api('/api/gm/participants', { headers: AUTH() })).participants;
    renderParticipants();
    renderRoleSelect();
    renderLibrary();
    if (pid === openThreadId) followThreadRole(pid);
  } catch (err) { MM.toast(err.message, true); }
});

$('plist').addEventListener('click', async (e) => {
  const kickId = e.target.dataset?.kick;
  if (kickId) {
    e.stopPropagation();
    const p = participants.find((x) => x.id === kickId);
    if (!confirm(`${p?.nickname || '이 플레이어'} 님을 내보냅니다.\n\n`
      + '바로 접속이 끊기고 목록에서 사라집니다. 대화 기록은 남습니다.\n'
      + '다시 들어오지 못하게 하려면 「입장 잠금」도 함께 쓰세요.')) return;
    try {
      await MM.api(`/api/gm/participants/${kickId}`, { method: 'DELETE', headers: AUTH() });
      MM.toast(`${p?.nickname || ''} 님을 내보냈습니다`);
    } catch (err) { MM.toast(err.message, true); }
    return;
  }
  return plistClick(e);
});

function plistClick(e) {
  if (e.target.closest('.roleassign') || e.target.closest('.grip')) return;
  const cb = e.target.closest('input[data-check]');
  if (cb) {
    const id = cb.dataset.check;
    cb.checked ? selected.add(id) : selected.delete(id);
    updateTargetChip();
    e.stopPropagation();
    return;
  }
  const item = e.target.closest('.pitem');
  if (!item) return;
  const id = item.dataset.id;
  openThread(id);
  selected.clear();
  selected.add(id);
  renderParticipants();
}

$('selAll').addEventListener('click', () => {
  participants.forEach((p) => selected.add(p.id));
  renderParticipants();
});
$('selNone').addEventListener('click', () => {
  selected.clear();
  renderParticipants();
});

function updateTargetChip() {
  const chip = $('targetChip');
  const names = participants.filter((p) => selected.has(p.id)).map((p) => p.nickname);
  if (names.length === 0) {
    chip.textContent = '받는 사람: 없음';
    chip.classList.remove('on');
  } else if (names.length === participants.length && names.length > 1) {
    chip.textContent = `받는 사람: 전체 ${names.length}명 (공지)`;
    chip.classList.add('on');
  } else {
    chip.textContent = `받는 사람: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` 외 ${names.length - 3}명` : ''}`;
    chip.classList.add('on');
  }
}

// ── GM 목록 ──────────────────────────────────────────────────────────────────
const gmUnread = new Map();
const channelKeyOf = (ch) => (ch === GM_ALL ? GM_ALL : [myGm.id, ch].sort().join('|'));
function bumpGmUnread(key) {
  gmUnread.set(key, (gmUnread.get(key) || 0) + 1);
  renderGms();
}

function renderGms() {
  $('gmCount').textContent = `${gms.length}명`;
  const others = gms.filter((g) => g.id !== myGm.id);
  const allUnread = gmUnread.get(GM_ALL) || 0;

  const rows = [`
    <div class="gitem${openGmChannel === GM_ALL ? ' active' : ''}" data-gch="${GM_ALL}">
      <span class="ico">🗣️</span>
      <span class="pname">GM 전체방</span>
      ${allUnread ? `<span class="badge">${allUnread}</span>` : ''}
    </div>`];

  rows.push(...others.map((g) => {
    const n = gmUnread.get([myGm.id, g.id].sort().join('|')) || 0;
    return `
    <div class="gitem${openGmChannel === g.id ? ' active' : ''}" data-gch="${g.id}">
      <span class="dot${g.online ? ' on' : ''}"></span>
      <span class="pname"${g.color ? ` style="color:${g.color}"` : ''}>${MM.esc(g.nickname)}</span>
      ${n ? `<span class="badge">${n}</span>` : ''}
    </div>`;
  }));

  if (others.length === 0) {
    rows.push('<div class="empty" style="padding:10px">다른 GM이 없습니다.<br>「GM 링크」를 공유하세요.</div>');
  }
  $('glist').innerHTML = rows.join('');
}

$('glist').addEventListener('click', (e) => {
  const ch = e.target.closest('.gitem')?.dataset.gch;
  if (ch) openGmChat(ch);
});

// ── 스레드 (플레이어) ────────────────────────────────────────────────────────
async function openThread(id, keepScroll) {
  // 같은 대화를 다시 여는 경우(자료 발송 뒤 갱신 등)에는 쓰던 글을 건드리지 않는다.
  const moving = openGmChannel !== null || openThreadId !== id;
  if (moving) stashDraft();
  openThreadId = id;
  openGmChannel = null;
  if (moving) restoreDraft();
  $('composer').classList.remove('gmmode');     // 플레이어에게 가는 입력창
  $('typing').textContent = '';
  $('playerTools').classList.remove('hidden');
  const p = participants.find((x) => x.id === id);
  $('threadName').textContent = p ? p.nickname + (p.roleName ? ` — ${p.roleName}` : '') : '';
  $('threadSub').textContent = p
    ? `${p.online ? '접속 중' : '오프라인'} · 입장 ${MM.dateTimeOf(p.joinedAt)}`
    : '';
  $('input').placeholder = '선택한 플레이어에게 보낼 메시지 (Enter 전송 · Shift+Enter 줄바꿈)';

  if (!threadCache.has(id)) {
    try {
      const data = await MM.api(`/api/gm/threads/${id}`, { headers: AUTH() });
      threadCache.set(id, data.messages);
    } catch (e) { MM.toast(e.message, true); return; }
  }
  if (p) p.unread = 0;
  socket?.emit('gm:open', { participantId: id });
  renderParticipants();
  renderGms();
  renderThread(id);
  if (!keepScroll) followThreadRole(id);
}

/** 스레드를 열면 그 사람의 배역 자료함으로 우측 패널을 따라 이동시킨다. */
function followThreadRole(participantId) {
  const p = participants.find((x) => x.id === participantId);
  viewRoleId = p?.roleId || COMMON;
  $('roleSelect').value = viewRoleId;
  renderLibrary();
}

function renderThread(id) {
  const msgs = threadCache.get(id) || [];
  $('msgs').innerHTML = '';
  if (msgs.length === 0) {
    $('msgs').innerHTML = '<div class="empty">아직 주고받은 메시지가 없습니다.</div>';
    return;
  }
  msgs.forEach(appendMessage);
  scrollDown(true);
}

// ── GM 대화 ──────────────────────────────────────────────────────────────────
async function openGmChat(ch, keepScroll) {
  const moving = openGmChannel !== ch;
  if (moving) stashDraft();
  openGmChannel = ch;
  openThreadId = null;
  if (moving) restoreDraft();
  $('composer').classList.add('gmmode');        // 플레이어에게 안 가는 입력창 — 색으로 구분
  $('typing').textContent = '';
  $('playerTools').classList.add('hidden');     // GM 대화에는 발송 대상이 없다
  const other = gms.find((g) => g.id === ch);
  $('threadName').textContent = ch === GM_ALL ? '🗣️ GM 전체방' : `${other?.nickname || 'GM'} (GM 1:1)`;
  $('threadSub').textContent = ch === GM_ALL
    ? '모든 GM이 봅니다. 플레이어에게는 절대 보이지 않습니다.'
    : '두 사람만 봅니다.';
  $('input').placeholder = 'GM에게 보낼 메시지 (Enter 전송)';

  const key = channelKeyOf(ch);
  gmUnread.set(key, 0);
  if (!gmCache.has(key)) {
    try {
      const data = await MM.api(`/api/gm/chat/${ch}`, { headers: AUTH() });
      gmCache.set(key, data.messages);
    } catch (e) { MM.toast(e.message, true); return; }
  }
  renderParticipants();
  renderGms();

  const msgs = gmCache.get(key) || [];
  $('msgs').innerHTML = msgs.length === 0
    ? '<div class="empty">아직 대화가 없습니다.</div>' : '';
  msgs.forEach(appendGmMessage);
  if (!keepScroll) scrollDown(true);
}

/** GM 전체방 글. 질문지 집계의 ~~수정 전 답~~ 은 취소선으로 보여준다. */
function gmChatBody(body) {
  const html = MM.esc(body || '');
  return String(body || '').startsWith('[집계]')
    ? html.replace(/~~(.+?)~~/g, '<s class="faint">$1</s>')
    : html;
}

function appendGmMessage(m) {
  const div = document.createElement('div');
  div.dataset.id = m.id;
  const mine = m.fromGmId === myGm.id;
  if (m.deleted) return;                    // 지운 메시지는 흔적 없이 숨긴다
  {
    div.className = `msg ${mine ? 'mine' : 'theirs'} gmchat`;
    div.innerHTML =
      `<span class="who"${m.senderColor ? ` style="color:${m.senderColor}"` : ''}>${MM.esc(m.senderName)}</span>` +
      (m.body ? `<span>${gmChatBody(m.body)}</span>` : '') +
      (m.file ? attachmentHtml(m.file) : '') +
      `<span class="stamp">${MM.timeOf(m.createdAt)}</span>` +
      // 내가 쓴 것만 지울 수 있다. 남의 글에는 단추가 아예 없다.
      (mine ? '<button class="del" title="삭제">×</button>' : '') +
      MM.reactionsHtml(m.reactions, MY_ACTOR);
  }
  $('msgs').appendChild(div);
}

// ── 말풍선 ───────────────────────────────────────────────────────────────────
function isAtBottom() {
  const el = $('msgs');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
function scrollDown(instant) {
  const el = $('msgs');
  el.scrollTo({ top: el.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
}

const fileUrl = (id) => `/f/${id}?gm=${encodeURIComponent(token())}`;

function attachmentHtml(file) {
  const url = fileUrl(file.id);
  const head = `<a class="att" href="${url}${file.mime.startsWith('image/') ? '&dl=1' : ''}" target="_blank" rel="noopener">` +
    `<span class="ico">${MM.iconFor(file.mime)}</span>` +
    `<span class="nm">${MM.esc(file.name)}</span>` +
    `<span class="faint">${MM.sizeOf(file.size)}</span></a>`;
  if (file.mime.startsWith('image/')) {
    return head +
      `<img class="att-img" src="${url}" data-full="${url}" data-name="${MM.esc(file.name)}" alt="">`;
  }
  return head;
}

function appendMessage(m) {
  if (m.kind === 'answer') return;          // 답은 질문 카드에만 모인다
  if (m.deleted) return;                    // 지운 메시지는 흔적 없이 숨긴다
  const div = document.createElement('div');
  const mine = m.sender === 'gm';
  div.dataset.id = m.id || '';
  if (m.kind === 'ask' && m.pollId && !m.deleted) {
    div.className = 'msg mine askcard';
    div.dataset.poll = m.pollId;
    div.innerHTML = askHtml(m);
    $('msgs').appendChild(div);
    if (!askCache.has(m.pollId)) refreshAsk(m.pollId);
    return;
  }
  if (m.sender === 'system') {
    div.className = 'msg system';
    div.textContent = m.body;
  } else if (m.deleted) {
    div.className = 'msg gone';
    div.textContent = '삭제된 메시지';
  } else {
    div.className = `msg ${mine ? 'mine' : 'theirs'}${m.kind === 'broadcast' ? ' bc' : ''}`
      + (m.kind === 'vans' ? ' vans' : '') + (m.kind === 'vask' ? ' vask' : '');
    const parts = [];
    if (m.kind === 'broadcast') parts.push('<span class="bctag">전체 공지</span>');
    // NPC 이름 뒤의 GM은 GM 화면에만 보인다. 그 사람의 색도 여기서만 쓴다.
    const npcTag = m.npcName
      ? ` <span class="faint"${m.gmColor ? ` style="color:${m.gmColor}"` : ''}>(${MM.esc(m.gmName || 'GM')})</span>`
      : '';
    // 정답 답변에 보낼 이름을 비워두면 이름 줄을 아예 만들지 않는다.
    if (!(m.kind === 'vans' && !m.npcName)) {
      const col = m.senderColor ? ` style="color:${m.senderColor}"` : '';
      parts.push(`<span class="who"${col}>${MM.esc(m.senderName || (mine ? 'GM' : '플레이어'))}${npcTag}</span>`);
    }
    if (m.body) parts.push(`<span>${MM.esc(m.body)}</span>`);
    if (m.file) parts.push(attachmentHtml(m.file));
    const read = mine ? `<span class="read">${m.readByPlayer ? ' 읽음' : ' 안읽음'}</span>` : '';
    parts.push(`<span class="stamp">${MM.timeOf(m.createdAt)}${read}</span>`);
    parts.push(`<button class="star${stars.has(m.id) ? ' on' : ''}" title="즐겨찾기">★</button>`);
    if (mine) parts.push('<button class="del" title="삭제">×</button>');
    parts.push(MM.reactionsHtml(m.reactions, MY_ACTOR));
    div.innerHTML = parts.join('');
  }
  $('msgs').appendChild(div);
}

function renderDeleted(el) {
  el.remove();                              // 「삭제된 메시지」 자리도 남기지 않는다
}

$('msgs').addEventListener('click', (e) => {
  if (e.target.classList?.contains('star')) {
    const id = e.target.closest('.msg')?.dataset.id;
    const m = (threadCache.get(openThreadId) || []).find((x) => x.id === id)
           || (gmCache.get(openGmChannel ? channelKeyOf(openGmChannel) : '') || []).find((x) => x.id === id);
    if (!m) return;
    const who = participants.find((p) => p.id === (m.threadId || openThreadId));
    const on = stars.toggle(m, { threadName: who ? who.nickname : 'GM 대화' });
    e.target.classList.toggle('on', on);
    renderStars();
    MM.toast(on ? '즐겨찾기에 담았습니다' : '즐겨찾기에서 뺐습니다');
    return;
  }
  if (!e.target.classList?.contains('del')) return;
  const id = e.target.closest('.msg')?.dataset.id;
  if (!id) return;

  // GM끼리의 대화는 지우는 길이 따로 있다 (플레이어 화면과 무관하다).
  if (e.target.closest('.msg')?.classList.contains('gmchat')) {
    if (!confirm('이 글을 지울까요? 다른 GM의 화면에서도 사라집니다.')) return;
    socket.emit('gm:chat:delete', { messageId: id }, (res) => {
      if (res?.error) MM.toast(res.error, true);
    });
    return;
  }

  const msg = (threadCache.get(openThreadId) || []).find((m) => m.id === id);
  const warn = msg?.kind === 'broadcast'
    ? '이건 여러 명에게 보낸 공지입니다. 받은 사람 모두의 화면에서 지워집니다. 계속할까요?'
    : '이 메시지를 지울까요? 플레이어 화면에서도 사라집니다.';
  if (!confirm(warn)) return;
  socket.emit('message:delete', { messageId: id }, (res) => {
    if (res?.error) MM.toast(res.error, true);
  });
});

// ── 질문지 (제출함) ──────────────────────────────────────────────────────────
/** GM 화면의 질문 카드: 사람별로 1·2·3번 답을 묶어 보여준다. */
function askHtml(m) {
  const d = askCache.get(m.pollId);
  if (!d) return `<span class="asktag">제출 요청</span><div class="asktitle">${MM.esc(m.body || '')}</div>`;
  const people = d.people.map((p) => {
    const rows = d.items.map((q, i) => {
      // 수정 전 답은 취소선으로, 마지막 답이 지금 답이다.
      const list = (p.answers[i] || []).slice(-2);   // 직전 답 + 지금 답
      const got = list.map((a, k) => k < list.length - 1
        ? `<s class="faint">${MM.esc(a.body)}</s>`
        : MM.esc(a.body)).join(' ');
      return `<div class="ans">${i + 1}. ${got ? `<b>${got}</b>` : '<span class="none">미제출</span>'}</div>`;
    }).join('');
    return `<div class="person"><div class="pname2">${MM.esc(p.nickname)}</div>${rows}</div>`;
  }).join('');
  const qs = d.items.map((q, i) => `<div class="askq">${i + 1}. ${MM.esc(q)}</div>`).join('');
  return `<span class="asktag">${d.closed ? '마감됨' : '제출 요청'}</span>` +
    `<div class="asktitle">${MM.esc(d.question)}</div>${qs}` +
    `<div class="askgm"><div class="faint" style="margin-bottom:6px">` +
    `제출 ${d.doneCount}/${d.askedCount}명</div>${people}` +
    `<div class="bmacts" style="margin-top:8px">
       <button class="ghost" data-askclose="${d.id}">${d.closed ? '다시 열기' : '마감'}</button>
       <button class="primary" data-asksum="${d.id}" title="플레이어에게는 보내지 않습니다">📋 정리해서 GM방에 올리기</button>
       <button class="danger" data-askdel="${d.id}">질문 삭제</button>
     </div></div>`;
}

function paintAsk(pollId) {
  document.querySelectorAll(`.msg[data-poll="${pollId}"]`).forEach((el) => {
    if (el.classList.contains('gone')) return;     // 지운 질문은 다시 그리지 않는다
    const m = { pollId, body: askCache.get(pollId)?.question };
    el.innerHTML = askHtml(m);
  });
}

async function refreshAsk(pollId) {
  try {
    const { poll } = await MM.api(`/api/gm/ask/${pollId}`, { headers: AUTH() });
    askCache.set(pollId, poll);
    paintAsk(pollId);
  } catch { }
}

$('msgs').addEventListener('click', async (e) => {
  const closeId = e.target.dataset?.askclose;
  const sumId = e.target.dataset?.asksum;
  const delId = e.target.dataset?.askdel;
  try {
    if (closeId) {
      const { poll } = await MM.api(`/api/gm/ask/${closeId}/close`, { method: 'POST', headers: AUTH() });
      askCache.set(poll.id, poll); paintAsk(poll.id);
    }
    if (sumId) {
      await MM.api(`/api/gm/ask/${sumId}/summary`, { method: 'POST', headers: AUTH() });
      MM.toast('정리해서 GM 전체방에 올렸습니다');
      openGmChat(GM_ALL);
    }
    if (delId) {
      const msgId = e.target.closest('.msg')?.dataset.id;
      if (!msgId) return;
      if (!confirm('이 질문지를 지웁니다. 받은 사람 모두의 화면에서 사라지고 더 이상 답할 수 없습니다. 계속할까요?')) return;
      socket.emit('message:delete', { messageId: msgId }, (res) => {
        if (res?.error) MM.toast(res.error, true);
        else MM.toast('질문지를 지웠습니다');
      });
    }
  } catch (err) { MM.toast(err.message, true); }
});

/** /질문 명령을 해석한다. 첫 줄이 제목, 나머지 줄이 세부 항목. */
function parseAskCommand(text) {
  const m = text.match(/^\/(질문|ask)\s*([\s\S]*)$/);
  if (!m) return null;
  const lines = m[2].split('\n').map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
  if (lines.length === 0) return null;
  return { question: lines[0], items: lines.length > 1 ? lines.slice(1) : [lines[0]] };
}

async function sendAsk({ question, items, templateId }) {
  const t = targets();
  if (t.length === 0) return MM.toast('받는 사람을 선택해 주세요', true);
  try {
    const res = await MM.api('/api/gm/ask', {
      method: 'POST', headers: AUTH(), body: { question, items, templateId, targets: t },
    });
    askCache.set(res.poll.id, res.poll);
    MM.Sound.play('send');
    MM.toast(`${res.count}명에게 질문지를 보냈습니다`);
  } catch (e) { MM.toast(e.message, true); }
}

// ── 발송 ─────────────────────────────────────────────────────────────────────
const targets = () => [...selected];

async function sendText() {
  const body = $('input').value.trim();
  if (!body) return;

  // /질문 … 은 제출 요청으로 나간다
  const ask = parseAskCommand(body);
  if (ask) {
    $('input').value = '';
    MM.autoGrow($('input'));
    return sendAsk(ask);
  }

  // GM 대화가 열려 있으면 그쪽으로 간다.
  if (openGmChannel) {
    socket.emit('gm:chat', { channel: openGmChannel, body }, (res) => {
      if (res?.error) MM.toast(res.error, true);
    });
    drafts.delete(draftKey());
    $('input').value = '';
    MM.autoGrow($('input'));
    MM.Sound.play('send');
    return;
  }

  const t = targets();
  if (t.length === 0) return MM.toast('받는 사람을 선택해 주세요', true);
  if (t.length > 1 && !confirm(`${t.length}명에게 같은 내용을 보냅니다. 계속할까요?`)) return;

  $('sendBtn').disabled = true;
  try {
    const res = await MM.api('/api/gm/send', {
      method: 'POST', headers: AUTH(), body: { targets: t, body, npcName: npcName || undefined },
    });
    drafts.delete(draftKey());
    $('input').value = '';
    MM.autoGrow($('input'));
    emitTyping(false);
    MM.Sound.play('send');
    if (res.count > 1) MM.toast(`${res.count}명에게 발송했습니다`);
  } catch (e) {
    MM.toast(e.message, true);
  } finally {
    $('sendBtn').disabled = false;
  }
}

$('sendBtn').addEventListener('click', sendText);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); }
});
$('input').addEventListener('input', (e) => {
  MM.autoGrow(e.target);
  emitTyping(e.target.value.length > 0);
});

// 이미지 붙여넣기(Ctrl+V) — 보고 있는 대화로 그대로 나간다.
MM.onPasteFiles($('input'), async (files) => {
  if (openGmChannel) return sendToGmChat(files);
  const t = targets();
  if (t.length === 0) return MM.toast('받는 사람을 먼저 선택해 주세요', true);
  if (t.length > 1 && !confirm(`${t.length}명에게 붙여넣은 이미지를 보냅니다. 계속할까요?`)) return;
  await uploadAndSend(files, t, $('keepInLib').checked);
});

function emitTyping(on) {
  if (!socket?.connected || !openThreadId) return;
  if (on !== lastSentTyping) {
    socket.emit('typing', { participantId: openThreadId, on });
    lastSentTyping = on;
  }
  clearTimeout(typingTimer);
  if (on) typingTimer = setTimeout(() => emitTyping(false), 4000);
}

/** GM끼리의 대화에 파일을 보낸다 (끌어놓기·붙여넣기·첨부 모두 같은 길). */
async function sendToGmChat(files, body) {
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  if (body) fd.append('body', body);
  $('uploadState').textContent = `업로드 중… (${files.length}개)`;
  try {
    await MM.api(`/api/gm/chat/${openGmChannel}/upload`, { method: 'POST', headers: AUTH(), body: fd });
    $('uploadState').textContent = '';
    MM.Sound.play('send');
  } catch (err) {
    $('uploadState').textContent = '';
    MM.toast(err.message, true);
  }
}

/** 대화창에 떨어뜨린 파일을 지금 선택된 사람에게 바로 보낸다. */
async function dropSend(files) {
  if (openGmChannel) return sendToGmChat(files);
  const t = targets();
  if (t.length === 0) return MM.toast('받는 사람을 먼저 선택해 주세요', true);
  if (t.length > 1 && !confirm(`${t.length}명에게 파일 ${files.length}개를 보냅니다. 계속할까요?`)) return;
  await uploadAndSend(files, t, false);
}

/** 파일을 올리면서 곧바로 발송한다. keep이면 자료함에도 남긴다. */
async function uploadAndSend(files, t, keep) {
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  fd.append('targets', JSON.stringify(t));
  fd.append('keep', keep ? 'true' : 'false');
  if (keep && viewRoleId !== COMMON) fd.append('roleId', viewRoleId);

  $('uploadState').textContent = `업로드 중… (${files.length}개)`;
  try {
    const res = await MM.api('/api/gm/upload-send', { method: 'POST', headers: AUTH(), body: fd });
    $('uploadState').textContent = '';
    MM.Sound.play('send');
    MM.toast(`${res.count}명에게 발송했습니다`);
    if (keep) loadLibrary();
  } catch (err) {
    $('uploadState').textContent = '';
    MM.toast(err.message, true);
  }
}

// ── 파일 첨부 발송 ───────────────────────────────────────────────────────────
$('fileBtn').addEventListener('click', () => {
  if (!openGmChannel && targets().length === 0) {
    return MM.toast('받는 사람을 먼저 선택해 주세요', true);
  }
  $('fileInput').click();
});
$('fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  if (openGmChannel) return sendToGmChat(files);
  const t = targets();
  if (t.length === 0) return;
  if (t.length > 1 && !confirm(`${t.length}명에게 파일 ${files.length}개를 보냅니다. 계속할까요?`)) return;

  await uploadAndSend(files, t, $('keepInLib').checked);
});

// ── 배역 ─────────────────────────────────────────────────────────────────────
async function loadRoles() {
  try { roles = (await MM.api('/api/gm/roles', { headers: AUTH() })).roles; } catch { roles = []; }
  renderRoleSelect();
  renderRoleManager();
  renderParticipants();
}

function renderRoleSelect() {
  const sel = $('roleSelect');
  sel.innerHTML = [`<option value="${COMMON}">공용 자료함</option>`]
    .concat(roles.map((r) =>
      `<option value="${r.id}">${MM.esc(r.name)}${r.holder ? ` — ${MM.esc(r.holder.nickname)}` : ' (미배정)'} · ${r.fileCount}개</option>`
    )).join('');
  sel.value = roles.some((r) => r.id === viewRoleId) ? viewRoleId : COMMON;
  viewRoleId = sel.value;
}

function renderRoleManager() {
  $('roleList').innerHTML = roles.length === 0
    ? '<div class="faint">아직 배역이 없습니다.</div>'
    : roles.map((r) => `
      <div class="row" style="margin-bottom:5px">
        <span class="grow" style="font-size:13px">${MM.esc(r.name)}
          <span class="faint">${r.holder ? MM.esc(r.holder.nickname) : '미배정'}</span></span>
        <button class="ghost" data-rename="${r.id}" style="padding:3px 8px;font-size:12px">이름</button>
        <button class="ghost" data-delrole="${r.id}" style="padding:3px 8px;font-size:12px">삭제</button>
      </div>`).join('');
}

$('roleManageBtn').addEventListener('click', () => $('roleManager').classList.toggle('hidden'));

$('roleAddBtn').addEventListener('click', async () => {
  const names = $('roleNames').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return MM.toast('배역 이름을 입력해 주세요', true);
  try {
    roles = (await MM.api('/api/gm/roles', { method: 'POST', headers: AUTH(), body: { names } })).roles;
    $('roleNames').value = '';
    renderRoleSelect(); renderRoleManager(); renderParticipants();
    MM.toast(`배역 ${names.length}개를 추가했습니다`);
  } catch (e) { MM.toast(e.message, true); }
});

$('roleList').addEventListener('click', async (e) => {
  const renameId = e.target.dataset?.rename;
  const delId = e.target.dataset?.delrole;
  try {
    if (renameId) {
      const cur = roles.find((r) => r.id === renameId);
      const name = prompt('새 배역 이름', cur?.name || '');
      if (!name?.trim()) return;
      roles = (await MM.api(`/api/gm/roles/${renameId}`, { method: 'PATCH', headers: AUTH(), body: { name } })).roles;
    }
    if (delId) {
      if (!confirm('배역을 지울까요? 자료와 대화는 남고 배역 연결만 풀립니다.')) return;
      roles = (await MM.api(`/api/gm/roles/${delId}`, { method: 'DELETE', headers: AUTH() })).roles;
      if (viewRoleId === delId) viewRoleId = COMMON;
    }
    if (renameId || delId) {
      participants = (await MM.api('/api/gm/participants', { headers: AUTH() })).participants;
      renderRoleSelect(); renderRoleManager(); renderParticipants();
      await loadLibrary();
    }
  } catch (err) { MM.toast(err.message, true); }
});

$('roleSelect').addEventListener('change', (e) => {
  viewRoleId = e.target.value;
  renderLibrary();
});

// ── 자료함 ───────────────────────────────────────────────────────────────────
let nextFiles = {};        // roleId -> 다음에 나갈 file id

async function loadLibrary() {
  try { libFiles = (await MM.api('/api/gm/library', { headers: AUTH() })).files; } catch { libFiles = []; }
  try { nextFiles = (await MM.api('/api/gm/next-files', { headers: AUTH() })).next; } catch { nextFiles = {}; }
  renderLibrary();
}

function renderLibrary() {
  const role = roles.find((r) => r.id === viewRoleId);
  $('roleHolder').textContent = viewRoleId === COMMON
    ? '누구에게나 보낼 수 있는 공용 자료입니다.'
    : role?.holder
      ? `이 배역은 지금 ${role.holder.nickname} 님이 맡고 있습니다.`
      : '아직 이 배역을 맡은 플레이어가 없습니다.';

  const shown = libFiles.filter((f) => (f.roleId || COMMON) === viewRoleId);
  const holder = role?.holder || null;
  const moveOptions = (current) =>
    [`<option value="${COMMON}"${!current ? ' selected' : ''}>공용</option>`]
      .concat(roles.map((r) =>
        `<option value="${r.id}"${r.id === current ? ' selected' : ''}>${MM.esc(r.name)}</option>`
      )).join('');

  $('libList').innerHTML = shown.length === 0
    ? '<div class="empty">이 자료함은 비어 있습니다.</div>'
    : shown.map((f) => `
      <div class="lib-item${nextFiles[f.roleId] === f.id ? ' isnext' : ''}" data-id="${f.id}" draggable="true">
        <div class="nm"><span class="grip" title="끌어서 순서 변경">⠿</span>
          ${MM.iconFor(f.mime)} ${MM.esc(f.name)}
          ${nextFiles[f.roleId] === f.id ? '<span class="nexttag">다음 발송</span>' : ''}</div>
        <div class="faint" style="margin-bottom:6px">${MM.sizeOf(f.size)}</div>
        <div class="acts">
          ${f.roleId
            ? (holder
              ? `<button class="primary" data-sendfile="${f.id}">${MM.esc(holder.nickname)}에게 발송</button>`
              : '<button class="primary" disabled title="이 배역을 맡은 플레이어가 없습니다">배역 미배정</button>')
            // 공용 자료는 모두에게 보내는 것이 기본이다.
            : `<button class="primary" data-sendall="${f.id}">📢 전체 발송</button>
               <button class="ghost" data-sendfile="${f.id}" title="왼쪽에서 체크한 사람에게만">선택한 사람</button>`}
          ${f.roleId ? `<button class="ghost" data-sendall="${f.id}" title="모든 플레이어에게">📢 전체</button>` : ''}
          <select class="movesel" data-move="${f.id}">${moveOptions(f.roleId)}</select>
          <button class="ghost" data-delfile="${f.id}">삭제</button>
        </div>
      </div>`).join('');
}

/** 지금 보고 있는 자료함의 파일을 순서대로 모두 보낸다. */
$('libSendAllBtn').addEventListener('click', async () => {
  const shown = libFiles.filter((f) => (f.roleId || COMMON) === viewRoleId);
  if (shown.length === 0) return MM.toast('이 자료함은 비어 있습니다', true);

  const role = roles.find((r) => r.id === viewRoleId);
  const holder = role?.holder || null;
  let t, who;
  if (viewRoleId === COMMON) {
    t = participants.map((p) => p.id);
    if (t.length === 0) return MM.toast('아직 입장한 플레이어가 없습니다', true);
    who = `모든 플레이어 ${t.length}명`;
  } else {
    if (!holder) return MM.toast('이 배역을 맡은 플레이어가 없습니다', true);
    t = [holder.id];
    who = `${holder.nickname} 님`;
  }
  if (!confirm(`${who}에게 자료 ${shown.length}개를 모두 보냅니다. 계속할까요?`)) return;

  $('libSendAllBtn').disabled = true;
  let sent = 0;
  try {
    for (const f of shown) {
      await MM.api('/api/gm/send', { method: 'POST', headers: AUTH(), body: { targets: t, fileId: f.id } });
      sent++;
    }
    MM.Sound.play('send');
    MM.toast(`${who}에게 ${sent}개를 보냈습니다`);
    await loadLibrary();
  } catch (e) {
    MM.toast(`${sent}개까지 보내고 멈췄습니다 — ${e.message}`, true);
  } finally {
    $('libSendAllBtn').disabled = false;
  }
});

/** 자료함 비우기. 이미 보낸 자료는 대화에 그대로 남는다. */
async function clearLibrary(scope, what) {
  if (!confirm(`${what}을(를) 비웁니다.\n이미 보낸 자료는 대화에 그대로 남습니다. 계속할까요?`)) return;
  try {
    const res = await MM.api('/api/gm/library/clear', { method: 'POST', headers: AUTH(), body: { scope } });
    MM.toast(res.removed === 0 ? '비울 자료가 없습니다' : `${res.removed}개를 자료함에서 뺐습니다`);
    await loadRoles();
    await loadLibrary();
  } catch (e) { MM.toast(e.message, true); }
}

$('libClearBtn').addEventListener('click', () => {
  const role = roles.find((r) => r.id === viewRoleId);
  clearLibrary(viewRoleId === COMMON ? 'common' : viewRoleId,
    viewRoleId === COMMON ? '공용 자료함' : `${role?.name || '이 배역'} 자료함`);
});
$('libClearAllBtn').addEventListener('click', () => clearLibrary('all', '모든 자료함'));

async function saveLibraryOrder(ids) {
  libFiles.sort((a, b) => {
    const ia = ids.indexOf(a.id), ib = ids.indexOf(b.id);
    return (ia === -1 ? 9999 : ia) - (ib === -1 ? 9999 : ib);
  });
  try {
    await MM.api('/api/gm/library/order', { method: 'PUT', headers: AUTH(), body: { ids } });
  } catch (e) { MM.toast(e.message, true); }
}

$('libList').addEventListener('change', async (e) => {
  const id = e.target.dataset?.move;
  if (!id) return;
  try {
    await MM.api(`/api/gm/library/${id}`, {
      method: 'PATCH', headers: AUTH(),
      body: { roleId: e.target.value === COMMON ? null : e.target.value },
    });
    await loadRoles();
    await loadLibrary();
  } catch (err) { MM.toast(err.message, true); }
});

$('libList').addEventListener('click', async (e) => {
  const sendId = e.target.dataset?.sendfile;
  const allId = e.target.dataset?.sendall;
  const delId = e.target.dataset?.delfile;

  // 이 자료 하나를 모든 플레이어에게
  if (allId) {
    const file = libFiles.find((f) => f.id === allId);
    const t = participants.map((p) => p.id);
    if (t.length === 0) return MM.toast('아직 입장한 플레이어가 없습니다', true);
    if (!confirm(`「${file?.name || '이 자료'}」를 모든 플레이어 ${t.length}명에게 보냅니다. 계속할까요?`)) return;
    try {
      const res = await MM.api('/api/gm/send', {
        method: 'POST', headers: AUTH(), body: { targets: t, fileId: allId },
      });
      MM.Sound.play('send');
      MM.toast(`${res.count}명에게 발송했습니다`);
      await loadLibrary();
    } catch (err) { MM.toast(err.message, true); }
    return;
  }
  if (sendId) {
    const file = libFiles.find((f) => f.id === sendId);
    // 배역에 태그된 자료는 그 배역을 맡은 사람에게 간다.
    const owner = file?.roleId ? participants.find((p) => p.roleId === file.roleId) : null;
    let t;
    if (file?.roleId) {
      if (!owner) return MM.toast('이 배역을 맡은 플레이어가 없습니다', true);
      t = [owner.id];
    } else {
      t = targets();
      if (t.length === 0) return MM.toast('받는 사람을 선택해 주세요', true);
      if (t.length > 1 && !confirm(`${t.length}명에게 이 자료를 보냅니다. 계속할까요?`)) return;
    }
    try {
      const res = await MM.api('/api/gm/send', {
        method: 'POST', headers: AUTH(), body: { targets: t, fileId: sendId },
      });
      MM.Sound.play('send');
      MM.toast(owner ? `${owner.nickname} 님에게 보냈습니다` : `${res.count}명에게 발송했습니다`);
      await loadLibrary();
      if (owner && openThreadId !== owner.id) openThread(owner.id);
    } catch (err) { MM.toast(err.message, true); }
  }
  if (delId) {
    if (!confirm('자료함에서 지울까요? (이미 보낸 메시지는 그대로 남습니다)')) return;
    try {
      await MM.api(`/api/gm/library/${delId}`, { method: 'DELETE', headers: AUTH() });
      await loadRoles();
      await loadLibrary();
    } catch (err) { MM.toast(err.message, true); }
  }
});

// 드래그&드롭 + 클릭 업로드 — 지금 보고 있는 배역 자료함에 들어간다
const drop = $('drop');
drop.addEventListener('click', () => $('libInput').click());
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => uploadToLibrary([...e.dataTransfer.files]));
$('libInput').addEventListener('change', (e) => {
  uploadToLibrary([...e.target.files]);
  e.target.value = '';
});

async function uploadToLibrary(files) {
  if (!files.length) return;
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  if (viewRoleId !== COMMON) fd.append('roleId', viewRoleId);
  drop.textContent = `업로드 중… (${files.length}개)`;
  try {
    await MM.api('/api/gm/library', { method: 'POST', headers: AUTH(), body: fd });
    await loadRoles();
    await loadLibrary();
  } catch (e) {
    MM.toast(e.message, true);
  } finally {
    drop.innerHTML = '여기에 PDF를 끌어다 놓거나<br>클릭해서 이 배역 자료함에 넣으세요';
  }
}

// ── 즐겨찾기 ─────────────────────────────────────────────────────────────────
function renderStars() {
  const list = stars.list();
  $('starCount').textContent = list.length ? `(${list.length})` : '';
  $('starList').innerHTML = list.length === 0
    ? '<div class="empty">말풍선의 ★ 를 눌러 중요한 메시지를 담아두세요.</div>'
    : list.map((m) => {
        const url = m.file ? fileUrl(m.file.id) : null;
        const thumb = m.file && m.file.mime.startsWith('image/')
          ? `<img class="att-img" src="${url}" data-full="${url}" data-name="${MM.esc(m.file.name)}" alt="">`
          : '';
        const fileRow = m.file && !thumb
          ? `<div class="bmacts"><span>${MM.iconFor(m.file.mime)} ${MM.esc(m.file.name)}</span>
             <a class="btnlink" href="${url}" target="_blank" rel="noopener">열기</a></div>`
          : '';
        return `<div class="bmcard" data-id="${m.id}">
          <div class="bmhead"><span class="bmwho">${MM.esc(m.senderName || '')}</span>
            <span class="faint">${MM.esc(m.threadName || '')} · ${MM.dateTimeOf(m.createdAt)}</span></div>
          ${m.body ? `<div class="bmbody">${MM.esc(m.body)}</div>` : ''}
          ${thumb}${fileRow}
          <div class="bmacts">
            ${m.threadId ? `<button class="ghost" data-goto="${m.threadId}">대화로 가기</button>` : ''}
            <button class="ghost" data-unstar="${m.id}">해제</button>
          </div>
        </div>`;
      }).join('');
}

$('starList').addEventListener('click', (e) => {
  const un = e.target.dataset?.unstar;
  const go = e.target.dataset?.goto;
  if (un) {
    stars.remove(un);
    renderStars();
    const btn = document.querySelector(`.msg[data-id="${un}"] .star`);
    if (btn) btn.classList.remove('on');
  }
  if (go) {
    selected.clear();
    selected.add(go);
    openThread(go);
    renderParticipants();
  }
});

// ── 모듈 ─────────────────────────────────────────────────────────────────────
/** 모듈 화면에 넘길 도구 모음. 모듈이 이 파일 내부를 직접 만지지 않게 한다. */
function moduleContext() {
  return {
    api: MM.api,
    AUTH,
    token,
    get socket() { return socket; },
    room,
    me: () => myGm,                       // 내 말풍선을 가려내는 데 쓴다
    /** 화면을 넓게 쓰고 싶을 때. 모듈이 gm.js 내부를 직접 만지지 않게 여기로만 연다. */
    layout: {
      wide: (on) => {
        sidebarPanel?.setCollapsed(on);
        rightPanel?.setWidth(on ? window.innerWidth - 320 : 320);
      },
      isWide: () => (rightPanel ? rightPanel.width > window.innerWidth * 0.6 : false),
    },
    participants: () => participants.slice(),
    gms: () => gms.slice(),
    roles: () => roles.slice(),
    library: () => libFiles.slice(),
    targets: () => [...selected],
    openThread: (id) => openThread(id),
  };
}

function loadModulePanels() {
  return MM.Panels.load(room.modules || [], {
    side: 'gm',
    tabsEl: $('rtabs'),
    panelsEl: document.querySelector('.rightbar'),
    tabAttr: 'rtab',
    panelAttr: 'rpanel',
    ctx: moduleContext(),
  });
}

/** 어떤 모듈을 쓸지 고르는 창. 목록은 서버 카탈로그로 그린다. */
function openModuleDialog(modules, enabled) {
  const back = document.createElement('div');
  back.className = 'mdl-back';
  back.innerHTML = `
    <div class="mdl">
      <h3>⚙ 모듈</h3>
      <div class="faint" style="margin-bottom:10px">
        이 방에서 쓸 기능을 고릅니다. 저장하면 화면을 다시 불러옵니다.
      </div>
      <div class="mdl-list">
        ${modules.map((m) => `
          <label class="mdl-item">
            <input type="checkbox" data-mid="${MM.esc(m.id)}"${enabled.includes(m.id) ? ' checked' : ''}>
            <span class="mdl-txt">
              <b>${MM.esc(m.name)}</b>
              <span class="faint">${MM.esc(m.description)}</span>
              ${m.playerUi ? '<span class="faint">· 플레이어에게도 탭이 생깁니다</span>' : ''}
            </span>
          </label>`).join('')}
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="ghost" data-mdl="close">취소</button>
        <button class="primary" data-mdl="save">저장</button>
      </div>
    </div>`;
  document.body.appendChild(back);

  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  back.addEventListener('click', async (e) => {
    if (e.target === back || e.target.dataset.mdl === 'close') return close();
    if (e.target.dataset.mdl !== 'save') return;
    const ids = [...back.querySelectorAll('[data-mid]')].filter((c) => c.checked).map((c) => c.dataset.mid);
    if (ids.length === enabled.length && ids.every((id) => enabled.includes(id))) return close();
    try {
      e.target.disabled = true;
      await MM.api('/api/gm/modules', { method: 'PUT', headers: AUTH(), body: { ids } });
      location.reload();
    } catch (err) { e.target.disabled = false; MM.toast(err.message, true); }
  });
}

$('moduleBtn').addEventListener('click', async () => {
  try {
    const { modules, enabled } = await MM.api('/api/gm/modules', { headers: AUTH() });
    if (modules.length === 0) return MM.toast('쓸 수 있는 모듈이 없습니다');
    openModuleDialog(modules, enabled);
  } catch (e) { MM.toast(e.message, true); }
});

// ── 기타 ─────────────────────────────────────────────────────────────────────
$('copyInvite').addEventListener('click', async (e) => {
  e.preventDefault();
  await MM.copyAndTell(`${MM.origin()}/r/${room.code}`, '플레이어 링크를 복사했습니다');
});

$('exportBtn').addEventListener('click', () => {
  window.open(`/api/gm/export?gm=${encodeURIComponent(token())}`, '_blank');
});

$('exportGmBtn').addEventListener('click', () => {
  window.open(`/api/gm/chat-export?gm=${encodeURIComponent(token())}`, '_blank');
});

// ── 룸 셋팅 ──────────────────────────────────────────────────────────────
// 배역·자료·질문지를 파일 하나로 저장해 두었다가, 다음 회차에서 그대로 되살린다.
$('bundleOutBtn').addEventListener('click', () => {
  window.open(`/api/gm/bundle?gm=${encodeURIComponent(token())}`, '_blank');
  MM.toast('룸 셋팅을 저장합니다 — 대화와 플레이어는 담기지 않습니다');
});

$('bundleInBtn').addEventListener('click', () => $('bundleInput').click());

$('bundleInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  const hasStuff = roles.length > 0 || libFiles.length > 0;
  let mode = 'merge';
  if (hasStuff) {
    mode = confirm('지금 있는 배역과 자료를 모두 지우고 룸 셋팅 내용으로 바꿀까요?\n\n'
      + '확인 = 싹 바꾸기 (이미 보낸 자료는 대화에 그대로 남습니다)\n'
      + '취소 = 지금 것에 더하기')
      ? 'replace' : 'merge';
  }

  const fd = new FormData();
  fd.append('bundle', file);
  fd.append('mode', mode);
  $('bundleInBtn').disabled = true;
  $('uploadState').textContent = '룸 셋팅 읽는 중…';
  try {
    const r = await MM.api('/api/gm/bundle/import', { method: 'POST', headers: AUTH(), body: fd });
    await loadRoles();
    await loadLibrary();
    await loadAskTemplates();
    MM.toast(`배역 ${r.roles}개 · 자료 ${r.files}개 · 질문지 ${r.askTemplates}개를 가져왔습니다`);
  } catch (err) {
    MM.toast(err.message, true);
  } finally {
    $('bundleInBtn').disabled = false;
    $('uploadState').textContent = '';
  }
});

$('closeRoomBtn').addEventListener('click', async () => {
  const next = !room.closed;
  if (next && !confirm(
    '방을 닫으면 플레이어가 입장·발송을 할 수 없습니다.\n' +
    'GM은 그대로 쓸 수 있고, 언제든 다시 열 수 있습니다. 계속할까요?')) return;
  try {
    const res = await MM.api('/api/gm/close', {
      method: 'POST', headers: AUTH(), body: { closed: next },
    });
    room.closed = res.closed;
    paintRoomState();
  } catch (e) { MM.toast(e.message, true); }
});

$('deleteRoomBtn').addEventListener('click', async () => {
  const typed = prompt(
    '이 방을 완전히 지웁니다. 대화·자료가 모두 사라지고 되돌릴 수 없습니다.\n' +
    `확인하려면 세션 이름(${room.name})을 그대로 입력하세요.`);
  if (typed === null) return;
  try {
    await MM.api('/api/gm/room', {
      method: 'DELETE', headers: AUTH(), body: { confirmCode: typed },
    });
    alert('방을 삭제했습니다.');
    location.href = '/';
  } catch (e) { MM.toast(e.message, true); }
});

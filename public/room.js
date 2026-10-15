/* 플레이어 화면 */
'use strict';
const $ = (id) => document.getElementById(id);
const CODE = decodeURIComponent(location.pathname.split('/r/')[1] || '').toUpperCase();
const TOKEN_KEY = `mm.player.${CODE}`;
const MEMO_KEY = `mm.memo.${CODE}`;
const STAR_KEY = `mm.star.${CODE}`;
const stars = MM.bookmarks(STAR_KEY);
// 내보내진 사람이 갈 곳. 방 화면에 남겨두면 계속 다시 붙으려 하므로 어디로든 보낸다.
// 서버 설정(KICKED_URL)으로 바꿀 수 있고, 안 정하면 첫 화면으로 보낸다.
let KICKED_URL = '/';

let socket = null;
let me = null;                 // { id, nickname }
let roomName = '';
let messages = [];             // 내 스레드 전체 (받은 자료 탭도 여기서 뽑는다)
let typingTimer = null;
let lastSentTyping = false;
let timer = null;
const askCache = new Map();   // pollId -> 내 질문지 상태
const editingAns = new Set(); // 수정 중인 항목 "pollId:번호"
let MY_ACTOR = '';            // 표시(반응)에서 '나'를 가리키는 값

const token = () => localStorage.getItem(TOKEN_KEY);
const authHeader = () => ({ 'x-player-token': token() });

// ── 부팅: 저장된 토큰이 있으면 닉네임 화면을 건너뛴다 ────────────────────────
(async function boot() {
  // 내보낸 사람을 어디로 보낼지는 서버가 정한다.
  try {
    const cfg = await MM.api('/api/config');
    if (cfg.kickedUrl) KICKED_URL = cfg.kickedUrl;
  } catch { /* 못 받으면 첫 화면으로 */ }

  try {
    const { room } = await MM.api(`/api/rooms/by-code/${CODE}`);
    roomName = room.name;
    $('gateRoom').textContent = room.name;
    if (room.hasPassword) $('passField').classList.remove('hidden');
    if (room.closed) {
      $('gateErr').textContent = '지금은 방이 닫혀 있습니다. GM이 열면 들어올 수 있습니다.';
      $('enterBtn').disabled = true;
      $('nick').disabled = true;
      return;
    }
  } catch (e) {
    $('gateRoom').textContent = '방을 찾을 수 없습니다';
    $('gateErr').textContent = e.message;
    $('enterBtn').disabled = true;
    return;
  }

  if (token()) {
    try {
      const { participant } = await MM.api('/api/me', { headers: authHeader() });
      me = participant;
      // 재접속이라 사용자 클릭이 없었으므로 오디오는 첫 상호작용 때 열린다.
      document.addEventListener('click', () => MM.Sound.unlock(), { once: true });
      document.addEventListener('keydown', () => MM.Sound.unlock(), { once: true });
      return start();
    } catch {
      localStorage.removeItem(TOKEN_KEY); // 만료된 토큰
    }
  }
  ($('passField').classList.contains('hidden') ? $('nick') : $('pass')).focus();
})();

$('enterBtn').addEventListener('click', async () => {
  const nickname = $('nick').value.trim();
  if (!nickname) { $('gateErr').textContent = '닉네임을 입력해 주세요'; return; }
  $('enterBtn').disabled = true;
  $('gateErr').textContent = '';
  MM.Sound.unlock();          // 사용자 클릭 시점 — 여기서만 오디오를 열 수 있다
  MM.Desktop.ask();
  try {
    const res = await MM.api(`/api/rooms/by-code/${CODE}/join`, {
      method: 'POST', body: { nickname, password: $('pass').value },
    });
    localStorage.setItem(TOKEN_KEY, res.token);
    me = res.participant;
    MM.Sound.reset();           // 새 방에 처음 들어오면 알림음 설정을 처음 상태로
    start();
  } catch (e) {
    $('gateErr').textContent = e.message;
    $('enterBtn').disabled = false;
  }
});
$('nick').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('enterBtn').click(); });
$('pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('nick').focus(); });

// ── 연결 ─────────────────────────────────────────────────────────────────────
function start() {
  $('gate').classList.add('hidden');
  $('chat').classList.remove('hidden');
  $('roomTitle').textContent = roomName;
  paintMe();
  mountMyColor();
  MY_ACTOR = `p:${me.id}`;
  // 서버에 깔아 둔 알림음·표시를 읽은 뒤 목록을 만든다
  MM.Sound.loadPresets().then(() => MM.mountSoundPicker($('soundKit'), $('soundBtn'), $('soundVol')));

  // 말풍선에 마우스를 올리면 나오는 표시 버튼
  MM.mountReactions($('msgs'), {
    onToggle: (messageId, emoji) => socket?.emit('reaction:toggle',
      { scope: 'msg', messageId, emoji },
      (res) => { if (res?.error) MM.toast(res.error, true); }),
  });

  // 이미지 붙여넣기(Ctrl+V)로 바로 보내기
  MM.onPasteFiles($('input'), uploadFiles);
  MM.enableLightbox($('msgs'));
  MM.enableLightbox($('fileList'));
  MM.enableLightbox($('starList'));
  // 대화창에 끌어다 놓으면 바로 GM에게 보낸다
  MM.makeDropzone($('msgs'), uploadFiles, () => 'GM에게 바로 보냅니다');

  // 라운드 타이머 — 끝나면 GM이 고른 소리로, 크기는 내 설정을 따른다.
  timer = MM.mountTimer($('timerBar'), {
    onDone: (t) => {
      MM.Sound.play(t.sound || 'alert');
      MM.alertIncoming('시간 종료', t.label || '라운드가 끝났습니다', 'timer');
    },
  });
  loadMemo();

  socket = io({ auth: { playerToken: token() } });

  socket.on('connect', () => setConn('연결됨', true));
  socket.on('disconnect', () => setConn('재연결 중…', false));
  socket.on('connect_error', () => setConn('재연결 중…', false));

  socket.on('auth:error', ({ error }) => {
    localStorage.removeItem(TOKEN_KEY);
    alert(error + '\n닉네임을 다시 설정해 주세요.');
    location.reload();
  });

  socket.on('timer', (t) => timer.set(t));

  socket.on('ask:mine', (mine) => {
    if (!mine) return;
    askCache.set(mine.id, mine);
    paintAsk(mine.id);
  });

  socket.on('ask:closed', ({ pollId, closed }) => {
    const c = askCache.get(pollId);
    if (c) { c.closed = closed; paintAsk(pollId); }
  });

  // GM이 모듈을 켜거나 끄면 탭이 달라진다. 새로 불러와야 반영된다.
  socket.on('modules:changed', () => {
    MM.toast('GM이 기능을 바꿨습니다. 화면을 새로 불러옵니다.');
    setTimeout(() => location.reload(), 1200);
  });

  socket.on('auth:ok', (data) => {
    // 이 방에서 켜진 모듈의 화면을 붙인다 (꺼져 있으면 아무 일도 없다).
    MM.Panels.load(data.modules || [], {
      side: 'player',
      tabsEl: $('ptabs'),
      panelsEl: $('paneChat').parentElement,
      tabAttr: 'ptab',
      panelAttr: 'ppane',
      paneClass: 'pane',
      ctx: {
        api: MM.api, headers: authHeader, get socket() { return socket; }, me,
        stars,                       // 모듈 화면에서도 ★ 즐겨찾기를 쓸 수 있게
        refreshStars: renderStars,
      },
    }).then(() =>
      // 대화 탭은 접을 수 없게 둔다 — 없으면 화면이 텅 빈다.
      MM.mountTabs($('ptabs'), {
        key: `player.${CODE}`, tabAttr: 'ptab', panelAttr: 'ppane', keep: ['chat'],
        onShow: (tab) => { if (tab === 'chat') scrollDown(true); },
      }));
    // 재접속 시 서버가 스레드 전체 이력을 다시 준다 — 로컬 캐시에 의존하지 않는다.
    if (data.nickname) { me.nickname = data.nickname; paintMe(); }
    messages = data.messages;
    timer.set(data.timer);
    renderAll();
    // 받아둔 질문지의 내 답을 다시 받아온다
    messages.filter((m) => m.kind === 'ask' && m.pollId).forEach((m) => {
      socket.emit('ask:fetch', { pollId: m.pollId }, (mine) => {
        if (mine) { askCache.set(mine.id, mine); paintAsk(mine.id); }
      });
    });
    socket.emit('player:read');
    if (data.closed) {
      systemLine('지금은 방이 닫혀 있습니다. GM이 열 때까지 기다려 주세요.');
      $('sendBtn').disabled = true;
      $('input').disabled = true;
      $('fileBtn').disabled = true;
    }
  });

  socket.on('message', (m) => {
    const atBottom = isAtBottom();
    messages.push(m);
    // 새 질문지가 오면 세부 항목을 바로 받아온다.
    if (m.kind === 'ask' && m.pollId) {
      socket.emit('ask:fetch', { pollId: m.pollId }, (mine) => {
        if (mine) { askCache.set(mine.id, mine); paintAsk(mine.id); }
      });
    }
    appendMessage(m);
    renderFiles();
    if (atBottom) scrollDown();
    if (m.kind === 'vans') {
      MM.Sound.play('verdict');                 // 정답에는 다른 소리
      MM.Title.bump();
    } else if (m.sender !== 'player') {
      MM.alertIncoming(m.senderName || 'GM', m.body || (m.file ? `📎 ${m.file.name}` : ''), 'gm');
      if (!document.hidden) socket.emit('player:read');
    }
  });

  socket.on('reaction', ({ messageId, reactions }) => {
    const hit = messages.find((m) => m.id === messageId);
    if (hit) hit.reactions = reactions;
    const el = document.querySelector(`.msg[data-id="${messageId}"] .rx`);
    if (el) el.outerHTML = MM.reactionsHtml(reactions, MY_ACTOR);
  });

  socket.on('message:deleted', ({ id }) => {
    const hit = messages.find((m) => m.id === id);
    if (hit) { hit.deleted = true; hit.body = null; delete hit.file; }
    const el = document.querySelector(`.msg[data-id="${id}"]`);
    if (el) renderDeleted(el);
    stars.remove(id);                 // 지워진 메시지는 즐겨찾기에서도 뺀다
    renderFiles();
    renderStars();
  });

  // 누군가 이름을 바꿨으면 이름표를 다시 그린다.
  socket.on('names:changed', async () => {
    try {
      const { participant } = await MM.api('/api/me', { headers: authHeader() });
      me = participant;
      paintMe();
    } catch { }
    socket.emit('player:refresh');
  });

  socket.on('history', (list) => { messages = list; renderAll(); });

  socket.on('typing', ({ from, on }) => {
    $('typing').textContent = from === 'gm' && on ? 'GM이 입력 중…' : '';
  });

  // 내보내졌으면 조용히 다른 곳으로 보낸다.
  // 안내를 띄우고 이 화면에 남겨두면 계속 다시 붙으려 하며 트래픽만 쓴다.
  socket.on('kicked', () => {
    try { localStorage.removeItem(TOKEN_KEY); } catch { }
    socket.io.opts.reconnection = false;
    socket.disconnect();
    location.replace(KICKED_URL);
  });

  socket.on('room:state', ({ closed }) => {
    systemLine(closed ? 'GM이 방을 닫았습니다. 잠시 기다려 주세요.' : 'GM이 방을 다시 열었습니다.');
    $('sendBtn').disabled = closed;
    $('input').disabled = closed;
    $('fileBtn').disabled = closed;
  });

  socket.on('room:deleted', () => {
    systemLine('이 방이 삭제되었습니다.');
    $('sendBtn').disabled = true;
    $('input').disabled = true;
    $('fileBtn').disabled = true;
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && socket.connected) socket.emit('player:read');
  });
}

function paintMe() {
  $('meName').textContent = me.nickname;
  $('meName').style.color = me.color || '';
  $('meRole').textContent = me.roleName ? ` · ${me.roleName}` : '';
  MM.Title.setBase(`${roomName} — ${me.nickname}`);
}

/** 내 이름 색. 함께 노는 사람들도 같은 색으로 본다 (공용 대화·주사위). */
function mountMyColor() {
  MM.mountColorPick($('meColorPick'), {
    value: me.color,
    save: async (color) => {
      try {
        const res = await MM.api('/api/me/color', {
          method: 'PUT', headers: authHeader(), body: { color },
        });
        me.color = res.color;
        paintMe();
      } catch (e) { MM.toast(e.message, true); }
    },
  });
}

function setConn(text, ok) {
  const el = $('connChip');
  el.textContent = text;
  el.classList.toggle('on', !!ok);
}

// ── 이름 바꾸기 ──────────────────────────────────────────────────────────────
$('renameBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  const next = prompt('새 닉네임', me.nickname);
  if (next === null) return;
  try {
    const res = await MM.api('/api/me/nickname', {
      method: 'PUT', headers: authHeader(), body: { nickname: next },
    });
    me.nickname = res.nickname;
    paintMe();
    renderAll();
    MM.toast('닉네임을 바꿨습니다');
  } catch (err) { MM.toast(err.message, true); }
});

// ── 렌더 ─────────────────────────────────────────────────────────────────────
function isAtBottom() {
  const el = $('msgs');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
function scrollDown(instant) {
  const el = $('msgs');
  el.scrollTo({ top: el.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
}

const fileUrl = (id) => `/f/${id}?t=${encodeURIComponent(token())}`;

function attachmentHtml(file) {
  const url = fileUrl(file.id);
  const head = `<a class="att" href="${url}${file.mime.startsWith('image/') ? '?dl=1' : ''}" target="_blank" rel="noopener">` +
    `<span class="ico">${MM.iconFor(file.mime)}</span>` +
    `<span class="nm">${MM.esc(file.name)}</span>` +
    `<span class="faint">${MM.sizeOf(file.size)}</span></a>`;
  if (file.mime.startsWith('image/')) {
    return head +
      `<img class="att-img" src="${url}" data-full="${url}" data-name="${MM.esc(file.name)}" alt="${MM.esc(file.name)}">`;
  }
  return head;
}

function bubbleHtml(m) {
  const parts = [];
  if (m.kind === 'broadcast') parts.push('<span class="bctag">전체 공지</span>');
  // 정답 답변에 보낼 이름을 비워두면 이름 줄을 아예 만들지 않는다.
  if (!(m.kind === 'vans' && !m.npcName)) {
    // 색은 플레이어가 고른 자기 이름 색이다 (GM 쪽 말에는 붙지 않는다 — messages.js 참고).
    const col = m.senderColor ? ` style="color:${m.senderColor}"` : '';
    parts.push(`<span class="who"${col}>${MM.esc(m.senderName || (m.sender === 'gm' ? 'GM' : me.nickname))}</span>`);
  }
  if (m.body) parts.push(`<span>${MM.esc(m.body)}</span>`);
  if (m.file) parts.push(attachmentHtml(m.file));
  parts.push(`<span class="stamp">${MM.timeOf(m.createdAt)}</span>`);
  parts.push(`<button class="star${stars.has(m.id) ? ' on' : ''}" title="즐겨찾기">★</button>`);
  if (m.sender === 'player') parts.push('<button class="del" title="삭제">×</button>');
  parts.push(MM.reactionsHtml(m.reactions, MY_ACTOR));
  return parts.join('');
}

function askHtml(m) {
  const data = askCache.get(m.pollId);
  const items = data?.items || [m.body];
  const closed = data?.closed;
  const rows = items.map((q, i) => {
    const list = (data?.mine?.[i] || []).slice(-2);   // 직전 답 + 지금 답
    const got = list.at(-1);                       // 마지막 답이 지금 답
    const old = list.slice(0, -1).map((a) => `<s class="faint">${MM.esc(a.body)}</s> `).join('');
    const editing = editingAns.has(`${m.pollId}:${i}`);
    // 답을 냈으면 입력칸 대신 내 답과 [수정] 버튼을 보여준다.
    const showInput = !closed && (!got || editing);
    const answered = got && !editing
      ? `<div class="mine"><span>✓ ${old}${MM.esc(got.body)}</span>
         ${closed ? '' : `<button class="ghost small" data-ansedit="${m.pollId}" data-idx="${i}">수정</button>`}</div>`
      : '';
    return `<div class="askitem">
      <div class="askq">${i + 1}. ${MM.esc(q)}</div>
      ${showInput ? `<div class="askrow">
        <input type="text" data-ansfor="${m.pollId}" data-idx="${i}"
               placeholder="답을 적고 Enter" maxlength="1000" value="${editing ? MM.esc(got?.body || '') : ''}">
        <button class="primary" data-anssend="${m.pollId}" data-idx="${i}">${editing ? '수정 완료' : '제출'}</button>
        ${editing ? `<button class="ghost" data-anscancel="${m.pollId}" data-idx="${i}">취소</button>` : ''}
      </div>` : ''}
      ${answered}
    </div>`;
  }).join('');
  return `<span class="asktag">${closed ? '마감됨' : '제출 요청'}</span>` +
         `<div class="asktitle">${MM.esc(m.body || '')}</div>${rows}`;
}

function appendMessage(m) {
  if (m.kind === 'answer') return;          // 내 답은 질문 카드 안에만 보인다
  if (m.deleted) return;                    // 지운 메시지는 흔적 없이 숨긴다
  const div = document.createElement('div');
  const mine = m.sender === 'player';
  div.dataset.id = m.id || '';
  if (m.kind === 'ask' && m.pollId && !m.deleted) {
    div.className = 'msg theirs askcard' + (askCache.get(m.pollId)?.closed ? ' closed' : '');
    div.dataset.poll = m.pollId;
    div.innerHTML = askHtml(m);
    $('msgs').appendChild(div);
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
    div.innerHTML = bubbleHtml(m);
  }
  $('msgs').appendChild(div);
}

function renderAll() {
  $('msgs').innerHTML = '';
  messages.forEach(appendMessage);
  scrollDown(true);
  renderFiles();
  renderStars();
}

// ── 즐겨찾기 탭 ──────────────────────────────────────────────────────────────
function renderStars() {
  const list = stars.list();
  $('starCount').textContent = list.length ? `(${list.length})` : '';
  $('starList').innerHTML = list.length === 0
    ? '<div class="empty">말풍선의 ★ 를 눌러 중요한 메시지를 담아두세요.<br>여기 모아서 볼 수 있습니다.</div>'
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
          <div class="bmhead"><span class="bmwho"${m.senderColor ? ` style="color:${m.senderColor}"` : ''}>${MM.esc(m.senderName || '')}</span>
            <span class="faint">${MM.dateTimeOf(m.createdAt)}</span></div>
          ${m.body ? `<div class="bmbody">${MM.esc(m.body)}</div>` : ''}
          ${thumb}${fileRow}
          <div class="bmacts"><button class="ghost" data-unstar="${m.id}">즐겨찾기 해제</button></div>
        </div>`;
      }).join('');
}

$('starList').addEventListener('click', (e) => {
  const id = e.target.dataset?.unstar;
  if (!id) return;
  stars.remove(id);
  renderStars();
  const btn = document.querySelector(`.msg[data-id="${id}"] .star`);
  if (btn) btn.classList.remove('on');
});

function renderDeleted(el) {
  el.remove();                              // 「삭제된 메시지」 자리도 남기지 않는다
}

/** 질문지 카드를 다시 그린다 (내 답이나 마감 상태가 바뀌었을 때). */
function paintAsk(pollId) {
  const m = messages.find((x) => x.kind === 'ask' && x.pollId === pollId);
  if (!m || m.deleted) return;
  const el = document.querySelector(`.msg[data-poll="${pollId}"]`);
  if (!el) return;
  // 다시 그리면 입력칸이 새로 생기므로, 아직 제출 안 한 다른 항목의 글을 옮겨 둔다.
  const drafts = {};
  let focused = null;
  el.querySelectorAll('input[data-ansfor]').forEach((inp) => {
    drafts[inp.dataset.idx] = inp.value;
    if (inp === document.activeElement) focused = inp.dataset.idx;
  });
  el.className = 'msg theirs askcard' + (askCache.get(pollId)?.closed ? ' closed' : '');
  el.innerHTML = askHtml(m);
  el.querySelectorAll('input[data-ansfor]').forEach((inp) => {
    const d = drafts[inp.dataset.idx];
    if (d) inp.value = d;
    if (inp.dataset.idx === focused) inp.focus();
  });
}

// 질문지 답 제출
$('msgs').addEventListener('keydown', (e) => {
  if (e.target.dataset?.ansfor && e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    sendAnswer(e.target.dataset.ansfor, Number(e.target.dataset.idx), e.target);
  }
});
$('msgs').addEventListener('click', (e) => {
  const d = e.target.dataset || {};
  const idx = Number(d.idx);
  if (d.ansedit || d.anscancel) {
    const pollId = d.ansedit || d.anscancel;
    const key = `${pollId}:${idx}`;
    if (d.ansedit) editingAns.add(key); else editingAns.delete(key);
    paintAsk(pollId);
    if (d.ansedit) {
      const input = document.querySelector(`input[data-ansfor="${pollId}"][data-idx="${idx}"]`);
      if (input) { input.focus(); input.select(); }
    }
    return;
  }
  const poll = d.anssend;
  if (!poll) return;
  const input = document.querySelector(`input[data-ansfor="${poll}"][data-idx="${idx}"]`);
  sendAnswer(poll, idx, input);
});

function sendAnswer(pollId, itemIndex, input) {
  const body = (input?.value || '').trim();
  if (!body) return;
  const key = `${pollId}:${itemIndex}`;
  const wasEditing = editingAns.has(key);
  socket.emit('player:answer', { pollId, itemIndex, body }, (res) => {
    if (res?.error) return MM.toast(res.error, true);
    if (input) input.value = '';
    editingAns.delete(key);
    paintAsk(pollId);
    if (wasEditing) MM.toast('답을 수정했습니다');
    MM.Sound.play('send');
  });
}

$('msgs').addEventListener('click', (e) => {
  if (e.target.classList?.contains('star')) {
    const id = e.target.closest('.msg')?.dataset.id;
    const m = messages.find((x) => x.id === id);
    if (!m) return;
    const on = stars.toggle(m);
    e.target.classList.toggle('on', on);
    renderStars();
    MM.toast(on ? '즐겨찾기에 담았습니다' : '즐겨찾기에서 뺐습니다');
    return;
  }
  if (!e.target.classList?.contains('del')) return;
  const id = e.target.closest('.msg')?.dataset.id;
  if (!id || !confirm('이 메시지를 지울까요? GM 화면에서도 사라집니다.')) return;
  socket.emit('message:delete', { messageId: id }, (res) => {
    if (res?.error) MM.toast(res.error, true);
  });
});

function systemLine(text) {
  appendMessage({ sender: 'system', body: text, createdAt: Date.now() });
  scrollDown();
}

// ── 받은 자료 탭 ─────────────────────────────────────────────────────────────
function renderFiles() {
  const got = messages.filter((m) => m.file && !m.deleted && m.sender === 'gm');
  $('fileCount').textContent = got.length ? `(${got.length})` : '';
  $('fileList').innerHTML = got.length === 0
    ? '<div class="empty">아직 GM에게 받은 자료가 없습니다.</div>'
    : got.slice().reverse().map((m) => {
        const url = fileUrl(m.file.id);
        const thumb = m.file.mime.startsWith('image/')
          ? `<img class="att-img" src="${url}" data-full="${url}" data-name="${MM.esc(m.file.name)}" alt="">`
          : '';
        return `<div class="filecard">
          <div class="row">
            <span class="ico">${MM.iconFor(m.file.mime)}</span>
            <span class="grow"><b>${MM.esc(m.file.name)}</b>
              <div class="faint">${MM.sizeOf(m.file.size)} · ${MM.dateTimeOf(m.createdAt)}</div></span>
            <a class="ghost btnlink" href="${url}" target="_blank" rel="noopener">열기</a>
            <a class="ghost btnlink" href="${url}${url.includes('?') ? '&' : '?'}dl=1">저장</a>
          </div>${thumb}
        </div>`;
      }).join('');
}

// ── 개인 메모 (내 브라우저에만 저장) ─────────────────────────────────────────
function loadMemo() {
  try { $('memo').value = localStorage.getItem(MEMO_KEY) || ''; } catch { }
}
let memoTimer = null;
$('memo').addEventListener('input', () => {
  clearTimeout(memoTimer);
  $('memoState').textContent = '';
  memoTimer = setTimeout(() => {
    try {
      localStorage.setItem(MEMO_KEY, $('memo').value);
      $('memoState').textContent = '· 저장됨';
    } catch {
      $('memoState').textContent = '· 저장 실패 (브라우저 설정 확인)';
    }
  }, 500);
});

// 도움말에는 방 코드를 함께 넘긴다 — 이 방에서 켜진 모듈의 사용법까지 보여주려고.
$('helpBtn').addEventListener('click', () => {
  window.open(`/guide.html?room=${encodeURIComponent(CODE)}`, '_blank');
});

$('exportMine').addEventListener('click', () => {
  window.open(`/api/me/export?t=${encodeURIComponent(token())}`, '_blank');
});

// ── 전송 ─────────────────────────────────────────────────────────────────────
function send() {
  const input = $('input');
  const body = input.value.trim();
  if (!body || !socket?.connected) return;
  socket.emit('player:send', { body }, (res) => {
    if (res?.error) MM.toast(res.error, true);
  });
  input.value = '';
  MM.autoGrow(input);
  emitTyping(false);
  MM.Sound.play('send');
}

$('sendBtn').addEventListener('click', send);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$('input').addEventListener('input', (e) => {
  MM.autoGrow(e.target);
  emitTyping(e.target.value.length > 0);
});

function emitTyping(on) {
  if (!socket?.connected) return;
  if (on !== lastSentTyping) { socket.emit('typing', { on }); lastSentTyping = on; }
  clearTimeout(typingTimer);
  if (on) typingTimer = setTimeout(() => emitTyping(false), 4000);
}

// ── 파일 업로드 ──────────────────────────────────────────────────────────────
$('fileBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  uploadFiles(files);
});

async function uploadFiles(files) {
  if (!files.length) return;
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  $('uploadState').textContent = `전송 중… (${files.length}개)`;
  try {
    await MM.api('/api/player/upload', { method: 'POST', body: fd, headers: authHeader() });
    $('uploadState').textContent = '';
    MM.Sound.play('send');
  } catch (err) {
    $('uploadState').textContent = '';
    MM.toast(err.message, true);
  }
}

'use strict';
const express = require('express');
const { db } = require('./db');
const SET = require('./settings');
const {
  newId, newToken, hash, newRoomCode, verifyGmLink, verifyPlayer, identify, cleanColor,
} = require('./auth');
const M = require('./messages');
const REG = require('./modules');
const MODSTATE = require('./modules/state');

const router = express.Router();
const DEFAULT_TTL_DAYS = 7;
const MAX_NICK = 20;

// 인터넷에 열어두면 주소를 아는 누구나 방을 만들 수 있다. 그러면 남이
// 디스크를 채울 수 있으므로, 암호를 요구할 수 있게 해 둔다.
//
//   REQUIRE_CREATE_PASSWORD=true   → CREATE_PASSWORD 를 아는 사람만 방을 만든다
//   REQUIRE_CREATE_PASSWORD=false  → 누구나 방을 만든다
//
// 값을 아예 적지 않으면 예전처럼 'CREATE_PASSWORD 가 있으면 요구'로 동작한다.
// 값은 src/settings.local.json 파일에서도 읽는다 (YAML을 고치기 어려운 NAS용).
// 파일을 고치면 몇 초 안에 반영되므로 다시 시작하지 않아도 된다.
const createPassword = () => SET.str('CREATE_PASSWORD', '');
const requireCreatePassword = () => {
  const explicit = SET.bool('REQUIRE_CREATE_PASSWORD');
  return explicit === undefined ? !!createPassword() : explicit;
};

// 암호가 없더라도 무한정 만들지는 못하게 한다.
const CREATE_MAX = 20;
const CREATE_WINDOW = 60 * 60 * 1000;      // 1시간
const creates = new Map();                 // ip -> [시각, …]

function tooManyRooms(req) {
  const now = Date.now();
  const list = (creates.get(req.ip) || []).filter((t) => now - t < CREATE_WINDOW);
  if (list.length >= CREATE_MAX) { creates.set(req.ip, list); return true; }
  list.push(now);
  creates.set(req.ip, list);
  return false;
}

// 암호 무차별 대입 억제. 프로세스 메모리로 충분하다 — 서버 한 대에 세션 하나다.
const MAX_TRIES = 8;
const LOCK_MS = 60_000;
const attempts = new Map();                 // "ip|roomId" -> { n, until }
const attemptKey = (req, roomId) => `${req.ip}|${roomId}`;

function tooManyAttempts(req, roomId) {
  const rec = attempts.get(attemptKey(req, roomId));
  if (!rec) return false;
  if (rec.until && rec.until > Date.now()) return true;
  if (rec.until && rec.until <= Date.now()) { attempts.delete(attemptKey(req, roomId)); return false; }
  return false;
}
function noteFailure(req, roomId) {
  const key = attemptKey(req, roomId);
  const rec = attempts.get(key) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= MAX_TRIES) { rec.until = Date.now() + LOCK_MS; rec.n = 0; }
  attempts.set(key, rec);
}
const clearFailures = (req, roomId) => attempts.delete(attemptKey(req, roomId));

// 인증 없이도 보이는 방 정보. 모듈 목록은 여기에 넣지 않는다 —
// 어떤 기능을 쓰는지는 방에 들어온 사람에게만 알린다 (auth:ok · /api/me).
function publicRoom(room) {
  return {
    id: room.id, code: room.code, name: room.name,
    closed: !!room.closed, joinLocked: !!room.join_locked, expiresAt: room.expires_at,
    hasPassword: !!room.pass_code,   // 암호 유무만 알린다. 값은 GM에게만.
    hasGmPassword: !!room.gm_pass_code,
  };
}

function participantView(p) {
  const role = p.role_id
    ? db.prepare('SELECT name FROM roles WHERE id = ?').get(p.role_id)
    : null;
  return {
    id: p.id,
    nickname: p.nickname,
    color: p.color || null,
    online: !!p.online,
    unread: p.gm_unread,
    joinedAt: p.joined_at,
    lastSeen: p.last_seen,
    roleId: p.role_id || null,
    roleName: role?.name || null,
  };
}

/** GM 인증 미들웨어. req.room을 채운다. */
// 문지기는 guards.js 한 곳에 모여 있다 (기존 이름은 그대로 다시 내보낸다).
const { requireGm } = require('./guards');

// ── 방 개설 ──────────────────────────────────────────────────────────────────
/**
 * 화면이 미리 알아야 하는 것들 (로그인 전에 부른다).
 *   needsCreatePassword — 방 만들기에 암호가 필요한가
 *   kickedUrl           — 내보낸 사람을 어디로 보낼 것인가 (안 정하면 첫 화면)
 *   publicUrl           — 플레이어 링크를 만들 주소 (터널 주소 등). 모르면 null
 */
router.get('/config', (_req, res) => {
  res.json({
    needsCreatePassword: requireCreatePassword(),
    kickedUrl: SET.str('KICKED_URL', ''),
    publicUrl: require('./tunnel-url').known(),
  });
});

router.post('/rooms', (req, res) => {
  if (requireCreatePassword()) {
    const wanted = createPassword();
    if (!wanted) {
      return res.status(503).json({
        error: '서버 암호가 설정되지 않았습니다. 서버 관리자에게 알려주세요',
      });
    }
    const given = String(req.body?.createPassword || '').trim();
    if (given !== wanted) {
      return res.status(401).json({ error: '서버 암호가 맞지 않습니다' });
    }
  }
  if (tooManyRooms(req)) {
    return res.status(429).json({ error: '방을 너무 많이 만들었습니다. 잠시 후 다시 시도하세요' });
  }

  const name = String(req.body?.name || '').trim().slice(0, 60) || '이름 없는 세션';
  const days = Math.min(Math.max(Number(req.body?.days) || DEFAULT_TTL_DAYS, 1), 30);
  const passCode = String(req.body?.password || '').trim().slice(0, 40) || null;
  const gmPassCode = String(req.body?.gmPassword || '').trim().slice(0, 40) || null;
  const gmNickname = String(req.body?.gmNickname || '').trim().slice(0, MAX_NICK) || 'GM';
  // 방을 만들 때 고른 모듈. 아무것도 안 주면 기본으로 켜지는 것만.
  const modules = req.body?.modules === undefined
    ? REG.defaultIds()
    : MODSTATE.normalize(req.body.modules, REG.ids());
  const now = Date.now();
  const room = {
    id: newId(),
    code: newRoomCode(),
    name,
    gm_token_hash: '',
    created_at: now,
    expires_at: now + days * 86400_000,
    closed: 0,
    pass_code: passCode,
    gm_pass_code: gmPassCode,
    modules: JSON.stringify(modules),
  };
  const gmToken = newToken();
  room.gm_token_hash = hash(gmToken);
  db.prepare(`INSERT INTO rooms (id, code, name, gm_token_hash, created_at, expires_at, closed, pass_code, gm_pass_code, modules)
              VALUES (@id, @code, @name, @gm_token_hash, @created_at, @expires_at, @closed, @pass_code, @gm_pass_code, @modules)`).run(room);

  // 방을 만든 사람이 첫 번째 GM이 된다.
  const { createGm, gmView } = require('./gms');
  const first = createGm({ roomId: room.id, nickname: gmNickname, isOwner: true });

  res.json({
    room: publicRoom(room),
    linkToken: gmToken,          // GM 초대 링크에 실리는 열쇠
    gmToken: first.token,        // 방을 만든 사람의 개인 세션 토큰
    gm: gmView(first.gm),
  });
});

// ── 플레이어가 보는 방 정보 (참가자 목록은 절대 포함하지 않는다) ─────────────
router.get('/rooms/by-code/:code', (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE code = ?').get(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ error: '존재하지 않는 방입니다' });
  res.json({ room: publicRoom(room) });
});

// ── GM 로그인 화면이 방 이름과 암호 유무를 알기 위해 쓴다 (링크 열쇠 필요) ───
router.get('/rooms/by-id/:id', (req, res) => {
  const room = verifyGmLink(req.params.id, req.query.link);
  if (!room) return res.status(403).json({ error: 'GM 링크가 올바르지 않습니다' });
  res.json({ room: publicRoom(room) });
});

// ── 입장 ─────────────────────────────────────────────────────────────────────
router.post('/rooms/by-code/:code/join', (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE code = ?').get(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ error: '존재하지 않는 방입니다' });
  if (room.closed) return res.status(410).json({ error: '이미 종료된 방입니다' });
  if (room.expires_at < Date.now()) return res.status(410).json({ error: '만료된 방입니다' });
  // 잠가 두면 새로 들어오는 것만 막는다. 이미 들어온 사람은 토큰으로 그대로 이어서 쓴다.
  if (room.join_locked) return res.status(423).json({ error: '지금은 새로 입장할 수 없습니다. GM에게 문의하세요' });

  if (room.pass_code) {
    const limited = tooManyAttempts(req, room.id);
    if (limited) return res.status(429).json({ error: '시도가 너무 잦습니다. 잠시 후 다시 해주세요' });
    const given = String(req.body?.password || '').trim();
    if (given !== room.pass_code) {
      noteFailure(req, room.id);
      return res.status(401).json({ error: '입장 암호가 맞지 않습니다' });
    }
    clearFailures(req, room.id);
  }

  const nickname = String(req.body?.nickname || '').trim().slice(0, MAX_NICK);
  if (!nickname) return res.status(400).json({ error: '닉네임을 입력해 주세요' });

  const dupe = db.prepare('SELECT 1 FROM participants WHERE room_id = ? AND nickname = ? AND kicked_at IS NULL')
    .get(room.id, nickname);
  // 토큰 없이 같은 닉네임으로 들어오는 것은 도용일 수 있으므로 막는다.
  if (dupe) return res.status(409).json({ error: '이미 사용 중인 닉네임입니다' });

  const token = newToken();
  const now = Date.now();
  const p = {
    id: newId(), room_id: room.id, nickname,
    token_hash: hash(token), joined_at: now, last_seen: now, online: 0, gm_unread: 0,
  };
  db.prepare(`INSERT INTO participants (id, room_id, nickname, token_hash, joined_at, last_seen, online, gm_unread)
              VALUES (@id, @room_id, @nickname, @token_hash, @joined_at, @last_seen, @online, @gm_unread)`).run(p);

  M.notifyGm(room.id, 'participant:joined', participantView(p));
  res.json({ room: publicRoom(room), participant: { id: p.id, nickname }, token });
});

// ── 토큰으로 재접속 확인 ─────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const found = verifyPlayer(req.get('x-player-token') || req.query.t);
  if (!found) return res.status(401).json({ error: '세션이 없습니다' });
  const role = found.participant.role_id
    ? db.prepare('SELECT name FROM roles WHERE id = ?').get(found.participant.role_id)
    : null;
  res.json({
    room: publicRoom(found.room),
    // 이 방에 들어온 사람에게만 알린다 (가이드에서 쓰는 법을 보여주려고).
    modules: REG.playerKnown(MODSTATE.enabledIds(found.room)),
    participant: {
      id: found.participant.id,
      nickname: found.participant.nickname,
      color: found.participant.color || null,
      roleName: role?.name || null,
    },
  });
});

// ── GM: 방 정보 ──────────────────────────────────────────────────────────────
router.get('/gm/room', requireGm, (req, res) => {
  res.json({
    room: {
      ...publicRoom(req.room),
      // GM 화면은 숨김 모듈까지 다 본다
      modules: MODSTATE.enabledIds(req.room),
      password: req.room.pass_code || '',
      gmPassword: req.room.gm_pass_code || '',
    },
  });
});

// 세션 중 암호를 바꾸거나 없앤다 (빈 값이면 암호 없음).
router.put('/gm/password', requireGm, (req, res) => {
  const passCode = String(req.body?.password || '').trim().slice(0, 40) || null;
  db.prepare('UPDATE rooms SET pass_code = ? WHERE id = ?').run(passCode, req.room.id);
  res.json({ password: passCode || '' });
});

// ── GM: 참가자 목록 ──────────────────────────────────────────────────────────
router.get('/gm/participants', requireGm, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM participants WHERE room_id = ? AND kicked_at IS NULL ORDER BY COALESCE(sort_order, 999999), joined_at ASC'
  ).all(req.room.id);
  res.json({ participants: rows.map(participantView) });
});

// ── GM: 특정 스레드 전체 이력 ────────────────────────────────────────────────
router.get('/gm/threads/:pid', requireGm, (req, res) => {
  const p = db.prepare('SELECT * FROM participants WHERE id = ? AND room_id = ?').get(req.params.pid, req.room.id);
  if (!p) return res.status(404).json({ error: '참가자를 찾을 수 없습니다' });
  M.clearGmUnread(p.id);
  // 지난 이력에도 NPC 뒤의 GM을 붙여 준다 — 새로 오는 말과 같은 모습으로 보이게.
  res.json({ participant: participantView(p), messages: M.history(req.room.id, p.id).map(M.gmView) });
});

// ── GM: 참가자 이름 변경 / 내보내기 ──────────────────────────────────────────
router.patch('/gm/participants/:pid', requireGm, (req, res) => {
  const nickname = String(req.body?.nickname || '').trim().slice(0, MAX_NICK);
  if (!nickname) return res.status(400).json({ error: '닉네임이 비어 있습니다' });
  try {
    db.prepare('UPDATE participants SET nickname = ? WHERE id = ? AND room_id = ?').run(nickname, req.params.pid, req.room.id);
  } catch {
    return res.status(409).json({ error: '이미 사용 중인 닉네임입니다' });
  }
  res.json({ ok: true });
});

// ── GM: 플레이어 목록 순서 (드래그로 정한 순서를 저장) ───────────────────────
router.put('/gm/participants/order', requireGm, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const stmt = db.prepare('UPDATE participants SET sort_order = ? WHERE id = ? AND room_id = ?');
  db.transaction(() => {
    ids.forEach((id, i) => stmt.run(i, id, req.room.id));
  })();
  res.json({ ok: true });
});

// ── 플레이어: 내 닉네임 바꾸기 ───────────────────────────────────────────────
router.put('/me/nickname', (req, res) => {
  const found = verifyPlayer(req.get('x-player-token') || req.query.t);
  if (!found) return res.status(401).json({ error: '세션이 없습니다' });
  const nickname = String(req.body?.nickname || '').trim().slice(0, MAX_NICK);
  if (!nickname) return res.status(400).json({ error: '닉네임이 비어 있습니다' });

  const taken = db.prepare('SELECT 1 FROM participants WHERE room_id = ? AND nickname = ? AND id != ?')
    .get(found.room.id, nickname, found.participant.id);
  if (taken) return res.status(409).json({ error: '이미 사용 중인 닉네임입니다' });

  db.prepare('UPDATE participants SET nickname = ? WHERE id = ?').run(nickname, found.participant.id);
  const fresh = db.prepare('SELECT * FROM participants WHERE id = ?').get(found.participant.id);
  M.notifyGm(found.room.id, 'participant:renamed', participantView(fresh));
  M.notifyRenamed(found.room.id);
  res.json({ nickname });
});

// ── 플레이어: 내 이름 색 ─────────────────────────────────────────────────────
router.put('/me/color', (req, res) => {
  const found = verifyPlayer(req.get('x-player-token') || req.query.t);
  if (!found) return res.status(401).json({ error: '세션이 없습니다' });
  const color = cleanColor(req.body?.color);
  if (color === undefined) return res.status(400).json({ error: '색 형식이 올바르지 않습니다' });

  db.prepare('UPDATE participants SET color = ? WHERE id = ?').run(color, found.participant.id);
  const fresh = db.prepare('SELECT * FROM participants WHERE id = ?').get(found.participant.id);
  M.notifyGm(found.room.id, 'participant:renamed', participantView(fresh));
  M.notifyRenamed(found.room.id);
  res.json({ color });
});

// ── GM: 방 닫기 / 다시 열기 ──────────────────────────────────────────────────
// '닫기'는 세션을 끝내는 게 아니라 플레이어의 입장·발송을 잠시 멈추는 것이다.
// 잘못 눌러도 언제든 다시 열 수 있어야 한다.
router.post('/gm/close', requireGm, (req, res) => {
  const closed = req.body?.closed === undefined ? true : !!req.body.closed;
  db.prepare('UPDATE rooms SET closed = ? WHERE id = ?').run(closed ? 1 : 0, req.room.id);
  M.notifyRoomState(req.room.id, closed);
  res.json({ closed });
});

// ── GM: 방을 정말로 지운다 (되돌릴 수 없다) ──────────────────────────────────
// ── 새 입장 잠그기 ───────────────────────────────────────────────────────────
// 난입을 막는 장치다. 방 닫기와 달리 이미 들어온 사람은 아무 영향이 없다.
router.post('/gm/lock', requireGm, (req, res) => {
  const locked = !!req.body?.locked;
  db.prepare('UPDATE rooms SET join_locked = ? WHERE id = ?').run(locked ? 1 : 0, req.room.id);
  M.notifyGm(req.room.id, 'room:lock', { locked });
  res.json({ locked });
});

// ── 플레이어 내보내기 ────────────────────────────────────────────────────────
// 토큰을 못 쓰게 만들고, 접속 중이면 바로 끊고, GM 화면 목록에서 뺀다.
// 대화 기록은 남겨 둔다 (내보내기에는 그대로 나온다).
router.delete('/gm/participants/:pid', requireGm, (req, res) => {
  const p = db.prepare('SELECT * FROM participants WHERE id = ? AND room_id = ? AND kicked_at IS NULL')
    .get(req.params.pid, req.room.id);
  if (!p) return res.status(404).json({ error: '없는 플레이어입니다' });

  db.prepare('UPDATE participants SET kicked_at = ?, online = 0 WHERE id = ?').run(Date.now(), p.id);
  M.kickParticipant(req.room.id, p.id);
  M.notifyGm(req.room.id, 'participant:kicked', { id: p.id, nickname: p.nickname });
  res.json({ ok: true, nickname: p.nickname });
});

router.delete('/gm/room', requireGm, (req, res) => {
  // 실수를 막기 위해 세션 이름(또는 방 코드)을 정확히 적어야 지워진다.
  const typed = String(req.body?.confirmCode || '').trim();
  const ok = typed.toUpperCase() === req.room.code || typed === req.room.name.trim();
  if (!ok) {
    return res.status(400).json({ error: '세션 이름이 맞지 않습니다' });
  }
  // 기록뿐 아니라 NAS에 저장된 파일까지 지운다.
  require('./cleanup').purgeRoom(req.room.id);
  res.json({ ok: true });
});

module.exports = { router, requireGm, publicRoom, participantView };

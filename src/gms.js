'use strict';
const express = require('express');
const { db } = require('./db');
const { newId, newToken, hash, verifyGmLink, identify, cleanColor } = require('./auth');
const M = require('./messages');

const router = express.Router();
const MAX_NICK = 20;

const gmView = (g) => ({
  id: g.id,
  nickname: g.nickname,
  color: g.color || null,
  online: !!g.online,
  isOwner: !!g.is_owner,
  joinedAt: g.joined_at,
});

function listGms(roomId) {
  return db.prepare('SELECT * FROM gms WHERE room_id = ? ORDER BY joined_at ASC')
    .all(roomId).map(gmView);
}

/** 방에 GM 한 명을 등록하고 개인 세션 토큰을 발급한다. */
function createGm({ roomId, nickname, isOwner = false }) {
  const token = newToken();
  const now = Date.now();
  const gm = {
    id: newId(), room_id: roomId, nickname,
    token_hash: hash(token), joined_at: now, last_seen: now,
    online: 0, is_owner: isOwner ? 1 : 0,
  };
  db.prepare(`INSERT INTO gms (id, room_id, nickname, token_hash, joined_at, last_seen, online, is_owner)
              VALUES (@id, @room_id, @nickname, @token_hash, @joined_at, @last_seen, @online, @is_owner)`).run(gm);
  return { gm, token };
}

// 문지기는 guards.js 한 곳에 모여 있다.
const { requireGm: gmOnly } = require('./guards');

// ── GM 로그인 ────────────────────────────────────────────────────────────────
// GM 링크(열쇠) + GM 암호 + 닉네임이 모두 맞아야 개인 토큰을 준다.
router.post('/gm/login', (req, res) => {
  const roomId = String(req.body?.roomId || '');
  const room = verifyGmLink(roomId, req.body?.linkToken);
  if (!room) return res.status(403).json({ error: 'GM 링크가 올바르지 않습니다' });
  // 닫힌 방에도 GM은 들어갈 수 있어야 한다 — 들어가서 다시 열어야 하므로.

  if (room.gm_pass_code) {
    const given = String(req.body?.password || '').trim();
    if (given !== room.gm_pass_code) return res.status(401).json({ error: 'GM 암호가 맞지 않습니다' });
  }

  const nickname = String(req.body?.nickname || '').trim().slice(0, MAX_NICK);
  if (!nickname) return res.status(400).json({ error: '닉네임을 입력해 주세요' });

  const taken = db.prepare('SELECT 1 FROM gms WHERE room_id = ? AND nickname = ?').get(room.id, nickname);
  if (taken) return res.status(409).json({ error: '이미 사용 중인 GM 닉네임입니다' });

  const { gm, token } = createGm({ roomId: room.id, nickname });
  M.notifyGm(room.id, 'gm:joined', gmView(gm));
  res.json({ token, gm: gmView(gm) });
});

/** 저장된 토큰으로 되돌아왔을 때 */
router.get('/gm/me', gmOnly, (req, res) => {
  res.json({ gm: gmView(req.gm), gms: listGms(req.room.id) });
});

router.get('/gm/gms', gmOnly, (req, res) => {
  res.json({ gms: listGms(req.room.id) });
});

// ── 내 닉네임 바꾸기 ─────────────────────────────────────────────────────────
router.put('/gm/me/nickname', gmOnly, (req, res) => {
  const nickname = String(req.body?.nickname || '').trim().slice(0, MAX_NICK);
  if (!nickname) return res.status(400).json({ error: '닉네임이 비어 있습니다' });
  const taken = db.prepare('SELECT 1 FROM gms WHERE room_id = ? AND nickname = ? AND id != ?')
    .get(req.room.id, nickname, req.gm.id);
  if (taken) return res.status(409).json({ error: '이미 사용 중인 닉네임입니다' });

  db.prepare('UPDATE gms SET nickname = ? WHERE id = ?').run(nickname, req.gm.id);
  M.notifyGm(req.room.id, 'gm:changed', { gms: listGms(req.room.id) });
  M.notifyRenamed(req.room.id);            // 플레이어 화면의 이름표도 갱신한다
  res.json({ nickname });
});

// ── 내 이름 색 ───────────────────────────────────────────────────────────────
// 여럿이 함께 진행할 때 누가 한 말인지 한눈에 보이라고 두는 것이다.
router.put('/gm/me/color', gmOnly, (req, res) => {
  const color = cleanColor(req.body?.color);
  if (color === undefined) return res.status(400).json({ error: '색 형식이 올바르지 않습니다' });

  db.prepare('UPDATE gms SET color = ? WHERE id = ?').run(color, req.gm.id);
  M.notifyGm(req.room.id, 'gm:changed', { gms: listGms(req.room.id) });
  M.notifyRenamed(req.room.id);            // 플레이어 화면의 이름표도 함께 갱신한다
  res.json({ color });
});

// ── GM 암호 ──────────────────────────────────────────────────────────────────
router.put('/gm/gmpassword', gmOnly, (req, res) => {
  const code = String(req.body?.password || '').trim().slice(0, 40) || null;
  db.prepare('UPDATE rooms SET gm_pass_code = ? WHERE id = ?').run(code, req.room.id);
  res.json({ password: code || '' });
});

// ── GM끼리의 대화 ────────────────────────────────────────────────────────────
const ALL = 'all';
/** 두 GM의 1:1 채널 키. 순서와 무관하게 같은 키가 나오도록 정렬해 잇는다. */
const dmKey = (a, b) => [a, b].sort().join('|');

/** 요청한 채널이 이 GM이 볼 수 있는 것인지 확인하고 정규화한다. */
function resolveChannel(gm, raw) {
  if (!raw || raw === ALL) return ALL;
  const other = db.prepare('SELECT id FROM gms WHERE id = ? AND room_id = ?').get(raw, gm.room_id);
  if (!other) return null;
  return dmKey(gm.id, other.id);
}

router.get('/gm/chat/:channel', gmOnly, (req, res) => {
  const channel = resolveChannel(req.gm, req.params.channel);
  if (!channel) return res.status(404).json({ error: '없는 대화입니다' });
  res.json({ messages: M.gmHistory(req.room.id, channel) });
});

module.exports = { router, createGm, listGms, gmView, gmOnly, dmKey, ALL, resolveChannel };

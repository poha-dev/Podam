'use strict';
const crypto = require('crypto');
const { db } = require('./db');

const newId = () => crypto.randomBytes(12).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// 헷갈리기 쉬운 글자(0/O, 1/I) 제외한 방 코드
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    const taken = db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(code);
    if (!taken) return code;
  }
  throw new Error('방 코드를 생성하지 못했습니다');
}

/** GM '초대 링크' 열쇠를 검증한다. 방에 들어올 자격이 아니라, 로그인 화면을
 *  볼 자격까지만 준다 — 실제 입장은 GM 암호가 있어야 한다. */
function verifyGmLink(roomId, token) {
  if (!roomId || !token) return null;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) return null;
  const a = Buffer.from(room.gm_token_hash);
  const b = Buffer.from(hash(token));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return room;
}

/** GM 개인 세션 토큰을 검증하고 { gm, room }을 반환한다. 실패하면 null. */
function verifyGm(token) {
  if (!token) return null;
  const gm = db.prepare('SELECT * FROM gms WHERE token_hash = ?').get(hash(token));
  if (!gm) return null;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(gm.room_id);
  if (!room) return null;
  return { gm, room };
}

/** 플레이어 토큰을 검증하고 { participant, room }을 반환한다. 실패하면 null. */
function verifyPlayer(token) {
  if (!token) return null;
  const p = db.prepare('SELECT * FROM participants WHERE token_hash = ?').get(hash(token));
  if (!p || p.kicked_at) return null;     // 내보낸 사람은 이 토큰으로 다시 못 들어온다
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(p.room_id);
  if (!room) return null;
  return { participant: p, room };
}

/** 요청자의 신원을 판별한다. { role:'gm', room } | { role:'player', room, participant } | null */
function identify(req) {
  const gmToken = req.get('x-gm-token') || req.query.gm;
  if (gmToken) {
    const found = verifyGm(gmToken);
    if (found) return { role: 'gm', room: found.room, gm: found.gm };
    return null;
  }
  const pToken = req.get('x-player-token') || req.query.t;
  if (pToken) {
    const found = verifyPlayer(pToken);
    if (found) return { role: 'player', room: found.room, participant: found.participant };
  }
  return null;
}

/**
 * 이름 색. **#rrggbb 여섯 자리만** 받아들인다 (빈 값은 '색 없음').
 * 이 값이 그대로 style 속성에 들어가므로 아무 글자나 통과시키면 안 된다.
 */
function cleanColor(v) {
  const c = String(v == null ? '' : v).trim().toLowerCase();
  if (!c) return null;
  return /^#[0-9a-f]{6}$/.test(c) ? c : undefined;   // undefined = 잘못된 값
}

module.exports = {
  newId, newToken, hash, newRoomCode, verifyGmLink, verifyGm, verifyPlayer, identify, cleanColor,
};

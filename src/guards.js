'use strict';
const { identify } = require('./auth');

/**
 * 라우트 앞에 세우는 문지기들.
 *
 * 예전에는 같은 `gmOnly` 가 파일마다 복사돼 있었다. 한 군데를 고치면 나머지가
 * 어긋나므로 여기로 모았다. 신원은 언제나 토큰에서 다시 확인하고,
 * 클라이언트가 보낸 roomId·participantId 는 절대 그대로 쓰지 않는다.
 */

/** GM만 통과. req.room 과 req.gm 을 채운다. */
function requireGm(req, res, next) {
  const who = identify(req);
  if (!who || who.role !== 'gm') return res.status(403).json({ error: '권한이 없습니다' });
  // 방이 닫혀 있어도 GM은 계속 쓸 수 있다 — '닫기'는 플레이어만 멈춘다.
  req.room = who.room;
  req.gm = who.gm;
  next();
}

/** 플레이어만 통과. req.room 과 req.participant 를 채운다. */
function requirePlayer(req, res, next) {
  const who = identify(req);
  if (!who || who.role !== 'player') return res.status(403).json({ error: '권한이 없습니다' });
  req.room = who.room;
  req.participant = who.participant;
  next();
}

module.exports = { requireGm, requirePlayer };

'use strict';
const { db } = require('./db');

/** 요청된 대상 중 이 방에 실제로 존재하는 참가자만 남긴다. */
function validTargets(roomId, targets) {
  if (!Array.isArray(targets) || targets.length === 0) return [];
  const rows = db.prepare('SELECT id FROM participants WHERE room_id = ? AND kicked_at IS NULL').all(roomId);
  const allowed = new Set(rows.map((r) => r.id));
  return [...new Set(targets.filter((t) => allowed.has(t)))];
}

/** 이 방의 모든 참가자 id (전체 공지용) */
function allParticipantIds(roomId) {
  return db.prepare('SELECT id FROM participants WHERE room_id = ? AND kicked_at IS NULL')
    .all(roomId).map((r) => r.id);
}

module.exports = { validTargets, allParticipantIds };

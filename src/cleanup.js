'use strict';
const fs = require('fs');
const path = require('path');
const { db, UPLOAD_DIR } = require('./db');
const M = require('./messages');

// 보관 기간이 끝나고 이만큼 더 지나면 방을 통째로 지운다.
// 그 사이에는 GM이 들어가 기록을 내보낼 수 있다. 0이면 자동 정리를 끈다.
const GRACE_DAYS = require('./settings').num('PURGE_GRACE_DAYS', 30);
const DAY = 86400_000;
const EVERY = 60 * 60 * 1000;   // 한 시간마다 확인

/** 방과 그 방의 기록·파일을 모두 지운다. DB 행은 CASCADE로, 디스크 파일은 직접. */
function purgeRoom(roomId) {
  const stored = db.prepare('SELECT stored FROM files WHERE room_id = ?').all(roomId).map((f) => f.stored);
  M.notifyRoomDeleted(roomId);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
  for (const name of stored) {
    if (name) fs.rm(path.join(UPLOAD_DIR, path.basename(name)), { force: true }, () => {});
  }
  return stored.length;
}

/** 보관 기간 + 유예 기간이 모두 지난 방을 지운다. */
function sweep(now = Date.now()) {
  if (!(GRACE_DAYS > 0)) return [];
  const due = db.prepare('SELECT id, code, name FROM rooms WHERE expires_at + ? < ?')
    .all(GRACE_DAYS * DAY, now);
  for (const r of due) {
    const files = purgeRoom(r.id);
    console.log(`[자동 정리] ${r.name} (${r.code}) — 파일 ${files}개 삭제`);
  }
  return due;
}

function start() {
  if (!(GRACE_DAYS > 0)) return;
  try { sweep(); } catch (e) { console.error('[자동 정리] 실패', e); }
  setInterval(() => {
    try { sweep(); } catch (e) { console.error('[자동 정리] 실패', e); }
  }, EVERY).unref();
}

module.exports = { purgeRoom, sweep, start, GRACE_DAYS };

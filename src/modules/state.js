'use strict';
const { db } = require('../db');

/**
 * 방마다 어떤 모듈을 켰는지. rooms.modules 컬럼에 id 배열(JSON)로 둔다.
 *
 * 별도 테이블을 쓰지 않는 이유: 이 검사는 모듈 API 호출마다, 플레이어 발화마다
 * 일어난다. 방 행은 토큰을 검증할 때 이미 읽어 오므로 여기서는 추가 질의가 없다.
 */

/** 이 방에서 켜진 모듈 id 목록. 값이 깨져 있으면 '전부 꺼짐'으로 본다. */
function enabledIds(room) {
  if (!room) return [];
  try {
    const list = JSON.parse(room.modules || '[]');
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const isEnabled = (room, id) => enabledIds(room).includes(id);

/**
 * 바깥에서 들어온 목록을 쓸 수 있는 형태로 다듬는다.
 * 모르는 id는 조용히 버린다 — 예전에 만든 룸 셋팅을 그대로 열 수 있어야 한다.
 */
function normalize(input, catalogIds) {
  const known = new Set(catalogIds);
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const raw of list) {
    const id = String(raw || '').trim();
    if (known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 방의 모듈 목록을 통째로 저장한다. */
function setEnabled(roomId, ids) {
  db.prepare('UPDATE rooms SET modules = ? WHERE id = ?').run(JSON.stringify(ids), roomId);
  return ids;
}

/** 하나만 켜고 끈다. */
function toggle(room, id, on) {
  const now = enabledIds(room);
  const next = on ? (now.includes(id) ? now : [...now, id]) : now.filter((x) => x !== id);
  return setEnabled(room.id, next);
}

module.exports = { enabledIds, isEnabled, normalize, setEnabled, toggle };

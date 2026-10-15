'use strict';
const express = require('express');
const { db } = require('./db');
const { identify } = require('./auth');
const M = require('./messages');

const router = express.Router();
const MAX_MS = 12 * 60 * 60 * 1000;   // 12시간

function gmOnly(req, res, next) {
  const who = identify(req);
  if (!who || who.role !== 'gm') return res.status(403).json({ error: '권한이 없습니다' });
  req.room = who.room;
  next();
}

const row = (roomId) => db.prepare('SELECT * FROM timers WHERE room_id = ?').get(roomId);

/** 화면에 필요한 형태. 실행 중이면 끝나는 시각을, 멈춰 있으면 남은 시간을 준다. */
function view(roomId) {
  const t = row(roomId);
  if (!t) return { exists: false };
  return {
    exists: true,
    label: t.label || '',
    durationMs: t.duration_ms,
    running: !!t.running,
    endsAt: t.running ? t.ends_at : null,
    remainingMs: t.running ? Math.max(0, t.ends_at - Date.now()) : (t.remaining_ms ?? t.duration_ms),
    sound: t.sound || 'alert',
  };
}

/** 타이머 상태를 GM과 모든 플레이어에게 알린다. */
function broadcast(roomId) {
  M.notifyEveryone(roomId, 'timer', view(roomId));
}

const upsert = db.prepare(`
  INSERT INTO timers (room_id, label, duration_ms, ends_at, remaining_ms, running, sound, updated_at)
  VALUES (@room_id, @label, @duration_ms, @ends_at, @remaining_ms, @running, @sound, @updated_at)
  ON CONFLICT(room_id) DO UPDATE SET
    label = @label, duration_ms = @duration_ms, ends_at = @ends_at,
    remaining_ms = @remaining_ms, running = @running, sound = @sound, updated_at = @updated_at
`);

function save(roomId, patch) {
  const cur = row(roomId) || {
    room_id: roomId, label: '', duration_ms: 0, ends_at: null,
    remaining_ms: null, running: 0, sound: 'alert',
  };
  upsert.run({ ...cur, ...patch, room_id: roomId, updated_at: Date.now() });
}

router.get('/timer', (req, res) => {
  const who = identify(req);
  if (!who) return res.status(403).json({ error: '권한이 없습니다' });
  res.json({ timer: view(who.room.id) });
});

/**
 * 타이머를 다룬다. action:
 *   set    — 시간을 새로 정한다 (멈춘 상태로)
 *   start  — 남은 시간부터 시작 (ms를 주면 그 시간으로 새로 시작)
 *   pause  — 멈춘다. 남은 시간은 유지
 *   reset  — 처음 정한 시간으로 되돌리고 멈춘다
 *   clear  — 타이머를 치운다
 */
router.post('/gm/timer', gmOnly, (req, res) => {
  const roomId = req.room.id;
  const action = String(req.body?.action || '');
  const label = req.body?.label !== undefined
    ? String(req.body.label).trim().slice(0, 30) : undefined;
  const sound = req.body?.sound !== undefined
    ? String(req.body.sound).slice(0, 20) : undefined;
  const ms = Number(req.body?.ms);
  const cur = row(roomId);
  const common = {};
  if (label !== undefined) common.label = label;
  if (sound !== undefined) common.sound = sound;

  switch (action) {
    case 'set': {
      if (!Number.isFinite(ms) || ms < 0 || ms > MAX_MS) {
        return res.status(400).json({ error: '시간이 올바르지 않습니다' });
      }
      save(roomId, { ...common, duration_ms: ms, remaining_ms: ms, ends_at: null, running: 0 });
      break;
    }
    case 'start': {
      // ms를 주면 그 시간으로 새로 시작하고, 없으면 남은 시간부터 이어서 간다.
      let left = Number.isFinite(ms) && ms > 0
        ? Math.min(ms, MAX_MS)
        : (cur?.running ? Math.max(0, cur.ends_at - Date.now()) : (cur?.remaining_ms ?? cur?.duration_ms ?? 0));
      if (left <= 0) return res.status(400).json({ error: '먼저 시간을 정해 주세요' });
      const duration = Number.isFinite(ms) && ms > 0 ? left : (cur?.duration_ms || left);
      save(roomId, { ...common, duration_ms: duration, ends_at: Date.now() + left, remaining_ms: null, running: 1 });
      break;
    }
    case 'pause': {
      if (!cur?.running) { save(roomId, common); break; }
      save(roomId, { ...common, running: 0, remaining_ms: Math.max(0, cur.ends_at - Date.now()), ends_at: null });
      break;
    }
    case 'reset': {
      if (!cur) return res.status(400).json({ error: '설정된 타이머가 없습니다' });
      save(roomId, { ...common, running: 0, remaining_ms: cur.duration_ms, ends_at: null });
      break;
    }
    case 'clear': {
      db.prepare('DELETE FROM timers WHERE room_id = ?').run(roomId);
      broadcast(roomId);
      return res.json({ timer: { exists: false } });
    }
    default:
      // 이름이나 소리만 바꾸는 경우
      if (!cur) return res.status(400).json({ error: '알 수 없는 동작입니다' });
      save(roomId, common);
  }

  broadcast(roomId);
  res.json({ timer: view(roomId) });
});

module.exports = { router, view, broadcast };

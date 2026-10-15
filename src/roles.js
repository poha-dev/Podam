'use strict';
const express = require('express');
const { db } = require('./db');
const { newId, identify } = require('./auth');
const M = require('./messages');

const router = express.Router();
const MAX_NAME = 30;

function gmOnly(req, res, next) {
  const who = identify(req);
  if (!who || who.role !== 'gm') return res.status(403).json({ error: '권한이 없습니다' });
  req.room = who.room;
  next();
}

const roleView = (r) => ({ id: r.id, name: r.name, sort: r.sort });

/** 배역 목록 + 각 배역에 배정된 참가자와 자료 수 */
function listRoles(roomId) {
  const roles = db.prepare('SELECT * FROM roles WHERE room_id = ? ORDER BY sort ASC, created_at ASC').all(roomId);
  const holders = db.prepare('SELECT id, nickname, role_id FROM participants WHERE room_id = ? AND role_id IS NOT NULL AND kicked_at IS NULL').all(roomId);
  const counts = db.prepare(
    'SELECT role_id, COUNT(*) n FROM files WHERE room_id = ? AND is_preset = 1 AND role_id IS NOT NULL GROUP BY role_id'
  ).all(roomId);
  const holderOf = new Map(holders.map((h) => [h.role_id, h]));
  const countOf = new Map(counts.map((c) => [c.role_id, c.n]));
  return roles.map((r) => ({
    ...roleView(r),
    fileCount: countOf.get(r.id) || 0,
    holder: holderOf.get(r.id) ? { id: holderOf.get(r.id).id, nickname: holderOf.get(r.id).nickname } : null,
  }));
}

router.get('/gm/roles', gmOnly, (req, res) => {
  res.json({ roles: listRoles(req.room.id) });
});

// ── 배역 만들기 (여러 개를 줄바꿈으로 한 번에) ───────────────────────────────
router.post('/gm/roles', gmOnly, (req, res) => {
  const names = (Array.isArray(req.body?.names) ? req.body.names : [req.body?.name])
    .map((n) => String(n || '').trim().slice(0, MAX_NAME))
    .filter(Boolean);
  if (names.length === 0) return res.status(400).json({ error: '배역 이름을 입력해 주세요' });

  const base = db.prepare('SELECT COALESCE(MAX(sort), -1) m FROM roles WHERE room_id = ?').get(req.room.id).m;
  const stmt = db.prepare(
    'INSERT INTO roles (id, room_id, name, sort, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const now = Date.now();
  db.transaction(() => {
    names.forEach((name, i) => stmt.run(newId(), req.room.id, name, base + 1 + i, now));
  })();

  M.notifyGm(req.room.id, 'roles:changed', {});
  res.json({ roles: listRoles(req.room.id) });
});

router.patch('/gm/roles/:id', gmOnly, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, MAX_NAME);
  if (!name) return res.status(400).json({ error: '배역 이름이 비어 있습니다' });
  const info = db.prepare('UPDATE roles SET name = ? WHERE id = ? AND room_id = ?')
    .run(name, req.params.id, req.room.id);
  if (info.changes === 0) return res.status(404).json({ error: '없는 배역입니다' });
  M.notifyGm(req.room.id, 'roles:changed', {});
  res.json({ roles: listRoles(req.room.id) });
});

// ── 배역 삭제 ────────────────────────────────────────────────────────────────
// 자료와 배정은 지우지 않고 배역만 떼어낸다 — 자료함의 파일이 사라지면 곤란하다.
router.delete('/gm/roles/:id', gmOnly, (req, res) => {
  const role = db.prepare('SELECT id FROM roles WHERE id = ? AND room_id = ?').get(req.params.id, req.room.id);
  if (!role) return res.status(404).json({ error: '없는 배역입니다' });
  db.transaction(() => {
    db.prepare('UPDATE files SET role_id = NULL WHERE role_id = ?').run(role.id);
    db.prepare('UPDATE participants SET role_id = NULL WHERE role_id = ?').run(role.id);
    db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  })();
  M.notifyGm(req.room.id, 'roles:changed', {});
  res.json({ roles: listRoles(req.room.id) });
});

// ── 플레이어에게 배역 배정 ───────────────────────────────────────────────────
router.put('/gm/participants/:pid/role', gmOnly, (req, res) => {
  const p = db.prepare('SELECT id FROM participants WHERE id = ? AND room_id = ?')
    .get(req.params.pid, req.room.id);
  if (!p) return res.status(404).json({ error: '없는 참가자입니다' });

  const roleId = req.body?.roleId || null;
  if (roleId) {
    const role = db.prepare('SELECT id FROM roles WHERE id = ? AND room_id = ?').get(roleId, req.room.id);
    if (!role) return res.status(404).json({ error: '없는 배역입니다' });
    // 한 배역은 한 사람에게만 — 먼저 잡고 있던 사람에게서 뗀다.
    db.prepare('UPDATE participants SET role_id = NULL WHERE role_id = ? AND room_id = ?').run(roleId, req.room.id);
  }
  db.prepare('UPDATE participants SET role_id = ? WHERE id = ?').run(roleId, p.id);

  M.notifyGm(req.room.id, 'roles:changed', {});
  res.json({ roles: listRoles(req.room.id) });
});

module.exports = { router, listRoles };

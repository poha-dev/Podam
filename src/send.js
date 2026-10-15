'use strict';
const express = require('express');
const { db } = require('./db');
const { identify } = require('./auth');
const M = require('./messages');
const { validTargets, allParticipantIds } = require('./targets');
const { upload, insertFile, fileView } = require('./upload');

const router = express.Router();

// 문지기는 guards.js 한 곳에 모여 있다.
const { requireGm: gmOnly } = require('./guards');

/** 요청의 대상 지정을 실제 참가자 id 배열로 바꾼다. */
function resolveTargets(room, body) {
  return body?.all ? allParticipantIds(room.id) : validTargets(room.id, body?.targets);
}

const kindFor = (targets, fileId) => (fileId ? 'file' : targets.length > 1 ? 'broadcast' : 'text');

function dispatch({ room, targets, body, fileId, fromGmId, npcName }) {
  M.deliverMany({
    roomId: room.id,
    participantIds: targets,
    sender: 'gm',
    kind: kindFor(targets, fileId),
    body: body || null,
    fileId: fileId || null,
    fromGmId: fromGmId || null,
    npcName: npcName || null,
  });
  return { count: targets.length };
}

const npcOf = (req) => String(req.body?.npcName || '').trim().slice(0, 30) || null;

// ── GM 발송 (텍스트 또는 자료함의 파일) ──────────────────────────────────────
router.post('/gm/send', gmOnly, (req, res) => {
  const targets = resolveTargets(req.room, req.body);
  if (targets.length === 0) return res.status(400).json({ error: '받는 사람을 선택해 주세요' });

  const body = String(req.body?.body || '').trim().slice(0, 4000) || null;
  const fileId = req.body?.fileId || null;
  if (fileId) {
    const f = db.prepare('SELECT id FROM files WHERE id = ? AND room_id = ?').get(fileId, req.room.id);
    if (!f) return res.status(404).json({ error: '없는 파일입니다' });
  }
  if (!body && !fileId) return res.status(400).json({ error: '보낼 내용이 없습니다' });

  res.json(dispatch({ room: req.room, targets, body, fileId, fromGmId: req.gm.id, npcName: npcOf(req) }));
});

// ── GM 즉석 파일 발송 (자료함을 거치지 않고 바로) ────────────────────────────
router.post('/gm/upload-send', gmOnly, upload.array('files', 10), (req, res) => {
  const parsedTargets = req.body?.targets ? JSON.parse(req.body.targets) : [];
  const targets = resolveTargets(req.room, { all: req.body?.all === 'true', targets: parsedTargets });
  if (targets.length === 0) return res.status(400).json({ error: '받는 사람을 선택해 주세요' });

  const body = String(req.body?.body || '').trim().slice(0, 4000) || null;
  const keep = req.body?.keep === 'true';        // 자료함에도 남길지
  const roleId = req.body?.roleId || null;       // 남길 때 어느 배역 자료함에

  let sent = 0;
  for (const f of req.files || []) {
    const row = insertFile({
      roomId: req.room.id, uploader: 'gm', file: f, isPreset: keep, roleId: keep ? roleId : null,
    });
    dispatch({ room: req.room, targets, body: null, fileId: row.id, fromGmId: req.gm.id, npcName: npcOf(req) });
    sent++;
  }
  if (body) { dispatch({ room: req.room, targets, body, fileId: null, fromGmId: req.gm.id, npcName: npcOf(req) }); sent++; }
  if (sent === 0) return res.status(400).json({ error: '보낼 내용이 없습니다' });
  res.json({ count: targets.length, sent });
});

// ── 배역별 일괄 발송 ─────────────────────────────────────────────────────────
// 배역을 맡은 사람 각각에게 '그 배역 자료함에서 아직 안 보낸 첫 자료'를 보낸다.
// 라운드마다 이 버튼 하나로 넘길 수 있게 하려는 것이다.
router.post('/gm/send-role-batch', gmOnly, (req, res) => {
  const roles = db.prepare('SELECT * FROM roles WHERE room_id = ? ORDER BY sort, created_at')
    .all(req.room.id);

  const nextFile = db.prepare(`
    SELECT f.* FROM files f
    WHERE f.room_id = ? AND f.role_id = ? AND f.is_preset = 1
      AND NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.file_id = f.id AND m.participant_id = ? AND m.deleted_at IS NULL
      )
    ORDER BY COALESCE(f.sort_order, 999999), f.created_at ASC, f.rowid ASC
    LIMIT 1
  `);

  const sent = [];
  const skipped = [];
  for (const role of roles) {
    const holder = db.prepare('SELECT * FROM participants WHERE room_id = ? AND role_id = ? AND kicked_at IS NULL')
      .get(req.room.id, role.id);
    if (!holder) { skipped.push({ role: role.name, reason: '배역 미배정' }); continue; }

    const file = nextFile.get(req.room.id, role.id, holder.id);
    if (!file) { skipped.push({ role: role.name, reason: '보낼 자료 없음' }); continue; }

    dispatch({
      room: req.room, targets: [holder.id], body: null,
      fileId: file.id, fromGmId: req.gm.id,
    });
    sent.push({ role: role.name, to: holder.nickname, file: file.filename });
  }

  res.json({ sent, skipped });
});

/** 배역별로 '다음에 나갈 자료'의 id를 모아준다. 자료함에 표시하려고 쓴다. */
router.get('/gm/next-files', gmOnly, (req, res) => {
  const roles = db.prepare('SELECT * FROM roles WHERE room_id = ? ORDER BY sort, created_at')
    .all(req.room.id);
  const nextFile = db.prepare(`
    SELECT f.id FROM files f
    WHERE f.room_id = ? AND f.role_id = ? AND f.is_preset = 1
      AND NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.file_id = f.id AND m.participant_id = ? AND m.deleted_at IS NULL
      )
    ORDER BY COALESCE(f.sort_order, 999999), f.created_at ASC, f.rowid ASC
    LIMIT 1
  `);
  const next = {};
  for (const role of roles) {
    const holder = db.prepare('SELECT id FROM participants WHERE room_id = ? AND role_id = ? AND kicked_at IS NULL')
      .get(req.room.id, role.id);
    if (!holder) continue;
    const f = nextFile.get(req.room.id, role.id, holder.id);
    if (f) next[role.id] = f.id;
  }
  res.json({ next });
});

/** 다음에 무엇이 나갈지 미리 보여준다 (버튼을 누르기 전에 확인용). */
router.get('/gm/send-role-batch/preview', gmOnly, (req, res) => {
  const roles = db.prepare('SELECT * FROM roles WHERE room_id = ? ORDER BY sort, created_at')
    .all(req.room.id);
  const nextFile = db.prepare(`
    SELECT f.* FROM files f
    WHERE f.room_id = ? AND f.role_id = ? AND f.is_preset = 1
      AND NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.file_id = f.id AND m.participant_id = ? AND m.deleted_at IS NULL
      )
    ORDER BY COALESCE(f.sort_order, 999999), f.created_at ASC, f.rowid ASC
    LIMIT 1
  `);
  const plan = roles.map((role) => {
    const holder = db.prepare('SELECT * FROM participants WHERE room_id = ? AND role_id = ? AND kicked_at IS NULL')
      .get(req.room.id, role.id);
    if (!holder) return { role: role.name, to: null, file: null, reason: '배역 미배정' };
    const file = nextFile.get(req.room.id, role.id, holder.id);
    return {
      role: role.name, to: holder.nickname,
      file: file ? file.filename : null,
      reason: file ? null : '보낼 자료 없음',
    };
  });
  res.json({ plan });
});

module.exports = { router };

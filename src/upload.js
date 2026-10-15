'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { db, UPLOAD_DIR } = require('./db');
const { newId, identify } = require('./auth');
const M = require('./messages');

const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 50;

// 확장자로 판단한다. 브라우저가 보내는 MIME은 믿을 수 없기 때문이다 —
// zip은 application/x-zip-compressed로도 오고, 한글(hwp)은 대개
// application/octet-stream으로 온다.
const ALLOWED_EXT = new Set([
  // 문서
  'pdf', 'txt', 'md', 'rtf', 'csv',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'hwp', 'hwpx', 'odt', 'ods', 'odp',
  // 이미지
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'avif',
  // 압축
  'zip', '7z', 'rar', 'tar', 'gz',
  // 소리
  'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac',
  // 영상
  'mp4', 'webm', 'mov', 'mkv',
]);

// 실행 파일과 스크립트는 물론이고 html/svg도 막는다. 업로드된 파일은
// 이 앱과 같은 출처에서 제공되므로, 브라우저에서 실행되는 문서를 허용하면
// 남의 세션을 훔칠 수 있는 스크립트를 심을 수 있다.
const BLOCKED_EXT = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'dll', 'sys',
  'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'js', 'mjs', 'jse', 'jar', 'sh', 'app',
  'html', 'htm', 'xhtml', 'svg', 'mhtml', 'xml',
]);

// 브라우저에서 바로 열어 보여줘도 안전한 것들. 나머지는 내려받기로 처리한다.
const INLINE_MIME = /^(image\/(png|jpe?g|gif|webp|bmp|avif)|application\/pdf|audio\/|video\/|text\/plain)/;

const extOf = (name) => (name.split('.').pop() || '').toLowerCase();

function decodeName(name) {
  // multer는 파일명을 latin1로 넘겨줘 한글이 깨진다.
  try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { return name; }
}

// 원본 파일명은 DB에만 두고, 디스크에는 랜덤 id로 저장한다 (경로 조작 차단).
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, _file, cb) => cb(null, newId() + '.bin'),
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = extOf(decodeName(file.originalname));
    if (!ext || BLOCKED_EXT.has(ext) || !ALLOWED_EXT.has(ext)) {
      const err = new Error(`보낼 수 없는 파일 형식입니다 (.${ext || '확장자 없음'})`);
      err.status = 415;
      return cb(err);
    }
    cb(null, true);
  },
});

const router = express.Router();

function insertFile({ roomId, uploader, participantId, file, isPreset, label, roleId }) {
  const row = {
    id: newId(),
    room_id: roomId,
    uploader,
    participant_id: participantId || null,
    filename: decodeName(file.originalname).slice(0, 200),
    mime: file.mimetype,
    size: file.size,
    stored: file.filename,
    is_preset: isPreset ? 1 : 0,
    label: label || null,
    role_id: roleId || null,
    created_at: Date.now(),
  };
  db.prepare(`INSERT INTO files (id, room_id, uploader, participant_id, filename, mime, size, stored, is_preset, label, role_id, created_at)
              VALUES (@id, @room_id, @uploader, @participant_id, @filename, @mime, @size, @stored, @is_preset, @label, @role_id, @created_at)`).run(row);
  return row;
}

const fileView = (f) => ({
  id: f.id, name: f.filename, mime: f.mime, size: f.size,
  label: f.label, isPreset: !!f.is_preset, roleId: f.role_id || null, createdAt: f.created_at,
});

// ── GM 자료함 업로드 (아직 아무에게도 발송되지 않음) ─────────────────────────
router.post('/api/gm/library', upload.array('files', 10), (req, res) => {
  const who = identify(req);
  if (!who || who.role !== 'gm') return res.status(403).json({ error: '권한이 없습니다' });
  const label = String(req.body?.label || '').trim().slice(0, 60) || null;
  const roleId = req.body?.roleId || null;
  if (roleId) {
    const role = db.prepare('SELECT id FROM roles WHERE id = ? AND room_id = ?').get(roleId, who.room.id);
    if (!role) return res.status(404).json({ error: '없는 배역입니다' });
  }
  const rows = (req.files || []).map((f) =>
    insertFile({ roomId: who.room.id, uploader: 'gm', file: f, isPreset: true, label, roleId })
  );
  res.json({ files: rows.map(fileView) });
});

router.get('/api/gm/library', (req, res) => {
  const who = identify(req);
  if (!who || who.role !== 'gm') return res.status(403).json({ error: '권한이 없습니다' });
  const rows = db.prepare(
    // 일괄 발송이 나가는 순서와 반드시 같아야 한다. 목록은 최신순인데
     // 발송은 오래된 순이면, 위에 있는 자료가 안 나가는 것처럼 보인다.
     `SELECT * FROM files WHERE room_id = ? AND uploader = ? AND is_preset = 1
      -- 같은 요청으로 여러 개를 올리면 created_at 이 같을 수 있다.
      -- rowid 를 마지막 기준으로 두어 올린 순서가 항상 그대로 유지되게 한다.
      ORDER BY COALESCE(sort_order, 999999), created_at ASC, rowid ASC`
  ).all(who.room.id, 'gm');
  res.json({ files: rows.map(fileView) });
});

// 드래그로 정한 자료 순서를 저장한다.
router.put('/api/gm/library/order', (req, res) => {
  const who = identify(req);
  if (!who || who.role !== 'gm') return res.status(403).json({ error: '권한이 없습니다' });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const stmt = db.prepare('UPDATE files SET sort_order = ? WHERE id = ? AND room_id = ?');
  db.transaction(() => { ids.forEach((id, i) => stmt.run(i, id, who.room.id)); })();
  res.json({ ok: true });
});

router.patch('/api/gm/library/:id', (req, res) => {
  const who = identify(req);
  if (!who || who.role !== 'gm') return res.status(403).json({ error: '권한이 없습니다' });
  const f = db.prepare('SELECT id FROM files WHERE id = ? AND room_id = ?').get(req.params.id, who.room.id);
  if (!f) return res.status(404).json({ error: '없는 파일입니다' });
  const roleId = req.body?.roleId || null;
  if (roleId) {
    const role = db.prepare('SELECT id FROM roles WHERE id = ? AND room_id = ?').get(roleId, who.room.id);
    if (!role) return res.status(404).json({ error: '없는 배역입니다' });
  }
  db.prepare('UPDATE files SET role_id = ? WHERE id = ?').run(roleId, f.id);
  res.json({ ok: true });
});

/** 자료함에서 한 건을 뺀다. 이미 보낸 자료는 기록이 깨지지 않게 숨기기만 한다. */
function removeLibraryFile(f) {
  const used = db.prepare('SELECT 1 FROM messages WHERE file_id = ?').get(f.id)
    || db.prepare('SELECT 1 FROM gm_messages WHERE file_id = ?').get(f.id)
    // 모듈이 쓰고 있는 파일도 지우면 안 된다 (무대 배경·캐릭터 그림 등).
    // 지우면 화면에는 남아 있는데 실물이 없어 깨진 그림이 된다.
    || require('./modules/hooks').fileInUse(f);
  if (used) {
    db.prepare('UPDATE files SET is_preset = 0 WHERE id = ?').run(f.id);
    return 'hidden';
  }
  db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
  fs.rm(path.join(UPLOAD_DIR, f.stored), { force: true }, () => {});
  return 'deleted';
}

// ── 자료함 일괄 비우기 ───────────────────────────────────────────────────────
// scope: 'all'(전부) | 'common'(배역 없는 공용) | 배역 id
router.post('/api/gm/library/clear', (req, res) => {
  const who = identify(req);
  if (!who || who.role !== 'gm') return res.status(403).json({ error: '권한이 없습니다' });
  const scope = String(req.body?.scope || '').trim();
  if (!scope) return res.status(400).json({ error: '어디를 비울지 정해 주세요' });

  let rows;
  if (scope === 'all') {
    rows = db.prepare('SELECT * FROM files WHERE room_id = ? AND uploader = ? AND is_preset = 1')
      .all(who.room.id, 'gm');
  } else if (scope === 'common') {
    rows = db.prepare('SELECT * FROM files WHERE room_id = ? AND uploader = ? AND is_preset = 1 AND role_id IS NULL')
      .all(who.room.id, 'gm');
  } else {
    const role = db.prepare('SELECT id FROM roles WHERE id = ? AND room_id = ?').get(scope, who.room.id);
    if (!role) return res.status(404).json({ error: '없는 배역입니다' });
    rows = db.prepare('SELECT * FROM files WHERE room_id = ? AND uploader = ? AND is_preset = 1 AND role_id = ?')
      .all(who.room.id, 'gm', role.id);
  }

  let deleted = 0, hidden = 0;
  for (const f of rows) (removeLibraryFile(f) === 'deleted' ? deleted++ : hidden++);
  res.json({ removed: rows.length, deleted, hidden });
});

router.delete('/api/gm/library/:id', (req, res) => {
  const who = identify(req);
  if (!who || who.role !== 'gm') return res.status(403).json({ error: '권한이 없습니다' });
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND room_id = ?').get(req.params.id, who.room.id);
  if (!f) return res.status(404).json({ error: '없는 파일입니다' });
  removeLibraryFile(f);
  res.json({ ok: true });
});

// ── GM끼리의 대화에 파일 보내기 (붙여넣기 포함) ──────────────────────────────
router.post('/api/gm/chat/:channel/upload', upload.array('files', 10), (req, res) => {
  const who = identify(req);
  if (!who || who.role !== 'gm') return res.status(403).json({ error: '권한이 없습니다' });
  const G = require('./gms');                     // 순환 참조를 피해 여기서 부른다
  const gm = db.prepare('SELECT * FROM gms WHERE id = ?').get(who.gm.id);
  const channel = G.resolveChannel(gm, req.params.channel);
  if (!channel) return res.status(404).json({ error: '없는 대화입니다' });

  const body = String(req.body?.body || '').trim().slice(0, 4000) || null;
  let sent = 0;
  for (const f of req.files || []) {
    const row = insertFile({ roomId: who.room.id, uploader: 'gm', file: f, isPreset: false });
    M.deliverGm({ roomId: who.room.id, channel, fromGmId: gm.id, kind: 'file', fileId: row.id });
    sent++;
  }
  if (body) { M.deliverGm({ roomId: who.room.id, channel, fromGmId: gm.id, body }); sent++; }
  if (sent === 0) return res.status(400).json({ error: '보낼 내용이 없습니다' });
  res.json({ sent });
});

// ── 플레이어 → GM 파일 전송 ──────────────────────────────────────────────────
router.post('/api/player/upload', upload.array('files', 5), (req, res) => {
  const who = identify(req);
  if (!who || who.role !== 'player') return res.status(403).json({ error: '권한이 없습니다' });
  if (who.room.closed) return res.status(410).json({ error: '종료된 방입니다' });
  const sent = (req.files || []).map((f) => {
    const row = insertFile({
      roomId: who.room.id, uploader: 'player', participantId: who.participant.id, file: f, isPreset: false,
    });
    return M.deliver({
      roomId: who.room.id,
      participantId: who.participant.id,
      sender: 'player',
      kind: 'file',
      body: String(req.body?.body || '').trim().slice(0, 500) || null,
      fileId: row.id,
    });
  });
  res.json({ sent: sent.length });
});

// ── 다운로드: 본인 스레드의 파일이거나 GM일 때만 ─────────────────────────────
router.get('/f/:fileId', (req, res) => {
  const who = identify(req);
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.fileId);
  // 권한 실패와 부재를 구분하지 않는다 — 파일 존재 자체가 정보이므로.
  if (!f || !who || who.room.id !== f.room_id) return res.status(404).json({ error: '찾을 수 없습니다' });

  if (who.role === 'player') {
    const mine = db.prepare(
      'SELECT 1 FROM messages WHERE file_id = ? AND participant_id = ? AND room_id = ? AND deleted_at IS NULL'
    ).get(f.id, who.participant.id, f.room_id);
    // 내 스레드 파일이 아니면, 모듈이 **공용으로 내놓은** 파일인지 한 번 더 묻는다
    // (예: 공용 무대의 배경·음악·첨부). 아무도 허락하지 않으면 없는 것처럼 답한다.
    const shared = !mine && require('./modules/hooks').fileAccess({
      roomId: f.room_id, participantId: who.participant.id, file: f,
    });
    if (!mine && !shared) return res.status(404).json({ error: '찾을 수 없습니다' });
  }

  const abs = path.join(UPLOAD_DIR, f.stored);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '파일이 사라졌습니다' });
  const inlineOk = INLINE_MIME.test(f.mime) && !BLOCKED_EXT.has(extOf(f.filename));
  const disposition = req.query.dl || !inlineOk ? 'attachment' : 'inline';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type(inlineOk ? f.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition',
    `${disposition}; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.sendFile(abs);
});

module.exports = { router, insertFile, fileView, upload, removeLibraryFile, ALLOWED_EXT, MAX_MB };

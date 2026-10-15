'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { db, UPLOAD_DIR } = require('./db');
const { newId, identify } = require('./auth');
const SET = require('./settings');
const Z = require('./zip');
const { insertFile, ALLOWED_EXT, MAX_MB } = require('./upload');
const REG = require('./modules');
const MODSTATE = require('./modules/state');

/**
 * 룸 셋팅 — 준비해 둔 방을 파일 하나로 내보내고, 다른 방에서 그대로 되살린다.
 *
 * 담는 것:  배역 · 배역별 자료함 파일(원본) · 자료 순서 · 질문지 템플릿
 * 담지 않는 것: 대화, 플레이어, GM, 암호, 질문 답변  ← 아래 세 쿼리 밖으로 나가지 않는다
 *
 * 룸 셋팅 안:
 *   manifest.json
 *   files/<원래 파일 id>.bin
 */

const router = express.Router();
const MANIFEST = 'manifest.json';
const ENTRY_RE = /^files\/[0-9a-f]{24}\.bin$/;     // 이 이름 말고는 쳐다보지 않는다
const MAX_ENTRIES = 500;
const bundleMaxMb = () => Math.min(Math.max(SET.num('BUNDLE_MAX_MB', 1024), 1), 4000);

const extOf = (name) => (String(name).split('.').pop() || '').toLowerCase();

// 확장자로 판단한다 — 룸 셋팅에 적힌 mime 은 믿지 않는다.
const MIME_BY_EXT = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  flac: 'audio/flac', aac: 'audio/aac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  zip: 'application/zip',
};
const mimeFor = (name) => MIME_BY_EXT[extOf(name)] || 'application/octet-stream';

// 문지기는 guards.js 한 곳에 모여 있다.
const { requireGm: gmOnly } = require('./guards');

// ── 내보내기 ─────────────────────────────────────────────────────────────────
// 준비물 세 가지만 읽는다. 대화·플레이어 테이블은 여기서 쳐다보지도 않는다.
function collect(roomId) {
  const roles = db.prepare('SELECT id, name, sort FROM roles WHERE room_id = ? ORDER BY sort, created_at')
    .all(roomId);
  const files = db.prepare(
    `SELECT id, filename, size, label, role_id, sort_order, stored FROM files
      WHERE room_id = ? AND uploader = 'gm' AND is_preset = 1
      ORDER BY COALESCE(sort_order, 999999), created_at ASC, rowid ASC`
  ).all(roomId);
  const templates = db.prepare('SELECT title, items FROM ask_templates WHERE room_id = ? ORDER BY sort_order, created_at')
    .all(roomId);
  // 모듈 설정도 함께 담는다. 각 모듈이 자기 몫만 내놓는다
  // (맞힌 기록처럼 지난 회차의 진행 내용은 모듈 쪽에서 빼고 준다).
  const modules = { enabled: MODSTATE.enabledIds(db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId)), data: {} };
  for (const mod of REG.list()) {
    if (typeof mod.bundle?.collect === 'function') modules.data[mod.id] = mod.bundle.collect(roomId);
  }
  return { roles, files, templates, modules };
}

router.get('/gm/bundle', (req, res) => {
  const who = identify(req);            // window.open 으로 열 수 있게 ?gm= 토큰도 받는다
  if (!who || who.role !== 'gm') return res.status(403).send('권한이 없습니다');
  const room = who.room;
  const { roles, files, templates, modules } = collect(room.id);

  const manifest = {
    format: 'mm-bundle',
    version: 1,
    exportedAt: Date.now(),
    roomName: room.name,
    roles: roles.map((r) => ({ id: r.id, name: r.name, sort: r.sort })),
    files: files.map((f, i) => ({
      id: f.id, name: f.filename, size: f.size, label: f.label,
      roleId: f.role_id || null, sortOrder: f.sort_order ?? i,
    })),
    modules,
    askTemplates: templates.map((t) => {
      let items = [];
      try { items = JSON.parse(t.items || '[]'); } catch { items = []; }
      return { title: t.title, items: Array.isArray(items) ? items : [] };
    }),
  };

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(`${room.name}_룸셋팅_${stamp}.zip`)}`);

  (async () => {
    const w = Z.createWriter(res);
    await w.addBuffer(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    for (const f of files) {
      const abs = path.join(UPLOAD_DIR, f.stored);
      if (!fs.existsSync(abs)) continue;            // 사라진 파일은 조용히 건너뛴다
      await w.addFile(`files/${f.id}.bin`, abs);
    }
    await w.finish();
  })().catch((e) => {
    console.error('[룸 셋팅] 내보내기 실패', e);
    res.destroy();                                   // 이미 헤더가 나갔으므로 연결을 끊는다
  });
});

// ── 가져오기 ─────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, `${newId()}.bundle`),
  }),
  limits: { files: 1, fileSize: bundleMaxMb() * 1024 * 1024 },
});

/** 룸 셋팅을 읽어 들여올 값들을 만든다. 하나라도 어긋나면 통째로 거절한다. */
async function readBundle(zipPath) {
  const entries = await Z.readEntries(zipPath);
  if (entries.length > MAX_ENTRIES) throw Object.assign(new Error('룸 셋팅에 파일이 너무 많습니다'), { status: 400 });

  const manEntry = entries.find((e) => e.name === MANIFEST);
  if (!manEntry) throw Object.assign(new Error('룸 셋팅 형식이 아닙니다'), { status: 400 });

  let manifest;
  try {
    manifest = JSON.parse((await Z.readEntry(zipPath, manEntry)).toString('utf8'));
  } catch {
    throw Object.assign(new Error('룸 셋팅이 손상되었습니다'), { status: 400 });
  }
  if (!manifest || manifest.format !== 'mm-bundle') {
    throw Object.assign(new Error('룸 셋팅 형식이 아닙니다'), { status: 400 });
  }

  const roles = (Array.isArray(manifest.roles) ? manifest.roles : [])
    .map((r) => ({ id: String(r?.id || ''), name: String(r?.name || '').trim().slice(0, 30), sort: Number(r?.sort) || 0 }))
    .filter((r) => r.name);

  const wanted = (Array.isArray(manifest.files) ? manifest.files : []).map((f, i) => ({
    id: String(f?.id || ''),
    name: String(f?.name || '').trim().slice(0, 200),
    label: f?.label ? String(f.label).trim().slice(0, 60) : null,
    roleId: f?.roleId ? String(f.roleId) : null,
    sortOrder: Number.isFinite(f?.sortOrder) ? f.sortOrder : i,
  }));

  // 보낼 수 없는 형식이 하나라도 있으면 통째로 막는다 (일부만 들어가면 뭐가 빠졌는지 모른다).
  const bad = wanted.find((f) => !f.name || !ALLOWED_EXT.has(extOf(f.name)));
  if (bad) {
    throw Object.assign(new Error(`룸 셋팅에 넣을 수 없는 형식이 있습니다 (${bad.name || '이름 없음'})`), { status: 415 });
  }

  const templates = (Array.isArray(manifest.askTemplates) ? manifest.askTemplates : [])
    .map((t) => ({
      title: String(t?.title || '').trim().slice(0, 200),
      items: (Array.isArray(t?.items) ? t.items : [])
        .map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 20),
    }))
    .filter((t) => t.title);

  // 모듈 설정. 모르는 모듈은 버리고, 아는 모듈은 자기 검증기에 맡긴다.
  // id 로 require 하지 않는다 — 카탈로그에 있는 것만 조회한다 (경로 주입 차단).
  const rawModules = manifest.modules && typeof manifest.modules === 'object' ? manifest.modules : {};
  if (JSON.stringify(rawModules).length > 512 * 1024) {
    throw Object.assign(new Error('룸 셋팅의 모듈 설정이 너무 큽니다'), { status: 413 });
  }
  const modEnabled = MODSTATE.normalize(rawModules.enabled, REG.ids());
  const modData = {};
  for (const id of REG.ids()) {
    const mod = REG.byId(id);
    const raw = rawModules.data?.[id];
    if (!raw || typeof mod.bundle?.read !== 'function') continue;
    modData[id] = mod.bundle.read(raw);          // 이상하면 던져서 가져오기 전체를 막는다
  }

  // 룸 셋팅 안의 이름은 절대 경로로 쓰지 않는다. 정해진 이름만 받아들인다.
  const byId = new Map();
  for (const e of entries) {
    if (e.name === MANIFEST || !ENTRY_RE.test(e.name)) continue;
    if (e.method !== Z.STORE) throw Object.assign(new Error('압축된 룸 셋팅은 지원하지 않습니다'), { status: 400 });
    if (e.size > MAX_MB * 1024 * 1024) {
      throw Object.assign(new Error(`룸 셋팅 안의 파일이 너무 큽니다 (${MAX_MB}MB 초과)`), { status: 413 });
    }
    byId.set(e.name.slice('files/'.length, -'.bin'.length), e);
  }
  return { roles, wanted, templates, byId, modEnabled, modData };
}

router.post('/gm/bundle/import', upload.single('bundle'), async (req, res) => {
  const who = identify(req);
  if (!who || who.role !== 'gm') {
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    return res.status(403).json({ error: '권한이 없습니다' });
  }
  if (!req.file) return res.status(400).json({ error: '룸 셋팅 파일을 선택해 주세요' });

  const roomId = who.room.id;
  const zipPath = req.file.path;
  const written = [];                    // 실패하면 되돌리려고 적어 둔다

  try {
    const { roles, wanted, templates, byId, modEnabled, modData } = await readBundle(zipPath);

    // 1) 파일을 먼저 꺼낸다. 여기서 실패하면 DB는 아직 그대로다.
    const extracted = new Map();         // 룸 셋팅 안의 id -> 디스크에 저장된 이름
    for (const f of wanted) {
      const entry = byId.get(f.id);
      if (!entry) continue;              // manifest 에는 있는데 파일이 없으면 건너뛴다
      const stored = `${newId()}.bin`;
      const dest = path.join(UPLOAD_DIR, stored);
      await Z.extractEntry(zipPath, entry, dest);
      written.push(dest);
      extracted.set(f.id, { stored, size: entry.size });
    }

    // 2) DB는 한 번에 넣는다 (중간에 실패하면 아무것도 안 들어간 것과 같게).
    const mode = req.body?.mode === 'replace' ? 'replace' : 'merge';
    const now = Date.now();
    const roleMap = new Map();
    const fileMap = new Map();            // 룸 셋팅 안의 파일 id -> 이 방의 새 파일 id
    let addedRoles = 0, addedFiles = 0, addedTemplates = 0, addedModules = 0;

    db.transaction(() => {
      if (mode === 'replace') {
        db.prepare(`UPDATE files SET is_preset = 0 WHERE room_id = ? AND uploader = 'gm' AND is_preset = 1`).run(roomId);
        db.prepare('DELETE FROM ask_templates WHERE room_id = ?').run(roomId);
        db.prepare('DELETE FROM roles WHERE room_id = ?').run(roomId);
      }

      const findRole = db.prepare('SELECT id FROM roles WHERE room_id = ? AND name = ?');
      const addRole = db.prepare('INSERT INTO roles (id, room_id, name, sort, created_at) VALUES (?, ?, ?, ?, ?)');
      for (const r of roles) {
        const already = findRole.get(roomId, r.name);      // 같은 이름이면 그 배역에 붙인다
        if (already) { roleMap.set(r.id, already.id); continue; }
        const id = newId();
        addRole.run(id, roomId, r.name, r.sort, now);
        roleMap.set(r.id, id);
        addedRoles++;
      }

      const addFile = db.prepare(`
        INSERT INTO files (id, room_id, uploader, participant_id, filename, mime, size, stored,
                           is_preset, label, role_id, sort_order, created_at)
        VALUES (@id, @room_id, 'gm', NULL, @filename, @mime, @size, @stored,
                1, @label, @role_id, @sort_order, @created_at)`);
      for (const f of wanted) {
        const got = extracted.get(f.id);
        if (!got) continue;
        const newFileId = newId();
        addFile.run({
          id: newFileId, room_id: roomId, filename: f.name, mime: mimeFor(f.name),
          size: got.size, stored: got.stored, label: f.label,
          role_id: f.roleId ? roleMap.get(f.roleId) || null : null,
          sort_order: f.sortOrder, created_at: now,
        });
        fileMap.set(f.id, newFileId);     // 모듈이 자료를 가리킬 때 쓴다
        addedFiles++;
      }

      const addTpl = db.prepare(`INSERT INTO ask_templates (id, room_id, title, items, sort_order, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?)`);
      templates.forEach((t, i) => {
        addTpl.run(newId(), roomId, t.title, JSON.stringify(t.items), i, now);
        addedTemplates++;
      });

      // 모듈 설정과 켜짐 상태
      for (const [id, data] of Object.entries(modData)) {
        const mod = REG.byId(id);
        if (typeof mod?.bundle?.apply === 'function') {
          addedModules += mod.bundle.apply(roomId, data, mode, { roleMap, fileMap }) || 0;
        }
      }
      if (modEnabled.length) {
        const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
        const merged = mode === 'replace'
          ? modEnabled
          : [...new Set([...MODSTATE.enabledIds(room), ...modEnabled])];
        MODSTATE.setEnabled(roomId, merged);
      }
    })();

    res.json({ roles: addedRoles, files: addedFiles, askTemplates: addedTemplates, modules: addedModules, mode });
  } catch (e) {
    for (const p of written) fs.rm(p, { force: true }, () => {});   // 반쯤 들어간 파일을 남기지 않는다
    const status = e.status || 400;
    if (status >= 500) console.error('[룸 셋팅] 가져오기 실패', e);
    res.status(status).json({ error: e.message || '룸 셋팅을 읽지 못했습니다' });
  } finally {
    fs.rm(zipPath, { force: true }, () => {});
  }
});

module.exports = { router, gmOnly };

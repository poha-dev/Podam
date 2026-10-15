'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { db, DATA_DIR, UPLOAD_DIR } = require('./db');
const SET = require('./settings');

/**
 * 대화 기록과 올린 파일을 NAS 공유폴더로 복사해 둔다.
 *
 * 기록은 도커 볼륨 안에 있어 File Station에서 손댈 수 없고, 실수로 지우거나
 * 볼륨이 깨지면 되돌릴 방법이 없다. 그래서 밖에서 열어볼 수 있는 곳에 사본을 둔다.
 *
 *   <백업폴더>/db/mm-20260917-0300.sqlite   ← 시점별 스냅샷 (개수 제한, 오래된 것부터 정리)
 *   <백업폴더>/uploads/<저장이름>           ← 올린 파일 사본 (새 것만 복사)
 *
 * 이 파일의 어떤 실패도 서버를 멈추지 않는다. 안 되면 경고 한 줄을 남기고 넘어간다.
 */

const MINUTE = 60 * 1000;
const START_DELAY = 60 * 1000;      // 부팅 직후는 바쁘므로 조금 기다렸다 시작한다

let running = false;                 // 느린 NAS에서 다음 회차가 겹치지 않게
let lastWarning = '';                // 같은 경고를 주기마다 반복하지 않으려고

function warnOnce(message) {
  if (lastWarning === message) return;
  lastWarning = message;
  console.warn(`[백업] ${message}`);
}

/** 설정을 읽어 쓸 수 있는 상태인지까지 판단한다. */
function resolveConfig() {
  const dir = SET.str('BACKUP_DIR', '');
  if (!dir) return { enabled: false, reason: 'off' };

  // 백업을 원본 옆에 두면 백업이 백업을 복사하며 디스크를 채운다.
  const target = path.resolve(dir);
  const data = path.resolve(DATA_DIR);
  if (target === data || target.startsWith(data + path.sep)) {
    return { enabled: false, reason: 'inside-data', dir: target };
  }
  return {
    enabled: true,
    dir: target,
    everyHours: Math.min(Math.max(SET.num('BACKUP_EVERY_HOURS', 6), 1), 24 * 7),
    keep: Math.min(Math.max(SET.num('BACKUP_KEEP', 7), 1), 100),
    onStart: SET.bool('BACKUP_ON_START') !== false,
    uploads: SET.bool('BACKUP_UPLOADS') !== false,
  };
}

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** 같은 초에 두 번 돌아도 이전 사본을 덮어쓰지 않게 이름을 비켜준다. */
function freeName(dbDir) {
  const base = `mm-${stamp()}`;
  for (let i = 0; i < 100; i++) {
    const name = i === 0 ? `${base}.sqlite` : `${base}-${i}.sqlite`;
    if (!fs.existsSync(path.join(dbDir, name))) return name;
  }
  return `${base}-${Date.now()}.sqlite`;
}

/** 오래된 스냅샷을 정리한다. 파일 이름이 곧 시간순이라 이름으로 정렬하면 된다. */
async function rotate(dbDir, keep) {
  let names;
  try { names = await fsp.readdir(dbDir); } catch { return 0; }
  const snaps = names.filter((n) => /^mm-\d{8}-\d{6}(-\d+)?\.sqlite$/.test(n)).sort();
  const old = snaps.slice(0, Math.max(0, snaps.length - keep));
  for (const n of old) {
    try { await fsp.rm(path.join(dbDir, n), { force: true }); } catch { /* 다음에 다시 시도 */ }
  }
  return old.length;
}

/** 올린 파일 중 사본에 없는 것만 복사한다. 파일 내용은 한 번 쓰면 바뀌지 않는다. */
async function mirrorUploads(destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const rows = db.prepare('SELECT stored, size FROM files').all();
  let copied = 0, skipped = 0, failed = 0;

  // NAS(SMB)에 한꺼번에 쏟으면 멎을 수 있어 한 건씩 처리한다.
  for (const row of rows) {
    if (!row.stored) continue;
    const from = path.join(UPLOAD_DIR, row.stored);
    const to = path.join(destDir, row.stored);
    try {
      const there = await fsp.stat(to).catch(() => null);
      if (there && there.size === row.size) { skipped++; continue; }
      const tmp = `${to}.tmp`;
      await fsp.copyFile(from, tmp);
      await fsp.rename(tmp, to);
      copied++;
    } catch (e) {
      failed++;
      if (e.code === 'ENOSPC') throw e;        // 디스크가 찼으면 이번 회차를 접는다
    }
  }
  return { copied, skipped, failed };
}

/**
 * 한 번 백업한다. 실패해도 예외를 밖으로 던지지 않는다.
 * 테스트에서 직접 부를 수 있도록 설정을 넘겨받을 수 있다.
 */
async function runBackup(override = {}) {
  const cfg = { ...resolveConfig(), ...override };
  if (override.dir) cfg.enabled = true;
  if (!cfg.enabled) {
    if (cfg.reason === 'inside-data') {
      warnOnce(`백업 폴더가 데이터 폴더 안에 있어 백업하지 않습니다 — ${cfg.dir}`);
    }
    return { ok: false, skipped: true, reason: cfg.reason || 'off' };
  }
  if (running) return { ok: false, skipped: true, reason: 'busy' };

  running = true;
  const began = Date.now();
  const dbDir = path.join(cfg.dir, 'db');
  const upDir = path.join(cfg.dir, 'uploads');
  const keep = cfg.keep ?? 7;

  try {
    // 폴더가 없으면 db.backup() 이 그대로 실패하므로 먼저 만든다.
    await fsp.mkdir(dbDir, { recursive: true });

    // WAL 모드에서는 파일을 그냥 복사하면 최신 내용이 빠진 사본이 나온다.
    // sqlite의 백업 기능을 써야 일관된 스냅샷이 된다.
    const name = freeName(dbDir);
    const dest = path.join(dbDir, name);
    const tmp = `${dest}.tmp`;
    await db.backup(tmp);
    await fsp.rename(tmp, dest);               // 쓰다 만 파일이 정상 사본으로 오인되지 않게

    let files = { copied: 0, skipped: 0, failed: 0 };
    if (cfg.uploads !== false) files = await mirrorUploads(upDir);

    // 정리는 새 사본을 확보한 뒤에만 한다 (디스크가 찼을 때 옛 사본까지 잃지 않도록).
    const removed = await rotate(dbDir, keep);

    lastWarning = '';
    const secs = ((Date.now() - began) / 1000).toFixed(1);
    console.log(`[백업] 스냅샷 ${name} · 자료 ${files.copied} · 건너뜀 ${files.skipped}`
      + ` · 실패 ${files.failed} · 정리 ${removed} · ${secs}초`);
    return { ok: true, snapshot: dest, removed, ...files };
  } catch (e) {
    const hint = e.code === 'EACCES' || e.code === 'EPERM'
      ? ' (폴더 쓰기 권한을 확인하세요 — 컨테이너는 uid 1000 으로 돕니다)'
      : e.code === 'ENOSPC' ? ' (저장 공간이 부족합니다)' : '';
    warnOnce(`실패 — ${e.message}${hint}`);
    return { ok: false, error: e.message, code: e.code };
  } finally {
    running = false;
  }
}

/** 서버가 켜질 때 한 번 부르면, 이후로는 알아서 주기마다 돈다. */
function start() {
  const cfg = resolveConfig();
  if (!cfg.enabled) {
    if (cfg.reason === 'inside-data') {
      warnOnce(`백업 폴더가 데이터 폴더 안에 있어 백업하지 않습니다 — ${cfg.dir}`);
    }
    return;
  }
  console.log(`[백업] ${cfg.dir} 로 ${cfg.everyHours}시간마다 (스냅샷 ${cfg.keep}개 보관)`);

  if (cfg.onStart) setTimeout(() => { runBackup(); }, START_DELAY).unref();
  setInterval(() => { runBackup(); }, cfg.everyHours * 60 * MINUTE).unref();
}

module.exports = { start, runBackup, rotate, resolveConfig };

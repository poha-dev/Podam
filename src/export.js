'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, UPLOAD_DIR } = require('./db');
const { identify } = require('./auth');
const M = require('./messages');

const router = express.Router();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (ts) => new Date(ts).toLocaleString('ko-KR', { hour12: false });

const STYLE = `
 body{font:14px/1.6 system-ui,'Malgun Gothic',sans-serif;max-width:820px;margin:32px auto;padding:0 16px;color:#1a1a1a}
 h1{border-bottom:2px solid #333;padding-bottom:8px}
 h2{margin-top:40px;background:#f0f0f0;padding:8px 12px;border-radius:6px}
 .msg{margin:10px 0;padding:8px 12px;border-radius:8px;border:1px solid #e2e2e2}
 .msg.gm{background:#eef4ff;border-color:#cfe0ff}
 .msg.pl{background:#fff}
 .msg.sys{background:#fafafa;font-style:italic;color:#777}
 .head{display:flex;gap:8px;align-items:center;font-size:12px;margin-bottom:4px}
 .meta{color:#777;font-size:12px}
 .tag{background:#ffcf5c;color:#5a3d00;border-radius:4px;padding:0 6px;font-size:11px}
 .file{margin-top:4px;font-size:13px;color:#444}
 .body{white-space:pre-wrap}
 .shot{display:block;max-width:100%;margin-top:6px;border:1px solid #e2e2e2;border-radius:6px}
 .gone{color:#a33}
`;

// ── 대화에 오간 그림은 파일 안에 함께 담는다 ────────────────────────────────
// 기록만 남고 그림이 사라지면 나중에 복기할 수가 없다. 파일 하나로 끝나야
// 옮기기도 쉬우므로 링크가 아니라 **본문에 박아 넣는다**(data: URI).
// 다만 무한정 담으면 열지도 못할 만큼 커지므로 한도를 둔다.
const SHOT_MAX = 6 * 1024 * 1024;        // 그림 한 장
const SHOT_BUDGET = 40 * 1024 * 1024;    // 한 파일에 담는 그림 전체

const storedStmt = db.prepare('SELECT stored, mime, size FROM files WHERE id = ?');

/** 내보내기 한 번 동안 얼마나 담았는지 세는 그릇. */
const newBudget = () => ({ left: SHOT_BUDGET, count: 0, skipped: 0 });

function embedImage(file, budget) {
  if (!file || !/^image\//.test(file.mime || '')) return '';
  const row = storedStmt.get(file.id);
  if (!row) return '';
  if (row.size > SHOT_MAX || row.size > budget.left) { budget.skipped++; return ''; }
  try {
    const bytes = fs.readFileSync(path.join(UPLOAD_DIR, row.stored));
    budget.left -= bytes.length;
    budget.count++;
    return `<img class="shot" src="data:${row.mime};base64,${bytes.toString('base64')}" alt="${esc(file.name)}">`;
  } catch {
    return '<div class="file gone">(그림 파일을 찾지 못했습니다)</div>';
  }
}

/** 부제에 덧붙일 한 줄 — 몇 장을 담았고 몇 장을 못 담았는지. */
function shotNote(budget) {
  if (!budget.count && !budget.skipped) return '';
  const parts = [`그림 ${budget.count}장 포함`];
  if (budget.skipped) parts.push(`${budget.skipped}장은 너무 커서 빠짐`);
  return ` · ${parts.join(' · ')}`;
}

/** 메시지 한 건을 HTML 한 조각으로. */
function renderMsg(m, fallbackName, budget) {
  if (m.deleted) {
    return `<div class="msg sys">삭제된 메시지 <span class="meta">${fmt(m.createdAt)}</span></div>`;
  }
  const who = m.senderName || fallbackName || (m.sender === 'gm' ? 'GM' : '플레이어');
  const cls = m.sender === 'gm' ? 'gm' : m.sender === 'player' ? 'pl' : 'sys';
  const file = m.file
    ? `<div class="file">📎 ${esc(m.file.name)} <span class="meta">(${Math.round(m.file.size / 1024)} KB)</span></div>`
      + (budget ? embedImage(m.file, budget) : '')
    : '';
  const body = m.body ? `<div class="body">${esc(m.body).replace(/\n/g, '<br>')}</div>` : '';
  const tag = m.kind === 'broadcast' ? '<span class="tag">공지</span>' : '';
  return `<div class="msg ${cls}"><div class="head"><b>${esc(who)}</b>${tag}` +
         `<span class="meta">${fmt(m.createdAt)}</span></div>${body}${file}</div>`;
}

function page(title, subtitle, sections) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>
<h1>${esc(title)}</h1>
<p class="meta">${esc(subtitle)}</p>
${sections}
</body></html>`;
}

function download(res, filename, html) {
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.type('html').send(html);
}

// ── GM: 전체 기록 ────────────────────────────────────────────────────────────
router.get('/gm/export', (req, res) => {
  const who = identify(req);
  if (!who || who.role !== 'gm') return res.status(403).send('권한이 없습니다');
  const room = who.room;

  const participants = db.prepare(
    'SELECT * FROM participants WHERE room_id = ? ORDER BY COALESCE(sort_order, 999999), joined_at'
  ).all(room.id);

  const budget = newBudget();
  const threads = participants.map((p) => {
    const role = p.role_id ? db.prepare('SELECT name FROM roles WHERE id = ?').get(p.role_id) : null;
    const rows = M.history(room.id, p.id).map((m) => renderMsg(m, p.nickname, budget)).join('\n');
    const title = role ? `${esc(p.nickname)} <span class="meta">— ${esc(role.name)}</span>` : esc(p.nickname);
    return `<section><h2>${title}</h2>${rows || '<p class="meta">대화 없음</p>'}</section>`;
  }).join('\n');

  // GM끼리의 대화도 함께 남긴다 — 진행 복기에 쓸모가 있다.
  const gmAll = M.gmHistory(room.id, 'all').map((m) => renderMsg(m, null, budget)).join('\n');
  const gmSection = gmAll
    ? `<section><h2>GM 전체방</h2>${gmAll}</section>`
    : '';

  const gmNames = db.prepare('SELECT nickname FROM gms WHERE room_id = ?').all(room.id)
    .map((g) => g.nickname).join(', ');

  const html = page(
    `${room.name} — 대화 기록`,
    `방 코드 ${room.code} · 개설 ${fmt(room.created_at)} · 내보낸 시각 ${fmt(Date.now())} · ` +
    `플레이어 ${participants.length}명 · GM ${gmNames}${shotNote(budget)}`,
    threads + gmSection
  );
  download(res, `${room.name}_${new Date().toISOString().slice(0, 10)}.html`, html);
});

// ── GM: GM끼리의 대화만 ─────────────────────────────────────────────────────
// 전체방과 '내가 낀' 1:1 대화만 담는다. 남의 1:1 대화는 내보내지 않는다.
router.get('/gm/chat-export', (req, res) => {
  const who = identify(req);
  if (!who || who.role !== 'gm') return res.status(403).send('권한이 없습니다');
  const room = who.room;
  const me = who.gm;

  const channels = db.prepare('SELECT DISTINCT channel FROM gm_messages WHERE room_id = ?')
    .all(room.id).map((r) => r.channel)
    .filter((ch) => ch === 'all' || ch.split('|').includes(me.id));

  const nameOf = (id) => db.prepare('SELECT nickname FROM gms WHERE id = ?').get(id)?.nickname || '(나간 GM)';
  const titleOf = (ch) => (ch === 'all'
    ? 'GM 전체방'
    : `1:1 — ${ch.split('|').filter((id) => id !== me.id).map(nameOf).join(', ')}`);

  // 전체방을 먼저, 그다음 1:1을 상대 이름순으로.
  channels.sort((a, b) => (a === 'all' ? -1 : b === 'all' ? 1 : titleOf(a).localeCompare(titleOf(b), 'ko')));

  const budget = newBudget();
  const sections = channels.map((ch) => {
    const rows = M.gmHistory(room.id, ch).map((m) => renderMsg(m, null, budget)).join('\n');
    return `<section><h2>${esc(titleOf(ch))}</h2>${rows || '<p class="meta">대화 없음</p>'}</section>`;
  }).join('\n');

  const html = page(
    `${room.name} — GM 대화 기록`,
    `${esc(me.nickname)} 기준 · 내보낸 시각 ${fmt(Date.now())} · 대화 ${channels.length}개${shotNote(budget)}`,
    sections || '<p class="meta">GM끼리의 대화가 아직 없습니다</p>'
  );
  download(res, `${room.name}_GM대화_${new Date().toISOString().slice(0, 10)}.html`, html);
});

// ── 플레이어: 내 대화만 ──────────────────────────────────────────────────────
router.get('/me/export', (req, res) => {
  const who = identify(req);
  if (!who || who.role !== 'player') return res.status(403).send('권한이 없습니다');
  const { room, participant } = who;

  const budget = newBudget();
  const rows = M.history(room.id, participant.id)
    .map((m) => renderMsg(m, participant.nickname, budget)).join('\n');
  const role = participant.role_id
    ? db.prepare('SELECT name FROM roles WHERE id = ?').get(participant.role_id)
    : null;

  const html = page(
    `${room.name} — ${participant.nickname}의 기록`,
    `${role ? `배역 ${role.name} · ` : ''}내보낸 시각 ${fmt(Date.now())}${shotNote(budget)}`,
    `<section>${rows || '<p class="meta">대화 없음</p>'}</section>`
  );
  download(res, `${room.name}_${participant.nickname}.html`, html);
});

module.exports = { router };

'use strict';
const express = require('express');
const { db } = require('./db');
const { newId, identify } = require('./auth');
const M = require('./messages');
const { validTargets, allParticipantIds } = require('./targets');

const router = express.Router();
const MAX_ITEMS = 20;

// 문지기는 guards.js 한 곳에 모여 있다.
const { requireGm: gmOnly } = require('./guards');

const nickOf = db.prepare('SELECT nickname FROM participants WHERE id = ?');
const parseItems = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };

/**
 * 한 질문지에 모인 답을 사람별 → 항목별로 묶는다.
 * GM은 "윤서진: 1번 …, 2번 …" 형태로 한 사람 것을 한눈에 본다.
 */
function gather(pollId) {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
  if (!poll) return null;
  const items = parseItems(poll.items);

  const rows = db.prepare(
    'SELECT * FROM poll_answers WHERE poll_id = ? ORDER BY created_at ASC'
  ).all(pollId);

  const asked = db.prepare(
    'SELECT DISTINCT participant_id FROM messages WHERE poll_id = ? AND sender = ?'
  ).all(pollId, 'gm').map((r) => r.participant_id);

  const blank = () => items.map(() => []);
  const byPerson = new Map();
  const ensure = (id) => {
    if (!byPerson.has(id)) {
      byPerson.set(id, {
        id,
        nickname: nickOf.get(id)?.nickname || '(나간 사람)',
        answers: blank(),          // answers[항목번호] = [{body, createdAt}, …]
      });
    }
    return byPerson.get(id);
  };
  asked.forEach(ensure);
  for (const a of rows) {
    const p = ensure(a.participant_id);
    const i = Math.min(Math.max(a.item_index, 0), Math.max(items.length - 1, 0));
    // 같은 항목에 다시 내면 '수정'이다. 모두 시간순으로 두고, 마지막 것이 지금 답이다.
    (p.answers[i] ||= []).push({ body: a.body, createdAt: a.created_at });
  }

  const people = [...byPerson.values()];
  const done = (p) => items.every((_, i) => (p.answers[i] || []).length > 0);
  return {
    id: poll.id,
    question: poll.question,
    items,
    closed: !!poll.closed_at,
    revealed: !!poll.revealed_at,
    askedCount: people.length,
    doneCount: people.filter(done).length,
    people,
  };
}

/** 질문 카드의 최신 상태를 GM 화면에 밀어준다. */
function pushToGm(roomId, pollId) {
  M.notifyGm(roomId, 'ask:update', gather(pollId));
}

// ── GM: 질문지 보내기 (/질문 명령으로 호출된다) ──────────────────────────────
router.post('/gm/ask', gmOnly, (req, res) => {
  let question = String(req.body?.question || '').trim().slice(0, 200);
  let items = Array.isArray(req.body?.items)
    ? req.body.items.map((t) => String(t).trim()).filter(Boolean).slice(0, MAX_ITEMS)
    : [];

  // 미리 저장해 둔 질문지를 그대로 쓰는 경우
  if (req.body?.templateId) {
    const tpl = db.prepare('SELECT * FROM ask_templates WHERE id = ? AND room_id = ?')
      .get(req.body.templateId, req.room.id);
    if (!tpl) return res.status(404).json({ error: '없는 질문지입니다' });
    question = tpl.title;
    items = parseItems(tpl.items);
  }
  if (items.length === 0) items = [question];        // 세부 항목이 없으면 제목 하나로
  if (!question) return res.status(400).json({ error: '질문 내용을 입력해 주세요' });

  const targets = req.body?.all
    ? allParticipantIds(req.room.id)
    : validTargets(req.room.id, req.body?.targets);
  if (targets.length === 0) return res.status(400).json({ error: '받는 사람을 선택해 주세요' });

  const poll = {
    id: newId(), room_id: req.room.id, question,
    items: JSON.stringify(items),
    created_at: Date.now(), closed_at: null, revealed_at: null,
  };
  db.prepare(`INSERT INTO polls (id, room_id, question, items, created_at, closed_at, revealed_at)
              VALUES (@id, @room_id, @question, @items, @created_at, @closed_at, @revealed_at)`).run(poll);

  M.deliverMany({
    roomId: req.room.id, participantIds: targets,
    sender: 'gm', kind: 'ask', body: question,
    fromGmId: req.gm.id, pollId: poll.id,
  });

  res.json({ poll: gather(poll.id), count: targets.length });
});

router.get('/gm/ask/:id', gmOnly, (req, res) => {
  const data = gather(req.params.id);
  if (!data) return res.status(404).json({ error: '없는 질문입니다' });
  res.json({ poll: data });
});

// ── GM: 마감 / 공개 ──────────────────────────────────────────────────────────
router.post('/gm/ask/:id/close', gmOnly, (req, res) => {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ? AND room_id = ?')
    .get(req.params.id, req.room.id);
  if (!poll) return res.status(404).json({ error: '없는 질문입니다' });

  const closing = !poll.closed_at;
  db.prepare('UPDATE polls SET closed_at = ? WHERE id = ?')
    .run(closing ? Date.now() : null, poll.id);

  M.notifyEveryone(req.room.id, 'ask:closed', { pollId: poll.id, closed: closing });
  pushToGm(req.room.id, poll.id);
  res.json({ poll: gather(poll.id) });
});

/** 사람별 → 항목별로 정리한 글. GM끼리 보려는 용도다. */
function summaryText(data) {
  const blocks = data.people.map((p) => {
    const answered = p.answers.some((a) => (a || []).length > 0);
    if (!answered) return `· ${p.nickname} — 미제출`;
    const lines = data.items.map((q, i) => {
      // 수정했으면 직전 답은 ~~취소선~~ 으로, 마지막 답이 지금 답이다.
      const list = (p.answers[i] || []).slice(-2);
      const got = list.map((a, k) => (k < list.length - 1 ? `~~${a.body}~~ ` : a.body)).join('');
      return `   ${i + 1}. ${q} → ${got || '(답 없음)'}`;
    });
    return `· ${p.nickname}\n${lines.join('\n')}`;
  });
  return `[집계] ${data.question}  (제출 ${data.doneCount}/${data.askedCount}명)\n${blocks.join('\n')}`;
}

/**
 * 모인 답을 정리해 GM 전체방에 올린다.
 * 플레이어에게는 보내지 않는다 — 공개할지는 GM이 따로 판단한다.
 */
router.post('/gm/ask/:id/summary', gmOnly, (req, res) => {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ? AND room_id = ?')
    .get(req.params.id, req.room.id);
  if (!poll) return res.status(404).json({ error: '없는 질문입니다' });

  const data = gather(poll.id);
  const summary = summaryText(data);
  M.deliverGm({ roomId: req.room.id, channel: 'all', fromGmId: req.gm.id, body: summary });
  res.json({ summary, poll: data });
});

// ── 미리 만들어 두는 질문지 ──────────────────────────────────────────────────
const tplView = (t) => ({ id: t.id, title: t.title, items: parseItems(t.items) });

function listTemplates(roomId) {
  return db.prepare(
    'SELECT * FROM ask_templates WHERE room_id = ? ORDER BY COALESCE(sort_order, 999999), created_at'
  ).all(roomId).map(tplView);
}

router.get('/gm/ask-templates', gmOnly, (req, res) => {
  res.json({ templates: listTemplates(req.room.id) });
});

router.post('/gm/ask-templates', gmOnly, (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 200);
  const items = (Array.isArray(req.body?.items) ? req.body.items : [])
    .map((t) => String(t).trim()).filter(Boolean).slice(0, MAX_ITEMS);
  if (!title) return res.status(400).json({ error: '제목을 입력해 주세요' });

  db.prepare(`INSERT INTO ask_templates (id, room_id, title, items, sort_order, created_at)
              VALUES (?, ?, ?, ?, NULL, ?)`)
    .run(newId(), req.room.id, title, JSON.stringify(items.length ? items : [title]), Date.now());
  res.json({ templates: listTemplates(req.room.id) });
});

router.delete('/gm/ask-templates/:id', gmOnly, (req, res) => {
  db.prepare('DELETE FROM ask_templates WHERE id = ? AND room_id = ?')
    .run(req.params.id, req.room.id);
  res.json({ templates: listTemplates(req.room.id) });
});

router.put('/gm/ask-templates/order', gmOnly, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const stmt = db.prepare('UPDATE ask_templates SET sort_order = ? WHERE id = ? AND room_id = ?');
  db.transaction(() => { ids.forEach((id, i) => stmt.run(i, id, req.room.id)); })();
  res.json({ ok: true });
});

// ── 플레이어: 답 제출 (항목별로, 다시 내면 수정) ─────────────────────────────
function submit({ room, participant, pollId, itemIndex, body }) {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ? AND room_id = ?').get(pollId, room.id);
  if (!poll) return { error: '없는 질문입니다' };
  if (poll.closed_at) return { error: '이미 마감된 질문입니다' };

  const items = parseItems(poll.items);
  const i = Number(itemIndex) || 0;
  if (i < 0 || i >= Math.max(items.length, 1)) return { error: '없는 항목입니다' };

  const text = String(body || '').trim().slice(0, 1000);
  if (!text) return { error: '내용을 입력해 주세요' };

  // 이 사람에게 실제로 간 질문인지, 그리고 GM이 지우지 않았는지 확인한다.
  const mine = db.prepare(
    'SELECT 1 FROM messages WHERE poll_id = ? AND participant_id = ? AND sender = ? AND deleted_at IS NULL'
  ).get(pollId, participant.id, 'gm');
  if (!mine) return { error: '없거나 삭제된 질문입니다' };

  db.prepare(`INSERT INTO poll_answers (id, poll_id, participant_id, item_index, body, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(newId(), pollId, participant.id, i, text, Date.now());

  // 여러 번 고쳤으면 직전 답과 지금 답만 남기고 그 이전 것은 지운다.
  db.prepare(`DELETE FROM poll_answers
              WHERE poll_id = ? AND participant_id = ? AND item_index = ?
                AND id NOT IN (SELECT id FROM poll_answers
                               WHERE poll_id = ? AND participant_id = ? AND item_index = ?
                               ORDER BY created_at DESC, rowid DESC LIMIT 2)`)
    .run(pollId, participant.id, i, pollId, participant.id, i);

  // 답은 대화 메시지로 따로 남기지 않는다. 항목마다 말풍선이 쌓이면 대화가
  // 지저분해지므로, 플레이어 카드와 GM 집계 카드에만 반영한다.
  pushToGm(room.id, pollId);
  return { ok: true };
}

/** 플레이어 화면이 자기 질문지 상태를 다시 받아갈 때 쓴다. */
function forPlayer(roomId, participantId, pollId) {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ? AND room_id = ?').get(pollId, roomId);
  if (!poll) return null;
  const items = parseItems(poll.items);
  const rows = db.prepare(
    'SELECT * FROM poll_answers WHERE poll_id = ? AND participant_id = ? ORDER BY created_at ASC'
  ).all(pollId, participantId);
  const mine = items.map(() => []);
  for (const a of rows) (mine[a.item_index] ||= []).push({ body: a.body, createdAt: a.created_at });
  return {
    id: poll.id, question: poll.question, items,
    closed: !!poll.closed_at, mine,
  };
}

module.exports = { router, submit, gather, pushToGm, forPlayer, listTemplates };

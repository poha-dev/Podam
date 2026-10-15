'use strict';
const { db } = require('./db');
const { newId } = require('./auth');

let io = null;
function setIo(instance) { io = instance; }

// ── 격리의 핵심 ───────────────────────────────────────────────────────────────
// 소켓 룸은 이 두 함수로만 만든다. 방 전체(`r:<id>`)에 emit하는 코드는
// 이 파일 어디에도 존재해서는 안 된다. 플레이어끼리 대화가 새는 유일한 경로다.
const threadRoom = (roomId, participantId) => `r:${roomId}:p:${participantId}`;
const gmRoom = (roomId) => `r:${roomId}:gm`;

/**
 * 사람이 아닌 프로그램(모듈이 받아들인 보조 도구)이 머무는 방.
 * 모듈 이름까지 주면 그 모듈의 것만 가리킨다 — 토큰을 폐기할 때 그 연결만 끊으려고.
 */
const serviceRoom = (roomId, modId) => (modId ? `r:${roomId}:svc:${modId}` : `r:${roomId}:svc`);

/** 그 모듈로 붙어 있던 연결을 즉시 끊는다 (토큰을 폐기했을 때). */
function disconnectService(roomId, modId) {
  if (io) io.in(serviceRoom(roomId, modId)).disconnectSockets(true);
}

const fileStmt = db.prepare('SELECT id, filename, mime, size, label FROM files WHERE id = ?');
const gmNameStmt = db.prepare('SELECT nickname FROM gms WHERE id = ?');
const playerNameStmt = db.prepare('SELECT nickname FROM participants WHERE id = ?');

// ── 대화에 붙이는 표시(반응) ─────────────────────────────────────────────────
const reactStmt = db.prepare(
  'SELECT actor, emoji, created_at FROM reactions WHERE scope = ? AND message_id = ? ORDER BY created_at ASC'
);

/** 누른 사람의 지금 이름. 이름을 바꿔도 최신 이름으로 보인다. */
function actorName(actor) {
  const [kind, id] = String(actor).split(':');
  if (kind === 'gm') return gmNameStmt.get(id)?.nickname || 'GM';
  return playerNameStmt.get(id)?.nickname || '플레이어';
}

/** 한 메시지에 붙은 표시를 이모지별로 묶는다. */
function reactionsOf(scope, messageId) {
  const rows = reactStmt.all(scope, messageId);
  const byEmoji = new Map();
  for (const r of rows) {
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, { emoji: r.emoji, actors: [], names: [] });
    const g = byEmoji.get(r.emoji);
    g.actors.push(r.actor);
    g.names.push(actorName(r.actor));
  }
  return [...byEmoji.values()];
}

/**
 * 표시를 붙이거나 뗀다 (같은 사람이 같은 표시를 다시 누르면 취소).
 * 그 메시지를 볼 수 있는 사람에게만 결과를 보낸다.
 */
function toggleReaction({ roomId, scope, messageId, actor, emoji }) {
  const table = scope === 'gm' ? 'gm_messages' : 'messages';
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND room_id = ?`).get(messageId, roomId);
  if (!row) return { error: '없는 메시지입니다' };
  if (row.deleted_at) return { error: '지워진 메시지입니다' };

  const found = db.prepare('SELECT id FROM reactions WHERE message_id = ? AND actor = ? AND emoji = ?')
    .get(messageId, actor, emoji);
  if (found) {
    db.prepare('DELETE FROM reactions WHERE id = ?').run(found.id);
  } else {
    db.prepare(`INSERT INTO reactions (id, room_id, scope, message_id, actor, emoji, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(newId(), roomId, scope, messageId, actor, emoji, Date.now());
  }

  const payload = { scope, messageId, reactions: reactionsOf(scope, messageId) };
  if (io) {
    if (scope === 'gm') {
      if (row.channel === 'all') io.to(gmRoom(roomId)).emit('reaction', payload);
      else for (const id of row.channel.split('|')) io.to(gmSelf(roomId, id)).emit('reaction', payload);
    } else {
      payload.threadId = row.participant_id;
      io.to(threadRoom(roomId, row.participant_id)).emit('reaction', payload);
      io.to(gmRoom(roomId)).emit('reaction', payload);
    }
  }
  return { ok: true, reactions: payload.reactions };
}

/** 말풍선에 붙일 보낸 사람 이름. 이름을 바꿔도 항상 최신 이름이 보인다. */
function senderNameOf(row) {
  // NPC 이름으로 보낸 것은 그 이름만 보인다 (누가 보냈는지는 GM에게만 따로 알린다).
  if (row.sender === 'gm') return row.npc_name
    || (row.from_gm_id && gmNameStmt.get(row.from_gm_id)?.nickname) || 'GM';
  if (row.sender === 'player') return playerNameStmt.get(row.participant_id)?.nickname || '플레이어';
  return null;
}

const gmColorStmt = db.prepare('SELECT color FROM gms WHERE id = ?');
const playerColorStmt = db.prepare('SELECT color FROM participants WHERE id = ?');

/**
 * 이름에 입힐 색.
 * **NPC 이름으로 보낸 말에만 색을 떼어 낸다** — 이름 뒤의 GM이 누구인지가
 * 색으로 새어 나가면 안 되기 때문이다. 자기 이름으로 한 말은 이미 그 이름이
 * 그대로 보이므로, 색을 붙여도 새로 새는 것이 없다.
 */
function senderColorOf(row) {
  if (row.sender === 'player') return playerColorStmt.get(row.participant_id)?.color || null;
  if (row.sender !== 'gm' || row.npc_name || !row.from_gm_id) return null;
  return gmColorStmt.get(row.from_gm_id)?.color || null;
}

const gmWhoStmt = db.prepare('SELECT nickname, color FROM gms WHERE id = ?');

/**
 * GM 화면에만 더 얹는 것 — **NPC 이름 뒤에 있는 실제 GM**이 누구인지.
 * 플레이어에게 가는 메시지에는 절대 붙이지 않는다.
 */
function gmView(msg) {
  if (!msg?.npcName || !msg.fromGmId) return msg;
  const g = gmWhoStmt.get(msg.fromGmId);
  return { ...msg, gmName: g?.nickname || 'GM', gmColor: g?.color || null };
}

/** 메시지 행을 클라이언트가 쓰는 형태로 만든다. */
function hydrate(row) {
  if (!row) return null;
  const msg = {
    id: row.id,
    threadId: row.participant_id,
    sender: row.sender,
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at,
    readByPlayer: !!row.read_by_player,
    senderName: senderNameOf(row),
    senderColor: senderColorOf(row),
    fromGmId: row.from_gm_id || null,
    npcName: row.npc_name || null,
    pollId: row.poll_id || null,
  };
  // 삭제된 메시지는 본문도 첨부도 내보내지 않는다. DB에는 원본이 남는다.
  if (row.deleted_at) {
    msg.deleted = true;
    msg.deletedBy = row.deleted_by;
    msg.body = null;
    return msg;
  }
  if (row.file_id) {
    const f = fileStmt.get(row.file_id);
    if (f) {
      msg.file = { id: f.id, name: f.filename, mime: f.mime, size: f.size, label: f.label };
    }
  }
  msg.reactions = reactionsOf('msg', row.id);
  return msg;
}

const insertStmt = db.prepare(`
  INSERT INTO messages (id, room_id, participant_id, sender, kind, body, file_id, created_at,
                        read_by_player, batch_id, from_gm_id, npc_name, poll_id)
  VALUES (@id, @room_id, @participant_id, @sender, @kind, @body, @file_id, @created_at,
          0, @batch_id, @from_gm_id, @npc_name, @poll_id)
`);
const bumpUnread = db.prepare('UPDATE participants SET gm_unread = gm_unread + 1 WHERE id = ?');

/**
 * 모든 발송(1:1 채팅 / 파일 / 공지)이 반드시 지나는 단일 진입점.
 * 저장한 뒤 해당 플레이어 스레드와 GM에게만 전달한다.
 */
function deliver({ roomId, participantId, sender, kind = 'text', body = null, fileId = null,
                  batchId = null, fromGmId = null, npcName = null, pollId = null,
                  quietToGm = false }) {
  const row = {
    id: newId(),
    room_id: roomId,
    participant_id: participantId,
    sender,
    kind,
    body,
    file_id: fileId,
    created_at: Date.now(),
    batch_id: batchId,
    from_gm_id: fromGmId,
    npc_name: npcName,
    poll_id: pollId,
  };
  insertStmt.run(row);
  // quietToGm: 기록에는 남기되 GM 화면을 울리지 않는다.
  // (모듈이 주고받는 잔 메시지에 GM 알림이 파묻히지 않게 하려는 것이다.)
  if (sender === 'player' && !quietToGm) bumpUnread.run(participantId);

  const msg = hydrate({ ...row, read_by_player: 0 });
  if (io) {
    io.to(threadRoom(roomId, participantId)).emit('message', msg);
    if (!quietToGm) {
      io.to(gmRoom(roomId)).emit('message', gmView(msg));
    }
  }
  return msg;
}

/**
 * 여러 플레이어에게 같은 내용을 보낸다. 수신자별로 개별 발송되지만,
 * 한 번의 발송이었다는 사실을 batch_id로 묶어둔다 — 잘못 보냈을 때
 * 스레드를 하나씩 돌지 않고 한 번에 지울 수 있게 하기 위해서다.
 */
function deliverMany({ roomId, participantIds, sender, kind, body, fileId, fromGmId, npcName, pollId }) {
  const batchId = participantIds.length > 1 ? newId() : null;
  return participantIds.map((pid) =>
    deliver({ roomId, participantId: pid, sender, kind, body, fileId, batchId, fromGmId, npcName, pollId })
  );
}

const historyStmt = db.prepare(
  'SELECT * FROM messages WHERE room_id = ? AND participant_id = ? ORDER BY created_at ASC, rowid ASC'
);
function history(roomId, participantId) {
  return historyStmt.all(roomId, participantId).map(hydrate);
}

const allStmt = db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC, rowid ASC');
function allMessages(roomId) {
  return allStmt.all(roomId).map(hydrate);
}

/** 플레이어가 스레드를 확인했을 때 GM 쪽에 읽음을 반영한다. */
function markPlayerRead(roomId, participantId) {
  const info = db
    .prepare('UPDATE messages SET read_by_player = 1 WHERE room_id = ? AND participant_id = ? AND sender != ? AND read_by_player = 0')
    .run(roomId, participantId, 'player');
  if (info.changes > 0 && io) {
    io.to(gmRoom(roomId)).emit('thread:read', { threadId: participantId });
  }
  return info.changes;
}

/** GM이 스레드를 열었을 때 안 읽은 수를 0으로. */
function clearGmUnread(participantId) {
  db.prepare('UPDATE participants SET gm_unread = 0 WHERE id = ?').run(participantId);
}


const findMsg = db.prepare('SELECT * FROM messages WHERE id = ? AND room_id = ?');
const softDelete = db.prepare('UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE id = ?');

/**
 * 메시지를 지운다. GM도 플레이어도 '자기가 보낸 것'만 지울 수 있다.
 * 화면에서는 사라지고 DB에는 원본이 남는다.
 * 실패하면 사유 문자열을, 성공하면 null을 돌려준다.
 */
function remove({ roomId, messageId, by, participantId }) {
  const row = findMsg.get(messageId, roomId);
  if (!row) return '없는 메시지입니다';
  if (row.sender !== by) return '자신이 보낸 메시지만 지울 수 있습니다';
  if (by === 'player' && row.participant_id !== participantId) return '권한이 없습니다';
  // GM끼리는 서로의 발송을 지울 수 있다 — 공동 진행이라 수습이 급할 때가 있다.
  if (row.deleted_at) return null; // 이미 지워졌으면 조용히 성공 취급

  // 한 번에 여러 명에게 보낸 것이라면 같은 발송 전체를 함께 지운다.
  const siblings = row.batch_id
    ? db.prepare('SELECT * FROM messages WHERE batch_id = ? AND deleted_at IS NULL').all(row.batch_id)
    : [row];

  const now = Date.now();
  db.transaction(() => {
    for (const r of siblings) softDelete.run(now, by, r.id);
  })();

  for (const r of siblings) {
    const payload = { id: r.id, threadId: r.participant_id, deletedBy: by };
    if (io) {
      io.to(threadRoom(roomId, r.participant_id)).emit('message:deleted', payload);
      io.to(gmRoom(roomId)).emit('message:deleted', payload);
    }
  }
  return null;
}

// ── GM끼리의 대화 ────────────────────────────────────────────────────────────
const gmInsert = db.prepare(`
  INSERT INTO gm_messages (id, room_id, channel, from_gm_id, kind, body, file_id, created_at)
  VALUES (@id, @room_id, @channel, @from_gm_id, @kind, @body, @file_id, @created_at)
`);

function hydrateGm(row) {
  const msg = {
    id: row.id,
    channel: row.channel,
    fromGmId: row.from_gm_id,
    senderName: gmNameStmt.get(row.from_gm_id)?.nickname || 'GM',
    senderColor: gmColorStmt.get(row.from_gm_id)?.color || null,
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at,
  };
  if (row.deleted_at) { msg.deleted = true; msg.body = null; return msg; }
  if (row.file_id) {
    const f = fileStmt.get(row.file_id);
    if (f) msg.file = { id: f.id, name: f.filename, mime: f.mime, size: f.size };
  }
  msg.reactions = reactionsOf('gm', row.id);
  return msg;
}

/** GM 전체방이면 모든 GM에게, 1:1이면 그 두 명에게만 보낸다. */
function deliverGm({ roomId, channel, fromGmId, kind = 'text', body = null, fileId = null }) {
  const row = {
    id: newId(), room_id: roomId, channel, from_gm_id: fromGmId,
    kind, body, file_id: fileId, created_at: Date.now(),
  };
  gmInsert.run(row);
  const msg = hydrateGm(row);

  if (io) {
    if (channel === 'all') {
      io.to(gmRoom(roomId)).emit('gm:message', msg);
    } else {
      for (const id of channel.split('|')) io.to(gmSelf(roomId, id)).emit('gm:message', msg);
    }
  }
  return msg;
}

const findGmMsg = db.prepare('SELECT * FROM gm_messages WHERE id = ? AND room_id = ?');
const softDeleteGm = db.prepare('UPDATE gm_messages SET deleted_at = ?, deleted_by = ? WHERE id = ?');

/**
 * GM끼리의 대화에서 한 줄을 지운다. **자기가 쓴 것만** 지울 수 있다.
 * (플레이어에게 보낸 발송과 달리 GM끼리는 서로의 글에 손대지 않는다 —
 *  전체방은 여럿이 보는 자리라 남의 말을 지울 수 있으면 곤란하다.)
 * 화면에서는 사라지고 DB에는 원본이 남는다.
 */
function removeGm({ roomId, messageId, gmId }) {
  const row = findGmMsg.get(messageId, roomId);
  if (!row) return '없는 메시지입니다';
  if (row.from_gm_id !== gmId) return '자신이 쓴 것만 지울 수 있습니다';
  if (row.deleted_at) return null;                    // 이미 지워졌으면 조용히 성공

  softDeleteGm.run(Date.now(), gmId, messageId);

  const payload = { id: messageId, channel: row.channel };
  if (io) {
    if (row.channel === 'all') io.to(gmRoom(roomId)).emit('gm:message:deleted', payload);
    else for (const id of row.channel.split('|')) io.to(gmSelf(roomId, id)).emit('gm:message:deleted', payload);
  }
  return null;
}

const gmHistStmt = db.prepare(
  'SELECT * FROM gm_messages WHERE room_id = ? AND channel = ? ORDER BY created_at ASC, rowid ASC'
);
const gmHistory = (roomId, channel) => gmHistStmt.all(roomId, channel).map(hydrateGm);

/** GM 개인 소켓 룸 (1:1 전달용) */
const gmSelf = (roomId, gmId) => `r:${roomId}:gm:${gmId}`;

/** GM과 모든 플레이어에게 같은 알림을 보낸다 (타이머처럼 모두가 봐야 하는 것). */
function notifyEveryone(roomId, event, payload) {
  if (!io) return;
  io.to(gmRoom(roomId)).emit(event, payload);
  io.to(serviceRoom(roomId)).emit(event, payload);
  const ids = db.prepare('SELECT id FROM participants WHERE room_id = ? AND kicked_at IS NULL').all(roomId);
  for (const { id } of ids) io.to(threadRoom(roomId, id)).emit(event, payload);
}

/** 내보낸 플레이어의 화면에 알리고 연결을 끊는다. */
function kickParticipant(roomId, participantId) {
  if (!io) return;
  const room = threadRoom(roomId, participantId);
  io.to(room).emit('kicked', { error: 'GM이 이 방에서 내보냈습니다' });
  // 알림이 먼저 가도록 잠깐 뒤에 끊는다.
  setTimeout(() => { io.in(room).disconnectSockets(true); }, 150);
}

/**
 * 한 사람에게만. **사람마다 내용이 달라야 할 때** 쓴다
 * (예: 밀담으로 갈린 방에서 자기 방 사람만 보여 줄 때).
 */
function notifyParticipant(roomId, participantId, event, payload) {
  if (io && participantId) io.to(threadRoom(roomId, participantId)).emit(event, payload);
}

/** 플레이어들에게만 알린다 (GM 화면과 내용이 달라야 할 때 쓴다). */
function notifyPlayers(roomId, event, payload) {
  if (!io) return;
  const ids = db.prepare('SELECT id FROM participants WHERE room_id = ? AND kicked_at IS NULL').all(roomId);
  for (const { id } of ids) io.to(threadRoom(roomId, id)).emit(event, payload);
}

/** 누군가 이름을 바꿨으니 화면의 이름표를 다시 그리라고 알린다. */
function notifyRenamed(roomId) {
  if (!io) return;
  io.to(gmRoom(roomId)).emit('names:changed', {});
  const ids = db.prepare('SELECT id FROM participants WHERE room_id = ? AND kicked_at IS NULL').all(roomId);
  for (const { id } of ids) io.to(threadRoom(roomId, id)).emit('names:changed', {});
}

/** GM 대시보드에 참가자 상태 변화를 알린다. (플레이어에게는 절대 보내지 않는다) */
function notifyGm(roomId, event, payload) {
  if (io) io.to(gmRoom(roomId)).emit(event, payload);
}

/** GM **한 명에게만**. 사람마다 다른 값을 보낼 때 쓴다. */
function notifyGmSelf(roomId, gmId, event, payload) {
  if (io && gmId) io.to(gmSelf(roomId, gmId)).emit(event, payload);
}

/** 방이 닫혔는지/열렸는지를 모든 참가자에게 개별 통지한다. */
function notifyRoomState(roomId, closed) {
  if (!io) return;
  const ids = db.prepare('SELECT id FROM participants WHERE room_id = ? AND kicked_at IS NULL').all(roomId);
  for (const { id } of ids) {
    io.to(threadRoom(roomId, id)).emit('room:state', { closed });
  }
  io.to(gmRoom(roomId)).emit('room:state', { closed });
}

/** 방이 지워졌음을 알린다. */
function notifyRoomDeleted(roomId) {
  if (!io) return;
  const ids = db.prepare('SELECT id FROM participants WHERE room_id = ? AND kicked_at IS NULL').all(roomId);
  for (const { id } of ids) io.to(threadRoom(roomId, id)).emit('room:deleted', {});
  io.to(gmRoom(roomId)).emit('room:deleted', {});
}

module.exports = {
  setIo, threadRoom, gmRoom, serviceRoom, disconnectService, hydrate, gmView,
  deliver, deliverMany, history, allMessages,
  markPlayerRead, clearGmUnread, notifyGm, notifyGmSelf, notifyRoomState, notifyRoomDeleted, remove,
  deliverGm, removeGm, gmHistory, gmSelf, notifyRenamed, hydrateGm, notifyEveryone,
  toggleReaction, reactionsOf, kickParticipant, notifyPlayers, notifyParticipant,
};

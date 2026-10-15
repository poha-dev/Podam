'use strict';
const { db } = require('./db');
const { verifyGm, verifyPlayer } = require('./auth');
const G = require('./gms');
const REG = require('./modules');
const HOOKS = require('./modules/hooks');
const MODSTATE = require('./modules/state');
const { validTargets } = require('./targets');
const ASK = require('./ask');
const TIMER = require('./timer');
const M = require('./messages');

const MAX_BODY = 4000;

function setOnline(participantId, online) {
  db.prepare('UPDATE participants SET online = ?, last_seen = ? WHERE id = ?')
    .run(online ? 1 : 0, Date.now(), participantId);
}

function register(io) {
  M.setIo(io);

  io.on('connection', (socket) => {
    // 핸드셰이크에서 신원을 확정한다. 이후 socket.data만 신뢰하고
    // 클라이언트가 보내는 roomId/participantId는 절대 그대로 쓰지 않는다.
    const { gmToken, playerToken } = socket.handshake.auth || {};

    // 사람이 아닌 프로그램(보조 도구·봇)이 붙는 길. 모듈이 자기 토큰으로 받아들인다.
    const svc = HOOKS.socketAuth(socket.handshake.auth || {});
    if (svc) {
      if (svc.error) return socket.emit('auth:error', { error: svc.error }), socket.disconnect(true);
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(svc.roomId);
      if (!room) return socket.emit('auth:error', { error: '없는 방입니다' }), socket.disconnect(true);

      socket.data = { ...(svc.data || {}), role: svc.mod.id, roomId: room.id };
      socket.join(M.serviceRoom(room.id));
      socket.join(M.serviceRoom(room.id, svc.mod.id));
      socket.emit('auth:ok', {
        role: svc.mod.id, roomId: room.id, roomName: room.name,
        modules: MODSTATE.enabledIds(room),
        ...(svc.hello || {}),
      });
      // **그 모듈의 이벤트만** 연결한다. 일반 채팅·반응·타이핑이나 다른 모듈 이벤트로
      // 권한 경계를 우회할 수 없어야 한다.
      if (typeof svc.mod.socket === 'function') {
        svc.mod.socket({ io, socket, on: HOOKS.guardedOn(socket, svc.mod) });
      }
      return;
    }

    if (gmToken) {
      const found = verifyGm(gmToken);
      if (!found) return socket.emit('auth:error', { error: 'GM 세션이 만료되었습니다' }), socket.disconnect(true);
      const { gm, room } = found;
      socket.data = { role: 'gm', roomId: room.id, gmId: gm.id };
      socket.join(M.gmRoom(room.id));          // 모든 GM이 모든 플레이어 스레드를 본다
      socket.join(M.gmSelf(room.id, gm.id));   // 1:1 GM 대화 수신용
      db.prepare('UPDATE gms SET online = 1, last_seen = ? WHERE id = ?').run(Date.now(), gm.id);
      M.notifyGm(room.id, 'gm:presence', { id: gm.id, online: true });
      socket.emit('auth:ok', {
        role: 'gm', roomId: room.id, gmId: gm.id, nickname: gm.nickname, roomName: room.name,
        timer: TIMER.view(room.id),
        modules: MODSTATE.enabledIds(room),
      });
    } else if (playerToken) {
      const found = verifyPlayer(playerToken);
      if (!found) return socket.emit('auth:error', { error: '세션이 만료되었습니다' }), socket.disconnect(true);
      const { participant, room } = found;
      socket.data = { role: 'player', roomId: room.id, participantId: participant.id };
      socket.join(M.threadRoom(room.id, participant.id));
      setOnline(participant.id, true);
      M.notifyGm(room.id, 'participant:presence', { id: participant.id, online: true });
      socket.emit('auth:ok', {
        role: 'player',
        roomId: room.id,
        participantId: participant.id,
        nickname: participant.nickname,
        roomName: room.name,
        closed: !!room.closed,
        messages: M.history(room.id, participant.id),
        timer: TIMER.view(room.id),
        modules: REG.playerKnown(MODSTATE.enabledIds(room)),    // 방 밖에는 여전히 안 알린다
      });
    } else {
      socket.emit('auth:error', { error: '인증 정보가 없습니다' });
      return socket.disconnect(true);
    }

    // ── 플레이어 → GM ────────────────────────────────────────────────────────
    socket.on('player:send', (payload, ack) => {
      if (socket.data.role !== 'player') return;
      const typed = String(payload?.body || '').trim().slice(0, MAX_BODY);
      if (!typed) return;
      const room = db.prepare('SELECT closed FROM rooms WHERE id = ?').get(socket.data.roomId);
      if (room?.closed) return ack?.({ error: '종료된 방입니다' });

      const ctx = {
        roomId: socket.data.roomId,
        participantId: socket.data.participantId,   // 클라이언트 값이 아닌 서버 값
        body: typed,
        socket,
      };
      // 모듈이 먼저 볼 기회를 준다. 모듈이 없거나 실패하면 그냥 원래대로 배달된다.
      const pre = HOOKS.playerSend(ctx);
      if (pre.handled) return ack?.(pre.ack || { ok: true });

      const message = M.deliver({
        roomId: ctx.roomId,
        participantId: ctx.participantId,
        sender: 'player',
        kind: 'text',
        body: pre.body,
      });
      ack?.({ ok: true });
      HOOKS.afterPlayerSend({ ...ctx, body: pre.body, message });
    });

    // 이름이 바뀌면 이름표가 박힌 이력을 통째로 다시 받아 간다.
    socket.on('player:refresh', () => {
      if (socket.data.role !== 'player') return;
      socket.emit('history', M.history(socket.data.roomId, socket.data.participantId));
    });

    // 질문지에 답을 낸다 (항목별로, 여러 번 가능)
    socket.on('player:answer', ({ pollId, itemIndex, body } = {}, ack) => {
      if (socket.data.role !== 'player') return;
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(socket.data.roomId);
      const participant = db.prepare('SELECT * FROM participants WHERE id = ?')
        .get(socket.data.participantId);
      const out = ASK.submit({ room, participant, pollId, itemIndex, body });
      if (!out.error) {
        socket.emit('ask:mine', ASK.forPlayer(room.id, participant.id, pollId));
      }
      ack?.(out);
    });

    socket.on('ask:fetch', ({ pollId } = {}, ack) => {
      if (socket.data.role !== 'player') return;
      ack?.(ASK.forPlayer(socket.data.roomId, socket.data.participantId, pollId));
    });

    socket.on('player:read', () => {
      if (socket.data.role !== 'player') return;
      M.markPlayerRead(socket.data.roomId, socket.data.participantId);
    });

    // ── GM → 플레이어 ────────────────────────────────────────────────────────
    socket.on('gm:send', (payload, ack) => {
      if (socket.data.role !== 'gm') return;
      const body = String(payload?.body || '').trim().slice(0, MAX_BODY);
      const targets = validTargets(socket.data.roomId, payload?.targets);
      if (!body || targets.length === 0) return ack?.({ error: '받는 사람과 내용을 확인해 주세요' });
      const kind = targets.length > 1 ? 'broadcast' : 'text';
      M.deliverMany({
        roomId: socket.data.roomId, participantIds: targets,
        sender: 'gm', kind, body, fromGmId: socket.data.gmId,
        npcName: String(payload?.npcName || '').trim().slice(0, 30) || null,
      });
      ack?.({ ok: true, count: targets.length });
    });

    socket.on('gm:open', ({ participantId } = {}) => {
      if (socket.data.role !== 'gm') return;
      const p = db.prepare('SELECT id FROM participants WHERE id = ? AND room_id = ?')
        .get(participantId, socket.data.roomId);
      if (p) M.clearGmUnread(p.id);
    });

    // ── GM끼리의 대화 ────────────────────────────────────────────────────────
    socket.on('gm:chat', ({ channel, body } = {}, ack) => {
      if (socket.data.role !== 'gm') return;
      const text = String(body || '').trim().slice(0, MAX_BODY);
      if (!text) return;
      const gm = db.prepare('SELECT * FROM gms WHERE id = ?').get(socket.data.gmId);
      const ch = G.resolveChannel(gm, channel);
      if (!ch) return ack?.({ error: '없는 대화입니다' });
      M.deliverGm({ roomId: socket.data.roomId, channel: ch, fromGmId: gm.id, body: text });
      ack?.({ ok: true });
    });

    /** GM끼리의 대화에서 내가 쓴 것을 지운다 (전체방·1:1 모두). */
    socket.on('gm:chat:delete', ({ messageId } = {}, ack) => {
      if (socket.data.role !== 'gm') return ack?.({ error: '권한이 없습니다' });
      const err = M.removeGm({
        roomId: socket.data.roomId,
        messageId,
        gmId: socket.data.gmId,               // 클라이언트가 주장하는 값이 아니다
      });
      ack?.(err ? { error: err } : { ok: true });
    });

    // ── 대화에 표시 붙이기 (V / O / X / ? …) ─────────────────────────────────
    socket.on('reaction:toggle', ({ scope, messageId, emoji } = {}, ack) => {
      const who = socket.data;
      const mark = String(emoji || '').trim().slice(0, 64);
      if (!mark || !messageId) return ack?.({ error: '표시를 확인해 주세요' });
      const sc = scope === 'gm' ? 'gm' : 'msg';
      if (sc === 'gm' && who.role !== 'gm') return ack?.({ error: '권한이 없습니다' });

      // 플레이어는 자기 스레드의 메시지에만 표시할 수 있다.
      if (who.role === 'player') {
        const owned = db.prepare('SELECT 1 FROM messages WHERE id = ? AND room_id = ? AND participant_id = ?')
          .get(messageId, who.roomId, who.participantId);
        if (!owned) return ack?.({ error: '없는 메시지입니다' });
      }
      const actor = who.role === 'gm' ? `gm:${who.gmId}` : `p:${who.participantId}`;
      ack?.(M.toggleReaction({ roomId: who.roomId, scope: sc, messageId, actor, emoji: mark }));
    });

    // ── 메시지 삭제 ──────────────────────────────────────────────────────────
    socket.on('message:delete', ({ messageId } = {}, ack) => {
      const err = M.remove({
        roomId: socket.data.roomId,
        messageId,
        by: socket.data.role,                    // 클라이언트가 주장하는 역할이 아니다
        participantId: socket.data.participantId,
      });
      ack?.(err ? { error: err } : { ok: true });
    });

    // ── 타이핑 표시 ──────────────────────────────────────────────────────────
    socket.on('typing', ({ participantId, on } = {}) => {
      const roomId = socket.data.roomId;
      if (socket.data.role === 'player') {
        M.notifyGm(roomId, 'typing', { threadId: socket.data.participantId, from: 'player', on: !!on });
      } else {
        const p = db.prepare('SELECT id FROM participants WHERE id = ? AND room_id = ?').get(participantId, roomId);
        if (p) io.to(M.threadRoom(roomId, p.id)).emit('typing', { from: 'gm', on: !!on });
      }
    });

    // 모듈이 가진 자기 이벤트 (이름은 mod:<모듈id>: 로 시작해야 한다)
    for (const mod of REG.list()) {
      if (typeof mod.socket === 'function') {
        mod.socket({ io, socket, on: HOOKS.guardedOn(socket, mod) });
      }
    }

    /**
     * 한 사람이 창을 **여럿** 열어 둘 수 있다 (방 화면 + 오버레이 창).
     * 그중 하나만 닫았는데 「나갔다」고 알리면 GM 화면의 접속 표시가 틀어진다.
     * 같은 방에 아직 다른 창이 남아 있는지 보고 나서 끈다.
     */
    const stillHere = async (room) => (await io.in(room).fetchSockets()).length > 0;

    socket.on('disconnect', async () => {
      if (socket.data?.role === 'player') {
        const { roomId, participantId } = socket.data;
        if (await stillHere(M.threadRoom(roomId, participantId))) return;
        setOnline(participantId, false);
        M.notifyGm(roomId, 'participant:presence', { id: participantId, online: false });
      }
      if (socket.data?.role === 'gm') {
        const { roomId, gmId } = socket.data;
        if (await stillHere(M.gmSelf(roomId, gmId))) return;
        db.prepare('UPDATE gms SET online = 0, last_seen = ? WHERE id = ?').run(Date.now(), gmId);
        M.notifyGm(roomId, 'gm:presence', { id: gmId, online: false });
      }
    });
  });
}

module.exports = { register };

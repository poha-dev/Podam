'use strict';
const { db } = require('../db');
const REG = require('./index');
const STATE = require('./state');

/**
 * 모듈이 대화 흐름에 끼어드는 지점.
 *
 * 규칙 세 가지 — 이게 깨지면 채팅 전체가 멈춘다:
 *  1) 모듈이 예외를 던져도 메시지는 **반드시** 배달된다 (예외는 '의견 없음'으로 본다).
 *  2) 동기 함수만 쓴다. Promise 를 돌려주면 무시한다 (조용한 이중 발송을 막는다).
 *  3) 켜진 모듈만 부른다. on/off 는 부를 때마다 방 행에서 다시 읽는다.
 */

/** 이 방에서 그 훅을 가진, 켜진 모듈들. */
function active(roomId, hookName) {
  const mods = REG.withHook(hookName);
  if (mods.length === 0) return [];
  const room = db.prepare('SELECT id, modules FROM rooms WHERE id = ?').get(roomId);
  if (!room) return [];
  return mods.filter((m) => STATE.isEnabled(room, m.id));
}

function run(mod, hookName, ctx) {
  try {
    const out = mod.hooks[hookName](ctx);
    if (out && typeof out.then === 'function') {
      console.warn(`[모듈] ${mod.id}.${hookName} 이 비동기라 무시했습니다`);
      return undefined;
    }
    return out;
  } catch (e) {
    console.error(`[모듈] ${mod.id}.${hookName} 실패 — ${e.message}`);
    return undefined;                     // 의견 없음 = 원래 흐름 그대로
  }
}

/**
 * 플레이어 발화가 배달되기 **전**.
 *   undefined | {}            → 의견 없음
 *   { body }                  → 본문을 바꿔서 배달
 *   { handled: true, ack }    → 원래 배달을 하지 않는다 (모듈이 알아서 보냈다는 뜻)
 */
function playerSend(ctx) {
  let body = ctx.body;
  for (const mod of active(ctx.roomId, 'playerSend')) {
    const out = run(mod, 'playerSend', { ...ctx, body });
    if (!out) continue;
    if (out.handled) return { handled: true, ack: out.ack };
    if (typeof out.body === 'string') {
      body = out.body.trim();
      if (!body) return { handled: true, ack: { ok: true } };   // 빈 본문은 삼킨다
    }
  }
  return { handled: false, body };
}

/** 배달된 **뒤**. 돌려주는 값을 보지 않는다 — 흐름을 바꿀 방법이 없다. */
function afterPlayerSend(ctx) {
  for (const mod of active(ctx.roomId, 'afterPlayerSend')) run(mod, 'afterPlayerSend', ctx);
}

/**
 * 「이 파일을 이 플레이어가 열어도 되는가」를 모듈에게 물어본다.
 *
 * 기본은 **거부**다. 켜진 모듈 중 하나라도 '된다'고 해야 열린다.
 * 모듈이 터지면(run 이 undefined) 역시 거부다 — 실패가 권한을 넓히면 안 된다.
 */
function fileAccess(ctx) {
  for (const mod of active(ctx.roomId, 'fileAccess')) {
    if (run(mod, 'fileAccess', ctx) === true) return true;
  }
  return false;
}

/**
 * 「이 파일을 아직 쓰고 있는가」를 모듈에게 물어본다.
 *
 * 자료함에서 파일을 뺄 때 쓴다. 하나라도 쓰고 있다고 하면 실물을 지우지 않고 숨기기만 한다
 * (지워 버리면 무대 배경이나 캐릭터 그림이 깨진 그림으로 남는다).
 * 모듈이 터지면 **쓰고 있는 것으로 본다** — 실수로 지우는 쪽이 더 나쁘다.
 */
function fileInUse(file) {
  for (const mod of active(file.room_id, 'fileInUse')) {
    let out;
    try {
      out = mod.hooks.fileInUse(file);
    } catch (e) {
      console.error(`[모듈] ${mod.id}.fileInUse 실패 — ${e.message}`);
      return true;
    }
    if (out === true) return true;
  }
  return false;
}

/**
 * **서비스 소켓** — 사람이 아닌 프로그램(보조 도구·봇)이 붙는 길.
 *
 * 핸드쉐이크에 담겨 온 값을 모듈들에게 차례로 보여 주고, 처음으로 「내 것」이라고
 * 나서는 모듈에게 맡긴다. 모듈은 셋 중 하나를 돌려준다.
 *   null · undefined        — 내 것이 아니다 (다음 모듈로)
 *   { error }               — 내 것인데 거절한다 (바로 끊는다)
 *   { roomId, data, hello } — 받아든다
 *
 * 받아들이면 코어가 **그 모듈의 소켓 핸들러만** 연결한다. 일반 채팅·반응·타이핑으로
 * 권한 경계를 우회할 수 없어야 하기 때문이다.
 */
function socketAuth(auth) {
  for (const mod of REG.list()) {
    if (typeof mod.hooks?.socketAuth !== 'function') continue;
    let out;
    try {
      out = mod.hooks.socketAuth(auth);
    } catch (e) {
      console.error(`[모듈] ${mod.id}.socketAuth 실패 — ${e.message}`);
      continue;
    }
    if (!out) continue;
    if (out.error) return { mod, error: out.error };
    if (!out.roomId) {
      console.error(`[모듈] ${mod.id}.socketAuth 가 roomId 를 주지 않았습니다`);
      continue;
    }
    return { mod, ...out };
  }
  return null;
}

/**
 * 모듈 전용 소켓 이벤트를 감싸는 등록기.
 * 이름 규칙·모듈 on/off·예외를 여기서 한 번에 처리한다.
 */
function guardedOn(socket, mod) {
  return (event, handler) => {
    if (!String(event).startsWith(`mod:${mod.id}:`)) {
      throw new Error(`[모듈] ${mod.id} 이벤트 이름 규칙 위반 — ${event}`);
    }
    socket.on(event, (payload, ack) => {
      const roomId = socket.data?.roomId;
      const room = roomId && db.prepare('SELECT id, modules FROM rooms WHERE id = ?').get(roomId);
      if (!room || !STATE.isEnabled(room, mod.id)) {
        return ack?.({ error: '사용하지 않는 기능입니다' });
      }
      try {
        handler(payload, ack);
      } catch (e) {
        console.error(`[모듈] ${mod.id} ${event} 실패 — ${e.message}`);
        ack?.({ error: '처리 중 오류가 발생했습니다' });
      }
    });
  };
}

module.exports = { playerSend, afterPlayerSend, fileAccess, fileInUse, socketAuth, guardedOn };

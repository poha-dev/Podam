'use strict';
const express = require('express');
const SET = require('./settings');

const router = express.Router();

/**
 * **공개 주소를 아는 단 한 곳.**
 *
 * 플레이어 링크는 이 주소로 만들어야 한다. 브라우저 주소창(`location.origin`)을 그대로 쓰면,
 * GM 이 `localhost` 로 열어 둔 채 방을 만들었을 때 플레이어에게 `localhost` 링크가 나간다 —
 * 남의 컴퓨터에서는 절대 열리지 않는 링크다.
 *
 * 아는 길은 셋이고, 앞의 것이 이긴다.
 *   1. 런처가 알려 준 것 — 터널이 서버보다 늦게 뜨므로 환경변수로는 늦다. 그래서 IPC 로 받는다
 *   2. 설정의 `PUBLIC_URL` — 고정 도메인을 쓰는 사람
 *   3. cloudflared 의 `--metrics` 창구 — 도커로 띄운 경우 (지금까지 쓰던 길)
 */

const METRICS = process.env.TUNNEL_METRICS || 'http://tunnel:20241/quicktunnel';
const TTL = 30_000;

let told = null;                       // 런처가 알려 준 주소
let cache = { url: null, at: 0 };

/** 응답 모양이 버전마다 조금씩 달라서, 주소처럼 생긴 것을 찾아낸다. */
function pickUrl(text) {
  const m = String(text).match(/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? `https://${m[0]}` : null;
}

const clean = (u) => {
  const s = String(u || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+$/i.test(s) ? s : null;
};

// 런처가 터널 주소를 받으면 알려 준다.
process.on('message', (m) => {
  if (m && m.type === 'public-url') told = clean(m.url);
});

/** 지금 아는 공개 주소. 모르면 null — 그건 오류가 아니다. */
async function publicUrl() {
  if (told) return told;
  const set = clean(SET.str('PUBLIC_URL', ''));
  if (set) return set;
  if (Date.now() - cache.at < TTL) return cache.url;
  try {
    const r = await fetch(METRICS, { signal: AbortSignal.timeout(2000) });
    cache = { url: pickUrl(await r.text()), at: Date.now() };
  } catch {
    cache = { url: null, at: Date.now() };
  }
  return cache.url;
}

/** 물어보지 않고 지금 들고 있는 것만 (화면이 기다리지 않게). */
const known = () => told || clean(SET.str('PUBLIC_URL', '')) || cache.url;

router.get('/public-url', async (_req, res) => res.json({ url: await publicUrl() }));

module.exports = { router, publicUrl, known };

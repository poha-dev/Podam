'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 환경변수 대신 파일로도 설정할 수 있게 한다.
 *
 * Container Station처럼 YAML을 고치기 번거로운 환경에서, NAS 공유폴더의
 *   /share/Container/podam/src/settings.local.json
 * 만 고치면 되도록 하기 위한 것이다. (src 폴더는 컨테이너 안으로 그대로
 * 연결돼 있고, 웹으로는 공개되지 않는다 — public 폴더가 아니다.)
 *
 * 파일 값이 환경변수보다 우선한다. 파일을 고치면 몇 초 안에 반영되므로
 * 컨테이너를 다시 시작하지 않아도 된다.
 */
// 어느 파일을 볼 것인가는 paths.js 가 정한다
// (소스 옆의 settings.local.json → 없으면 데이터 폴더의 settings.json).
const FILE = require('./paths').configFile();
const CACHE_MS = 3000;

let cache = {};
let readAt = 0;

function load() {
  const now = Date.now();
  if (now - readAt < CACHE_MS) return cache;
  readAt = now;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw.replace(/^﻿/, ''));   // 메모장이 붙이는 BOM 제거
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    // 파일이 없으면 환경변수만 쓴다. 내용이 깨졌으면 알려주되 멈추지는 않는다.
    if (e.code !== 'ENOENT' && cache.__warned !== true) {
      console.warn(`[설정] ${FILE} 를 읽지 못했습니다 — ${e.message}`);
      cache = { __warned: true };
    } else if (e.code === 'ENOENT') {
      cache = {};
    }
  }
  return cache;
}

/** 문자열 설정. 파일 → 환경변수 순으로 찾는다. */
function str(key, fallback = '') {
  const fromFile = load()[key];
  if (fromFile !== undefined && fromFile !== null) return String(fromFile).trim();
  const fromEnv = process.env[key];
  return fromEnv === undefined ? fallback : String(fromEnv).trim();
}

/** 켬/끔 설정. 값이 아예 없으면 undefined 를 돌려준다 (기본값 판단은 호출한 쪽에서). */
function bool(key) {
  const v = str(key, '');
  if (v === '') return undefined;
  return /^(1|true|yes|on|y)$/i.test(v);
}

/** 숫자 설정. */
function num(key, fallback) {
  const v = Number(str(key, ''));
  return Number.isFinite(v) && str(key, '') !== '' ? v : fallback;
}

/** 지금 설정 파일이 쓰이고 있는지 (화면 안내용). */
const usingFile = () => fs.existsSync(FILE);

module.exports = { str, bool, num, usingFile, FILE };

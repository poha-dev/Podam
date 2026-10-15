'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');

// GM이 NAS의 public/assets 아래에 파일을 넣어두면 모두가 그대로 쓴다.
//   public/assets/sounds/*  — 알림음(대화·타이머 공용)
//   public/assets/emoji/*   — 대화에 붙이는 표시
const ASSETS = path.join(__dirname, '..', 'public', 'assets');
const SOUND_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
const EMOJI_EXT = new Set(['.png', '.gif', '.webp', '.jpg', '.jpeg']);

/** 파일 이름을 그대로 쓰되, 경로 조작에 쓰일 수 있는 이름은 걸러낸다. */
const safeName = (n) => /^[\w가-힣][\w가-힣 .\-()]{0,60}$/.test(n);

function listDir(kind, allowed) {
  const dir = path.join(ASSETS, kind);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => allowed.has(path.extname(n).toLowerCase()) && safeName(n))
    .sort((a, b) => a.localeCompare(b, 'ko'))
    .map((n) => ({
      id: `${kind}:${n}`,
      name: path.basename(n, path.extname(n)),
      url: `/assets/${kind}/${encodeURIComponent(n)}`,
    }));
}

const router = express.Router();

/** 기본으로 깔아둔 알림음과 표시 목록. 로그인 없이도 화면이 쓸 수 있다. */
router.get('/presets', (_req, res) => {
  res.json({ sounds: listDir('sounds', SOUND_EXT), emojis: listDir('emoji', EMOJI_EXT) });
});

module.exports = { router, listDir, SOUND_EXT, EMOJI_EXT };

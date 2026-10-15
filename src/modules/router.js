'use strict';
const express = require('express');
const { requireGm } = require('../guards');
const M = require('../messages');
const REG = require('./index');
const STATE = require('./state');

const router = express.Router();

/** 모듈 목록(설명만). 방 만들기 화면이 로그인 전에 쓰므로 인증이 없다. */
router.get('/modules', (_req, res) => {
  res.json({ modules: REG.catalog() });
});

/** 모듈별 사용법. 화면이 그대로 붙여 쓴다. */
router.get('/modules/guides', (_req, res) => {
  res.json({ guides: REG.guides() });
});

router.get('/gm/modules', requireGm, (req, res) => {
  res.json({ modules: REG.catalog(), enabled: STATE.enabledIds(req.room) });
});

/** 켜고 끄기. { id, on } 하나씩 또는 { ids: [...] } 통째로. */
router.put('/gm/modules', requireGm, (req, res) => {
  let enabled;
  if (Array.isArray(req.body?.ids)) {
    enabled = STATE.setEnabled(req.room.id, STATE.normalize(req.body.ids, REG.ids()));
  } else {
    const id = String(req.body?.id || '');
    if (!REG.byId(id)) return res.status(404).json({ error: '없는 모듈입니다' });
    enabled = STATE.toggle(req.room, id, !!req.body?.on);
  }

  // GM에게는 전부, 플레이어에게는 알려도 되는 것만.
  M.notifyGm(req.room.id, 'modules:changed', { enabled });
  M.notifyPlayers(req.room.id, 'modules:changed', { enabled: REG.playerVisible(enabled) });
  res.json({ enabled });
});

module.exports = { router };

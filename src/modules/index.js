'use strict';
const fs = require('fs');
const path = require('path');
const { CORE_DIR, modulesDir } = require('../paths');

/**
 * 모듈 목록.
 *
 * **모듈은 폴더 하나다.** `<데이터폴더>/modules` 아래의 폴더를 훑어 싣는다.
 * 코어에는 모듈이 하나도 들어 있지 않다 — 폴더를 넣고 빼는 것이 곧 기능의 더하고 빼기다.
 *
 * 폴더를 훑되 **조용히 넘어가지는 않는다.** 무엇을 어디서 실었는지 부팅 때 한 줄로 찍고,
 * id 형식·중복·이벤트 이름이 어긋나면 서버가 아예 뜨지 않는다. 잘못 넣은 모듈을
 * 세션 도중에 발견하는 것보다 켤 때 바로 아는 편이 낫다.
 */

/** 모듈이 기대는 코어의 판. 안 맞으면 싣지 않는다. */
const MODULE_API = 1;

const ID_RE = /^[a-z][a-z0-9-]{1,20}$/;

/**
 * 모듈이 코어를 가져다 쓸 수 있게 길을 놓는다.
 *
 *   require('podam/db')   → 코어 소스 (`src/db.js`)
 *   require('express')    → 코어가 쓰는 것과 같은 것
 *
 * 모듈 폴더가 앱 바깥에 있어 Node 가 알아서 찾지 못하므로,
 * `<모듈폴더>/node_modules/` 에 링크를 깔아 둔다. 링크를 못 만드는 곳(일부 USB
 * 파일시스템)에서는 **같은 이름의 작은 다리 파일**을 대신 깐다. 모듈 쪽 코드는 똑같다.
 */
function linkCore(dir) {
  const nm = path.join(dir, 'node_modules');
  const core = fs.realpathSync(CORE_DIR);
  const app = path.join(core, '..');

  // 무엇을 연결할 것인가 — 코어 소스 하나와, 코어가 쓰는 라이브러리들
  const want = new Map([['podam', core]]);
  try {
    const deps = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).dependencies || {};
    for (const dep of Object.keys(deps)) {
      const at = path.join(app, 'node_modules', dep);
      if (fs.existsSync(at)) want.set(dep, at);
    }
  } catch { /* 의존성을 못 읽어도 podam 만은 연결한다 */ }

  fs.mkdirSync(nm, { recursive: true });
  for (const [name, target] of want) {
    const link = path.join(nm, name);
    try {
      let now = null;
      try { now = fs.realpathSync(link); } catch { /* 아직 없다 */ }
      if (now === target) continue;
      fs.rmSync(link, { recursive: true, force: true });
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      bridge(link, name, target);
    }
  }
}

/** 링크를 못 만들 때 — 같은 자리에 진짜를 가리키는 작은 파일을 둔다. */
function bridge(link, name, target) {
  const stub = (to) => `module.exports = require(${JSON.stringify(to)});\n`;
  try {
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(link, { recursive: true });
    fs.writeFileSync(path.join(link, 'package.json'), `{ "name": ${JSON.stringify(name)} }\n`, 'utf8');
    fs.writeFileSync(path.join(link, 'index.js'), stub(target), 'utf8');
    if (name !== 'podam') return;
    // podam 은 `podam/db` 처럼 안까지 가리키므로 파일마다 다리를 놓는다
    for (const sub of ['', 'modules']) {
      const from = path.join(target, sub);
      const to = path.join(link, sub);
      fs.mkdirSync(to, { recursive: true });
      for (const f of fs.readdirSync(from)) {
        if (f.endsWith('.js')) fs.writeFileSync(path.join(to, f), stub(path.join(from, f)), 'utf8');
      }
    }
  } catch (e) {
    console.warn(`[모듈] ${name} 으로 가는 길을 놓지 못했습니다 — ${e.message}`);
  }
}

/** 모듈 하나를 받아들일 수 있는지 본다. 어긋나면 던진다. */
function check(m, where, seen) {
  const at = `(${where})`;
  if (!m || !ID_RE.test(m.id || '')) throw new Error(`[모듈] id 형식이 잘못되었습니다: ${m && m.id} ${at}`);
  if (seen.has(m.id)) throw new Error(`[모듈] id가 겹칩니다: ${m.id} ${at}`);
  if (!m.name) throw new Error(`[모듈] 이름이 없습니다: ${m.id} ${at}`);
  for (const ev of m.events || []) {
    // 모듈이 기존 이벤트(player:send 등)를 가로채지 못하게 이름을 묶어 둔다.
    if (!String(ev).startsWith(`mod:${m.id}:`)) {
      throw new Error(`[모듈] ${m.id} 의 이벤트 이름은 mod:${m.id}: 로 시작해야 합니다 — ${ev} ${at}`);
    }
  }
}

const HOME = new Map();      // id -> 그 모듈이 사는 폴더

/**
 * 맨 처음 켤 때 — 배포판에 동봉한 공식 모듈을 모듈 폴더로 옮겨 둔다.
 * 받자마자 아무 기능도 없으면 당황스러우니까. 한 번만 하고, 이후는 사용자 것이다.
 */
function copyStarter(dir) {
  const from = path.join(CORE_DIR, '..', 'modules-starter');
  try {
    if (fs.existsSync(dir) || !fs.existsSync(from)) return;
    fs.cpSync(from, dir, { recursive: true });
    console.log(`처음 켜셔서 공식 모듈을 넣어 두었습니다 — ${dir}`);
  } catch (e) {
    console.warn(`[모듈] 기본 모듈을 넣지 못했습니다 — ${e.message}`);
  }
}

function load() {
  const dir = modulesDir();
  copyStarter(dir);
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    console.log(`모듈 없음 — 넣을 곳: ${dir}`);
    return [];
  }

  linkCore(dir);

  const out = [];
  const seen = new Set();
  for (const name of names.sort()) {
    // `.` 이나 `_` 로 시작하면 건너뛴다 — 지우지 않고 잠깐 꺼 두는 방법이다.
    if (name.startsWith('.') || name.startsWith('_') || name === 'node_modules') continue;
    const home = path.join(dir, name);
    if (!fs.existsSync(path.join(home, 'index.js'))) continue;    // 모듈이 아닌 폴더

    const m = require(home);
    check(m, name, seen);
    if (m.api !== undefined && Number(m.api) !== MODULE_API) {
      console.warn(`[모듈] ${m.id} 는 이 판과 맞지 않아 싣지 않았습니다 (모듈 ${m.api} · 코어 ${MODULE_API})`);
      continue;
    }
    seen.add(m.id);
    HOME.set(m.id, home);
    out.push(m);
  }

  const label = (m) => {
    const folder = path.basename(HOME.get(m.id));
    return folder === m.id ? m.id : `${m.id}(${folder})`;
  };
  console.log(out.length
    ? `모듈 ${out.length}개: ${out.map(label).join(', ')}  (${dir})`
    : `모듈 없음 — 넣을 곳: ${dir}`);
  return out;
}

const MODULES = load();

const list = () => MODULES.slice();
const byId = (id) => MODULES.find((m) => m.id === id) || null;
const ids = () => MODULES.map((m) => m.id);

/** 그 모듈이 자기 화면 파일을 두는 곳. 없으면 null. */
function publicDir(id) {
  const home = HOME.get(id);
  if (!home) return null;
  const dir = path.join(home, 'public');
  return fs.existsSync(dir) ? dir : null;
}

/** 화면에 뿌려도 되는 정보만. 방 데이터가 섞이지 않는다. */
const catalog = () => MODULES.map((m) => ({
  id: m.id,
  name: m.name,
  description: m.description || '',
  defaultOn: !!m.defaultOn,
  playerUi: !!m.playerUi,
  gmTab: m.gmTab || null,
  hasPlayerGuide: !!m.guide?.player,
}));

/** 가이드 화면이 쓰는 글. 모듈을 추가하면 가이드도 따라온다. */
const guides = () => MODULES
  .filter((m) => m.guide)
  .map((m) => ({ id: m.id, name: m.name, gm: m.guide.gm || '', player: m.guide.player || '' }));

const defaultIds = () => MODULES.filter((m) => m.defaultOn).map((m) => m.id);

/** 플레이어에게 알려도 되는 모듈만 추린다 (켜진 사실 자체가 스포일러일 수 있다). */
const playerVisible = (enabled) =>
  enabled.filter((id) => byId(id)?.playerUi);

/**
 * 방에 들어온 플레이어가 알아도 되는 모듈.
 * 화면(탭)이 있거나, 쓰는 법을 알아야 하는 모듈이 여기 들어간다.
 * 방 밖에서 코드만 아는 사람에게는 여전히 알리지 않는다.
 */
const playerKnown = (enabled) =>
  enabled.filter((id) => { const m = byId(id); return m && (m.playerUi || m.playerGuide); });

/** 훅을 가진 모듈만. 훅 실행기가 쓴다. */
const withHook = (name) => MODULES.filter((m) => typeof m.hooks?.[name] === 'function');

/** 모듈 테이블을 만든다. server.js 가 부팅 때 한 번 부른다. */
function initSchema(db, addColumn) {
  for (const m of MODULES) {
    if (typeof m.schema === 'function') m.schema(db, addColumn);
  }
}

module.exports = {
  MODULE_API,
  list, byId, ids, publicDir, catalog, guides, defaultIds,
  playerVisible, playerKnown, withHook, initSchema,
};

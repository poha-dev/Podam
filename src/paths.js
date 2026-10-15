'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 파일이 사는 곳을 한 군데서 정한다.
 *
 * 어디서 실행하든(cwd 와 무관하게) 같은 곳을 가리키도록 전부 `__dirname` 기준이다.
 */

/** 앱이 풀린 폴더. */
const APP_DIR = path.join(__dirname, '..');

/** 코어 소스 폴더 — 모듈이 `podam/...` 로 가져다 쓰는 것이 여기다. */
const CORE_DIR = __dirname;

/**
 * **들고 다니는 판**인가. `portable.txt` 를 두면 데이터도 그 옆에 넣는다.
 * USB 에 넣어 다니거나, 한 컴퓨터에서 여러 벌을 따로 쓰고 싶을 때.
 *
 * 두 군데를 본다 — 배포판은 `포담 시작.cmd` 가 있는 **바깥 폴더**가 사람이 보는 자리고,
 * 소스로 쓸 때는 그 자리가 곧 앱 폴더다. 어느 쪽에 두든 찾아야 한다.
 */
function portableAt() {
  if (process.env.PODAM_PORTABLE) return APP_DIR;
  for (const dir of [APP_DIR, path.join(APP_DIR, '..')]) {
    if (fs.existsSync(path.join(dir, 'portable.txt'))) return dir;
  }
  return null;
}

const isPortable = () => !!portableAt();

/**
 * 사람이 **보는** 폴더. 배포판에서는 프로그램이 `app/` 안에 들어 있으므로,
 * 바깥(= `포담 시작.cmd` 와 `runtime` 이 있는 곳)이 사람이 여는 자리다.
 * 소스로 쓸 때는 그냥 프로젝트 폴더다.
 */
function visibleRoot() {
  const up = path.join(APP_DIR, '..');
  const looksLikeRelease = fs.existsSync(path.join(up, 'runtime'))
    || fs.readdirSync(up).some((f) => f.endsWith('.cmd'));
  return looksLikeRelease ? path.resolve(up) : APP_DIR;
}

/** 운영체제가 「프로그램이 자기 데이터를 두는 곳」이라고 정해 둔 자리. */
function userDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Podam');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Podam');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'podam');
}

/**
 * 방·대화·올린 파일이 사는 곳. 앞의 것이 이긴다.
 *
 *   1. `DATA_DIR`                  — 직접 정한 사람 (도커·서버·고급)
 *   2. `portable.txt` 를 둔 자리
 *   3. **프로그램 옆에 쓰던 기록이 있으면 그것**
 *   4. **사용자 폴더에 쓰던 기록이 있으면 그것** — 옛 판을 쓰던 사람이 잃지 않게
 *   5. 새로 시작하면 **프로그램 옆**. 거기에 쓸 수 없으면(예: `Program Files`) 사용자 폴더
 *
 * 프로그램 옆이 기본인 이유: 압축을 풀어 쓰는 프로그램이라 **눈에 보이는 곳**에 있어야
 * 옮기고 지우고 들고 다니기가 쉽다. 숨은 폴더에 몰래 쌓이면 찾지도 못한다.
 * 대신 새 판을 다른 폴더에 풀면 지난 기록이 따라오지 않으므로, `data` 폴더를 옮겨 주면 된다.
 */
function dataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);

  const marked = portableAt();
  if (marked) return path.join(marked, 'data');            // 직접 표시해 둔 자리

  const beside = path.join(visibleRoot(), 'data');
  if (hasRecords(beside)) return beside;                   // 여기서 쓰던 기록이 있다
  if (hasRecords(userDir())) return userDir();             // 옛 판을 쓰던 사람 — 잃지 않게
  return canWrite(beside) ? beside : userDir();            // 새로 시작: 보이는 곳에, 못 쓰면 사용자 폴더
}

/** 그 폴더에 이미 쓰던 기록이 있는가. */
const hasRecords = (dir) =>
  fs.existsSync(path.join(dir, 'podam.sqlite')) || fs.existsSync(path.join(dir, 'mm.sqlite'));

/** 거기에 쓸 수 있는가 (`Program Files` 처럼 막힌 자리를 가려낸다). */
function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 데이터베이스 파일. 옛 이름(`mm.sqlite`)이 있으면 그것을 계속 쓴다 —
 * 이름이 바뀌었다고 지난 기록이 사라지면 안 된다.
 */
function dbFile() {
  const dir = dataDir();
  const old = path.join(dir, 'mm.sqlite');
  return fs.existsSync(old) ? old : path.join(dir, 'podam.sqlite');
}

/**
 * 설정 파일. 소스 폴더에 `settings.local.json` 을 둔 사람(도커·NAS)은 그대로 쓰고,
 * 아니면 데이터 폴더의 `settings.json` 을 본다 — 배포판에는 손댈 소스 폴더가 없다.
 */
function configFile() {
  const beside = path.join(CORE_DIR, 'settings.local.json');
  return fs.existsSync(beside) ? beside : path.join(dataDir(), 'settings.json');
}

/**
 * **모듈을 찾는 곳들.** 앞에서부터 차례로 훑고, 나온 것을 모두 실는다.
 *
 *   1. 프로그램 옆의 `modules`  — 배포판에 따라온 공식 모듈이 여기 있다
 *   2. 데이터 폴더의 `modules`  — 나중에 받아 넣는 것. 새 판으로 갈아도 남는다
 *
 * 한 곳으로 모으고 옮기지 않는다 — 사람이 넣지 않은 곳에 파일을 만들어 두는 것은
 * 갈할 일이고, 어느 쏪이 진짜인지 헷갈리게 만든다.
 */
function modulesDirs() {
  if (process.env.PODAM_MODULES_DIR) return [path.resolve(process.env.PODAM_MODULES_DIR)];
  const out = [];
  for (const dir of [path.join(APP_DIR, 'modules'), path.join(APP_DIR, '..', 'modules')]) {
    const at = path.resolve(dir);
    if (fs.existsSync(at) && !out.includes(at)) out.push(at);
  }
  const mine = path.join(dataDir(), 'modules');
  if (!out.includes(mine)) out.push(mine);
  return out;
}

/** 새로 받은 모듈을 넣으라고 알려 줄 자리 (막 찾는 곳). */
const modulesDir = () => modulesDirs()[0];

/** 런처가 쓰는 자리들. */
const runFile = () => path.join(dataDir(), 'run.json');
const logDir = () => path.join(dataDir(), 'logs');
const binDir = () => path.join(dataDir(), 'bin');

module.exports = {
  APP_DIR, CORE_DIR, isPortable, userDir,
  dataDir, dbFile, configFile, modulesDir, modulesDirs, runFile, logDir, binDir,
};

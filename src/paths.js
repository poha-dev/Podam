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
 *   1. `DATA_DIR`     — 직접 정한 사람 (도커·NAS·고급)
 *   2. 들고 다니는 판  — 앱 폴더 안의 `data`
 *   3. **앱 폴더에 이미 데이터가 있으면 그것** — 쓰던 사람이 기록을 잃지 않게
 *   4. 그 밖에는 운영체제가 정한 사용자 폴더
 *
 * 4번이 기본인 이유: 프로그램을 `Program Files` 같은 **쓸 수 없는 곳**에 두어도 돌아야 하고,
 * 새 판을 받아 다른 폴더에 풀어도 지난 방이 그대로 보여야 하기 때문이다.
 */
function dataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  const here = portableAt();
  if (here) return path.join(here, 'data');       // 표시해 둔 자리 옆에 쌓는다
  const beside = path.join(APP_DIR, 'data');
  if (fs.existsSync(path.join(beside, 'podam.sqlite')) || fs.existsSync(path.join(beside, 'mm.sqlite'))) {
    return beside;
  }
  return userDir();
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
 * 모듈 폴더. **여기에 폴더를 넣으면 기능이 붙는다.**
 * 데이터 쪽에 두는 이유: 앱을 새 판으로 갈아도 넣어 둔 모듈이 남아야 하기 때문이다.
 */
const modulesDir = () => path.resolve(process.env.PODAM_MODULES_DIR || path.join(dataDir(), 'modules'));

/** 런처가 쓰는 자리들. */
const runFile = () => path.join(dataDir(), 'run.json');
const logDir = () => path.join(dataDir(), 'logs');
const binDir = () => path.join(dataDir(), 'bin');

module.exports = {
  APP_DIR, CORE_DIR, isPortable, userDir,
  dataDir, dbFile, configFile, modulesDir, runFile, logDir, binDir,
};

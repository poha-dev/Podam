'use strict';
const fs = require('fs');
const PATHS = require('../../src/paths');

/**
 * **한 번에 하나만 뜨게.**
 *
 * 바탕화면 아이콘을 두 번 누르는 일이 가장 흔한 사고라, 두 번째는 서버를 또 띄우는 대신
 * 「이미 돌고 있습니다」를 알리고 그 주소를 열어 준다.
 *
 * 돌고 있는지는 **파일에 적힌 pid 가 살아 있는지**로 본다. 창을 강제로 닫아 기록이 남아도
 * 그 pid 는 죽어 있으므로 다음 실행이 알아서 치운다.
 */

function read() {
  try {
    const was = JSON.parse(fs.readFileSync(PATHS.runFile(), 'utf8'));
    if (!was || !was.pid) return null;
    process.kill(was.pid, 0);        // 신호 0 = 「살아 있니」만 물어본다
    return was;
  } catch {
    return null;                      // 파일이 없거나, 깨졌거나, 그 프로세스가 죽었다
  }
}

function write(info) {
  try {
    fs.mkdirSync(PATHS.dataDir(), { recursive: true });
    fs.writeFileSync(PATHS.runFile(), JSON.stringify({ pid: process.pid, ...info }, null, 1), 'utf8');
  } catch { /* 못 적어도 돌아가는 데는 지장이 없다 */ }
}

const clear = () => { try { fs.rmSync(PATHS.runFile(), { force: true }); } catch { /* 괜찮다 */ } };

module.exports = { read, write, clear };

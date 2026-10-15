'use strict';
const { spawn, spawnSync } = require('child_process');

/**
 * 운영체제마다 다른 잔일 — 브라우저 열기, 클립보드에 넣기, 자식 프로세스 묶어서 끝내기.
 * 실패해도 **아무 일도 일어나지 않아야 한다.** 세션을 시작하는 데 꼭 필요한 일이 아니다.
 */

/** 기본 브라우저로 주소 열기. */
function openUrl(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 못 열면 주소를 보고 직접 열면 된다 */ }
}

/** 클립보드에 넣기. 넣었으면 true. */
function copy(text) {
  const how = process.platform === 'win32' ? ['clip', []]
    : process.platform === 'darwin' ? ['pbcopy', []]
      : ['xclip', ['-selection', 'clipboard']];
  try {
    const out = spawnSync(how[0], how[1], { input: text, windowsHide: true });
    return !out.error && out.status === 0;
  } catch {
    return false;
  }
}

/**
 * 자식과 **그 자식까지** 끝낸다.
 * 윈도는 손자(cloudflared 가 띄우는 것)를 알아서 안 잡아 주므로 taskkill 로 나무째 끝낸다.
 */
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGTERM');     // detached 로 띄웠으므로 무리 전체
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 이미 죽었다 */ }
  }
}

module.exports = { openUrl, copy, killTree };

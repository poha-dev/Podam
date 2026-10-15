'use strict';
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const PATHS = require('../../src/paths');
const SET = require('../../src/settings');
const LOCK = require('./lock');
const OPEN = require('./open');
const TUNNEL = require('./tunnel');

/**
 * 세션 하나를 켜는 사람.
 *
 *   서버를 띄우고 → 바깥 주소를 받고 → 브라우저를 열고 → 끝날 때 뒤를 치운다.
 *
 * 하던 일을 PowerShell 에서 Node 로 옮겨 온 것이다. 그래야 어느 운영체제에서나 같고,
 * 압축을 풀자마자 **아이콘 하나 더블클릭**으로 끝난다 (PowerShell 실행 정책에 걸리지 않는다).
 */

const line = () => console.log('─'.repeat(58));

async function main() {
  // ① 이미 돌고 있나 — 아이콘을 두 번 누른 경우를 조용히 흡수한다
  const already = LOCK.read();
  if (already) {
    const where = already.publicUrl || `http://localhost:${already.port}`;
    console.log('포담이 이미 돌고 있습니다. 그 창을 다시 엽니다.');
    console.log(`  ${where}`);
    OPEN.openUrl(where);
    return process.exit(0);
  }

  fs.mkdirSync(PATHS.dataDir(), { recursive: true });
  fs.mkdirSync(PATHS.logDir(), { recursive: true });

  line();
  console.log('  포담 — 머더미스터리 진행 도구');
  line();
  console.log(`데이터: ${PATHS.dataDir()}`);
  console.log(`모듈  : ${PATHS.modulesDir()}`);
  console.log('');

  // ② 서버 띄우기. 포트는 **0** 으로 줘서 비어 있는 자리를 운영체제가 고르게 한다
  //    — 3000 을 누가 쓰고 있어도 부딪히지 않는다.
  const out = fs.createWriteStream(path.join(PATHS.logDir(), 'server.log'), { flags: 'a' });
  const server = fork(path.join(PATHS.APP_DIR, 'src', 'server.js'), [], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  server.stdout.pipe(process.stdout);
  server.stdout.pipe(out);
  server.stderr.pipe(process.stderr);
  server.stderr.pipe(out);

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('서버가 올라오지 않았습니다')), 30000);
    server.on('message', (m) => {
      if (m && m.type === 'listening') { clearTimeout(timer); resolve(m.port); }
    });
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`서버가 멈췄습니다 (코드 ${code})`)); });
  });

  const local = `http://localhost:${port}`;
  LOCK.write({ port, publicUrl: null, startedAt: Date.now() });

  // ③ 바깥에서 들어올 주소
  //    집 안에서만 쓸 거라면 설정에 { "TUNNEL": false } 를 적어 끈다.
  const { url, child: tunnel } = SET.bool('TUNNEL') === false
    ? { url: null, child: null }
    : await TUNNEL.start(port, SET);
  let mineToo = true;
  if (url) {
    // 서버에게도 알려 준다 — 플레이어 링크를 이 주소로 만들어야 하기 때문이다.
    server.send({ type: 'public-url', url });
    LOCK.write({ port, publicUrl: url, startedAt: Date.now() });

    // 주소를 받았다고 바로 열리지는 않는다. 이름이 인터넷에 퍼질 때까지 기다렸다가 창을 열어야
    // 「연결할 수 없습니다」 화면을 보고 고장으로 오해하는 일이 없다.
    const ready = await TUNNEL.waitUntilLive(url);
    mineToo = ready.mineToo;
    if (!ready.live) {
      console.log('  주소는 받았는데 아직 퍼지지 않았습니다. 잠시 뒤에 다시 열어 보세요.');
    }
  }

  const where = url || local;
  line();
  console.log(url ? '  플레이어도 들어올 수 있는 주소' : '  이 컴퓨터에서만 열리는 주소');
  console.log(`  ${where}`);
  if (OPEN.copy(where)) console.log('  (클립보드에 넣어 두었습니다)');
  if (!url) {
    console.log('');
    console.log('  ※ 이 주소로 방을 만들면 플레이어 링크가 열리지 않습니다.');
    console.log('     밖에서 들어오게 하려면 cloudflared 가 필요합니다.');
  } else if (!mineToo) {
    console.log('');
    console.log('  ※ 터널은 살아 있지만 **이 PC 에서만** 안 열립니다 — 통신사 DNS 가 아직');
    console.log('     새 주소를 모르는 경우입니다. **다른 사람은 잘 들어옵니다.**');
    console.log('     내 PC 에서도 보려면 DNS 를 1.1.1.1 로 바꾸면 됩니다.');
  }
  line();

  // 방 만들기 암호를 안 걸어 둔 채로 주소를 열어 두면, 주소를 아는 누구나 방을 만들 수 있다.
  if (url && !SET.str('CREATE_PASSWORD', '')) {
    console.log('⚠ 지금은 주소를 아는 사람이면 누구나 방을 만들 수 있습니다.');
    console.log(`  오래 열어 둘 거라면 ${path.join(PATHS.dataDir(), 'settings.json')} 에`);
    console.log('  { "CREATE_PASSWORD": "원하는암호" } 를 적어 두세요.');
    line();
  }

  console.log('창을 닫거나 Ctrl+C 를 누르면 끝납니다.');
  OPEN.openUrl(where);

  // ④ 뒤처리 — 어떻게 끝나든 자식들을 데리고 나간다
  let done = false;
  const finish = (why) => {
    if (done) return;
    done = true;
    if (why) console.log(`\n${why}`);
    OPEN.killTree(tunnel);
    OPEN.killTree(server);
    LOCK.clear();
    process.exit(0);
  };
  server.on('exit', () => finish('서버가 멈췄습니다.'));
  if (tunnel) tunnel.on('exit', () => { if (!done) console.log('터널이 끊어졌습니다 — 서버는 그대로 돕니다.'); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => finish('끝냅니다.'));
  process.on('exit', () => { OPEN.killTree(tunnel); OPEN.killTree(server); LOCK.clear(); });
}

main().catch((e) => {
  console.error(`\n켜지 못했습니다 — ${e.message}`);
  console.error(`자세한 내용: ${path.join(PATHS.logDir(), 'server.log')}`);
  LOCK.clear();
  process.exit(1);
});

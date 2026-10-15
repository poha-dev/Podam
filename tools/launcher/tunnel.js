'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const PATHS = require('../../src/paths');

/**
 * 바깥에서 들어올 수 있는 주소를 띄운다.
 *
 * 집 안에서만 쓰는 서버를 플레이어에게 열어 주려면 길이 하나 필요하다. 공유기를 건드리는 대신
 * **Cloudflare 의 임시 터널**을 쓴다 — 포트를 여는 것이 아니라 밖으로 나가는 연결 하나를 만들고,
 * `https://….trycloudflare.com` 주소를 받아 온다. 창을 닫으면 그 주소도 사라진다.
 *
 * 주소를 알아내는 방법: 예전에는 로그를 글자로 뒤졌는데, cloudflared 가 내주는
 * **`--metrics` 창구**에 물어보는 편이 훨씬 튼튼하다 (서버의 `/api/public-url` 도 같은 것을 본다).
 */

const EXE = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

/** 내려받을 곳. 맥은 파일이 압축돼 있어 직접 설치하도록 안내한다. */
function downloadUrl() {
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
  if (process.platform === 'win32') return base + (process.arch === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe');
  if (process.platform === 'linux') return base + (process.arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64');
  return null;                                  // mac: brew install cloudflared
}

/** 이미 있는 것을 찾는다. 설정 → 받아 둔 것 → PATH 차례. */
function find(settings) {
  const told = settings && settings.str && settings.str('CLOUDFLARED_PATH', '');
  if (told && fs.existsSync(told)) return told;

  const mine = path.join(PATHS.binDir(), EXE);
  if (fs.existsSync(mine)) return mine;

  const which = process.platform === 'win32' ? 'where' : 'which';
  const out = spawnSync(which, ['cloudflared'], { windowsHide: true, encoding: 'utf8' });
  const first = String(out.stdout || '').split(/\r?\n/).find(Boolean);
  return first && fs.existsSync(first) ? first : null;
}

const ask = (question) => new Promise((resolve) => {
  if (!process.stdin.isTTY) return resolve(false);     // 물어볼 수 없는 자리면 받지 않는다
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (a) => { rl.close(); resolve(!/^n/i.test(a.trim())); });
});

/** 한 파일 내려받기 (리다이렉트를 따라간다). */
function download(url, to) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'podam' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, to).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`받지 못했습니다 (${res.statusCode})`)); }
      const file = fs.createWriteStream(to);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(to)));
      file.on('error', reject);
    }).on('error', reject);
  });
}

/** 없으면 물어보고 받아 둔다. 거절하면 null. */
async function obtain() {
  const url = downloadUrl();
  if (!url) {
    console.log('cloudflared 가 없습니다. 맥에서는 터미널에 `brew install cloudflared` 한 줄이면 됩니다.');
    return null;
  }
  console.log('');
  console.log('플레이어를 초대하려면 **cloudflared** 가 필요합니다.');
  console.log('  · Cloudflare 가 만든 프로그램입니다 (Apache-2.0, 약 25MB)');
  console.log(`  · ${PATHS.binDir()} 에 받아 두고 다음부터는 그대로 씁니다`);
  const yes = await ask('지금 받을까요? [Y/n] ');
  if (!yes) {
    console.log('받지 않았습니다 — 이 컴퓨터에서만 쓰는 주소로 계속합니다.');
    return null;
  }
  const to = path.join(PATHS.binDir(), EXE);
  fs.mkdirSync(PATHS.binDir(), { recursive: true });
  process.stdout.write('받는 중… ');
  try {
    await download(url, to);
    if (process.platform !== 'win32') fs.chmodSync(to, 0o755);
    console.log('됐습니다.');
    return to;
  } catch (e) {
    console.log(`실패했습니다 — ${e.message}`);
    return null;
  }
}

/** metrics 창구에 지금 주소를 물어본다. */
async function askUrl(metricsPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${metricsPort}/quicktunnel`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const got = await res.json();
    const host = got && (got.hostname || got.Hostname);
    return host ? `https://${String(host).replace(/^https?:\/\//, '')}` : null;
  } catch {
    return null;
  }
}

/**
 * 터널을 띄우고 주소를 돌려준다. 못 띄우면 null (그래도 서버는 돈다).
 * @param port 우리 서버가 듣고 있는 포트
 */
async function start(port, settings) {
  const exe = find(settings) || await obtain();
  if (!exe) return { url: null, child: null };

  const metrics = 20000 + Math.floor(Math.random() * 9000);
  const logFile = path.join(PATHS.logDir(), 'tunnel.log');
  fs.mkdirSync(PATHS.logDir(), { recursive: true });

  const child = spawn(exe, [
    'tunnel', '--no-autoupdate',
    '--metrics', `127.0.0.1:${metrics}`,
    '--url', `http://127.0.0.1:${port}`,
    '--logfile', logFile,
  ], { detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true });

  process.stdout.write('바깥에서 들어올 주소를 받는 중… ');
  for (let i = 0; i < 40; i++) {                 // 20초까지 기다린다
    if (child.exitCode !== null) break;
    const url = await askUrl(metrics);
    if (url) { console.log(''); return { url, child, metrics }; }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('못 받았습니다.');
  console.log(`  무엇이 잘못됐는지는 ${logFile} 에 적혀 있습니다.`);
  return { url: null, child, metrics };
}

/**
 * **주소가 정말 살아날 때까지 기다린다.**
 *
 * cloudflared 가 주소를 내줄 때와 그 이름이 인터넷에 퍼질 때 사이에 몇 초 틈이 있다.
 * 그 틈에 창을 열면 「이 페이지에 연결할 수 없습니다(NXDOMAIN)」가 떠서, 사람은 고장으로 오해한다.
 *
 * 판정은 **그 주소를 실제로 열어 보는 것**으로 한다 — 가장 믿을 만한 신호이고, 되면 끝이다.
 * 안 될 때만 DNS-over-HTTPS 로 「남들은 찾을 수 있는 이름인가」를 따로 물어본다.
 * (통신사 DNS 가 새 이름을 늦게 받는 일이 있어서, **나만 안 열리는 경우**를 가려내야 한다.
 *  보통 DNS 질의는 막히기도 하므로 HTTPS 로 물어본다.)
 *
 * @returns { live, mineToo } — 밖에서 들어올 수 있는가 / 이 PC 에서도 열리는가
 */
async function waitUntilLive(url, { seconds = 60 } = {}) {
  const host = new URL(url).hostname;

  const canOpen = async () => {
    try {
      const res = await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(4000) });
      return res.ok;
    } catch { return false; }
  };

  const othersCanFind = async () => {
    try {
      const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`,
        { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) });
      if (!res.ok) return false;
      const got = await res.json();
      return Array.isArray(got.Answer) && got.Answer.length > 0;
    } catch { return false; }
  };

  process.stdout.write('주소가 퍼질 때까지 기다립니다 (보통 몇 초) ');
  let live = false;
  for (let i = 0; i < seconds; i++) {
    if (await canOpen()) {
      console.log(' 열렸습니다.');
      return { live: true, mineToo: true };
    }
    if (!live && i % 3 === 2) live = await othersCanFind();
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(live ? ' (이 PC 에서만 아직)' : ' 안 퍼졌습니다.');
  return { live, mineToo: false };
}

module.exports = { start, find, waitUntilLive };

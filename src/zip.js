'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const zlib = require('zlib');

/**
 * 아주 작은 zip 읽기/쓰기. 압축은 하지 않고 그대로 담기만 한다(store).
 *
 * 라이브러리를 쓰지 않는 이유:
 *  - package.json 이 안 바뀌므로 NAS에서 이미지를 다시 만들 필요가 없다.
 *  - 압축을 안 하므로 '압축 폭탄'(작은 파일이 풀리면 수십 GB)이 원천적으로 불가능하다.
 *  - 양쪽 모두 스트리밍이라 큰 파일을 통째로 메모리에 올리지 않는다.
 *
 * ZIP64는 다루지 않는다 — 룸 셋팅 전체가 4GB를 넘으면 안 된다(호출하는 쪽에서 막는다).
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const STORE = 0;                     // 압축 방식: 저장만

/** zip의 날짜 형식(MS-DOS)으로 바꾼다. 초는 2초 단위까지만 담긴다. */
function dosTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/** 파일을 읽어 CRC32와 크기를 구한다 (헤더에 먼저 적어야 해서 한 번 훑는다). */
async function scan(filePath) {
  return new Promise((resolve, reject) => {
    let crc = 0, size = 0;
    fs.createReadStream(filePath)
      .on('data', (chunk) => { crc = zlib.crc32(chunk, crc); size += chunk.length; })
      .on('end', () => resolve({ crc, size }))
      .on('error', reject);
  });
}

function localHeader(name, crc, size, when) {
  const nameBuf = Buffer.from(name, 'utf8');
  const b = Buffer.alloc(30 + nameBuf.length);
  const { time, date } = dosTime(when);
  b.writeUInt32LE(LOCAL_SIG, 0);
  b.writeUInt16LE(20, 4);            // 풀려면 필요한 버전
  b.writeUInt16LE(0x0800, 6);        // 파일 이름이 UTF-8 이라는 표시
  b.writeUInt16LE(STORE, 8);
  b.writeUInt16LE(time, 10);
  b.writeUInt16LE(date, 12);
  b.writeUInt32LE(crc >>> 0, 14);
  b.writeUInt32LE(size, 18);         // 압축 크기
  b.writeUInt32LE(size, 22);         // 원래 크기
  b.writeUInt16LE(nameBuf.length, 26);
  b.writeUInt16LE(0, 28);            // 덧붙임 없음
  nameBuf.copy(b, 30);
  return b;
}

function centralHeader(e) {
  const nameBuf = Buffer.from(e.name, 'utf8');
  const b = Buffer.alloc(46 + nameBuf.length);
  const { time, date } = dosTime(e.when);
  b.writeUInt32LE(CENTRAL_SIG, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(20, 6);
  b.writeUInt16LE(0x0800, 8);
  b.writeUInt16LE(STORE, 10);
  b.writeUInt16LE(time, 12);
  b.writeUInt16LE(date, 14);
  b.writeUInt32LE(e.crc >>> 0, 16);
  b.writeUInt32LE(e.size, 20);
  b.writeUInt32LE(e.size, 24);
  b.writeUInt16LE(nameBuf.length, 28);
  b.writeUInt16LE(0, 30);            // 덧붙임
  b.writeUInt16LE(0, 32);            // 설명
  b.writeUInt16LE(0, 34);            // 디스크 번호
  b.writeUInt16LE(0, 36);            // 내부 속성
  b.writeUInt32LE(0, 38);            // 외부 속성
  b.writeUInt32LE(e.offset, 42);
  nameBuf.copy(b, 46);
  return b;
}

function eocd(count, size, offset) {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(EOCD_SIG, 0);
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE(0, 6);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(size, 12);       // 중앙 디렉터리 크기
  b.writeUInt32LE(offset, 16);     // 중앙 디렉터리 시작 위치
  b.writeUInt16LE(0, 20);            // 설명 없음
  return b;
}

/**
 * 쓰기: 스트림 하나에 담아 나간다.
 *   const w = createWriter(res);
 *   await w.addBuffer('manifest.json', buf);
 *   await w.addFile('files/xxx.bin', '/data/uploads/xxx.bin');
 *   await w.finish();
 */
function createWriter(out) {
  const entries = [];
  let offset = 0;
  const when = new Date();

  const write = (buf) => new Promise((resolve, reject) => {
    out.write(buf, (err) => (err ? reject(err) : resolve()));
  });

  async function put(name, crc, size, body) {
    const head = localHeader(name, crc, size, when);
    await write(head);
    entries.push({ name, crc, size, offset, when });
    offset += head.length;
    await body();
    offset += size;
  }

  return {
    async addBuffer(name, buf) {
      await put(name, zlib.crc32(buf, 0), buf.length, () => write(buf));
    },

    async addFile(name, filePath) {
      const { crc, size } = await scan(filePath);     // 헤더에 크기·CRC를 먼저 적어야 한다
      await put(name, crc, size, () => new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .on('error', reject)
          .on('end', resolve)
          .pipe(out, { end: false });
      }));
    },

    async finish() {
      const start = offset;
      let dirSize = 0;
      for (const e of entries) {
        const buf = centralHeader(e);
        await write(buf);
        dirSize += buf.length;
      }
      await write(eocd(entries.length, dirSize, start));
      return new Promise((resolve) => out.end(resolve));
    },
  };
}

// ── 읽기 ─────────────────────────────────────────────────────────────────────

/** 파일 끝에서 중앙 디렉터리를 찾아 목록만 읽는다 (내용은 필요할 때 꺼낸다). */
async function readEntries(zipPath) {
  const fh = await fsp.open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new Error('룸 셋팅 형식이 아닙니다');

    // 설명(comment)이 붙어 있을 수 있어 끝에서 조금 넉넉히 훑는다.
    const tailLen = Math.min(size, 66 * 1024);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);

    let eocdAt = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocdAt = i; break; }
    }
    if (eocdAt < 0) throw new Error('룸 셋팅 형식이 아닙니다');

    const count = tail.readUInt16LE(eocdAt + 10);
    const dirSize = tail.readUInt32LE(eocdAt + 12);
    const dirAt = tail.readUInt32LE(eocdAt + 16);
    if (dirAt + dirSize > size) throw new Error('룸 셋팅이 손상되었습니다');

    const dir = Buffer.alloc(dirSize);
    await fh.read(dir, 0, dirSize, dirAt);

    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > dir.length || dir.readUInt32LE(p) !== CENTRAL_SIG) {
        throw new Error('룸 셋팅이 손상되었습니다');
      }
      const method = dir.readUInt16LE(p + 10);
      const crc = dir.readUInt32LE(p + 16);
      const compSize = dir.readUInt32LE(p + 20);
      const rawSize = dir.readUInt32LE(p + 24);
      const nameLen = dir.readUInt16LE(p + 28);
      const extraLen = dir.readUInt16LE(p + 30);
      const commentLen = dir.readUInt16LE(p + 32);
      const localAt = dir.readUInt32LE(p + 42);
      const name = dir.toString('utf8', p + 46, p + 46 + nameLen);
      entries.push({ name, method, crc, size: rawSize, compSize, localAt });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** 로컬 헤더를 읽어 실제 내용이 시작하는 위치를 구한다. */
async function dataStart(fh, entry) {
  const head = Buffer.alloc(30);
  await fh.read(head, 0, 30, entry.localAt);
  if (head.readUInt32LE(0) !== LOCAL_SIG) throw new Error('룸 셋팅이 손상되었습니다');
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  return entry.localAt + 30 + nameLen + extraLen;
}

/** 엔트리 하나를 메모리로 읽는다 (manifest 처럼 작은 것에만 쓴다). */
async function readEntry(zipPath, entry, maxBytes = 4 * 1024 * 1024) {
  if (entry.method !== STORE) throw new Error('압축된 룸 셋팅은 지원하지 않습니다');
  if (entry.size > maxBytes) throw new Error('룸 셋팅 안의 파일이 너무 큽니다');
  const fh = await fsp.open(zipPath, 'r');
  try {
    const from = await dataStart(fh, entry);
    const buf = Buffer.alloc(entry.size);
    await fh.read(buf, 0, entry.size, from);
    if ((zlib.crc32(buf, 0) >>> 0) !== (entry.crc >>> 0)) throw new Error('룸 셋팅이 손상되었습니다');
    return buf;
  } finally {
    await fh.close();
  }
}

/** 엔트리 하나를 파일로 꺼낸다. 내용은 흘려보내므로 크기에 상관없다. */
async function extractEntry(zipPath, entry, destPath) {
  if (entry.method !== STORE) throw new Error('압축된 룸 셋팅은 지원하지 않습니다');
  const fh = await fsp.open(zipPath, 'r');
  let from;
  try { from = await dataStart(fh, entry); } finally { await fh.close(); }

  await new Promise((resolve, reject) => {
    let crc = 0, got = 0;
    const src = entry.size === 0
      ? null
      : fs.createReadStream(zipPath, { start: from, end: from + entry.size - 1 });
    const out = fs.createWriteStream(destPath);
    if (!src) { out.end(resolve); return; }
    src.on('data', (chunk) => { crc = zlib.crc32(chunk, crc); got += chunk.length; });
    src.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => {
      if (got !== entry.size) return reject(new Error('룸 셋팅이 손상되었습니다'));
      if ((crc >>> 0) !== (entry.crc >>> 0)) return reject(new Error('룸 셋팅이 손상되었습니다'));
      resolve();
    });
    src.pipe(out);
  });
}

module.exports = { createWriter, readEntries, readEntry, extractEntry, STORE };

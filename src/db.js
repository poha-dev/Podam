'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = require('./paths').dataDir();
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(require('./paths').dbFile());
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  gm_token_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  closed        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS participants (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  nickname   TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  online     INTEGER NOT NULL DEFAULT 0,
  gm_unread  INTEGER NOT NULL DEFAULT 0
);
-- 닉네임 겹침 방지는 **아래 마이그레이션의 idx_part_nick_live** 가 맡는다.
-- 여기에 옛 전체 유니크 인덱스를 두면 안 된다 — 내보낸 사람의 이름을 새 사람이
-- 다시 쓰고 있는 방에서는 그 인덱스를 만들 수 없어 서버가 아예 뜨지 못한다.
CREATE INDEX IF NOT EXISTS idx_part_token ON participants(token_hash);

CREATE TABLE IF NOT EXISTS gms (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  nickname   TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  online     INTEGER NOT NULL DEFAULT 0,
  is_owner   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gm_nick ON gms(room_id, nickname);
CREATE INDEX IF NOT EXISTS idx_gm_token ON gms(token_hash);

-- GM끼리 주고받는 대화. 플레이어 스레드(messages)와 완전히 분리해 둔다.
-- channel: 'all'(GM 전체방) 또는 두 GM id를 정렬해 이은 1:1 키.
CREATE TABLE IF NOT EXISTS gm_messages (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL,
  from_gm_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  body       TEXT,
  file_id    TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_gmmsg ON gm_messages(room_id, channel, created_at);

-- 대화에 붙이는 표시(반응). 같은 사람이 같은 표시를 두 번 누르면 취소된다.
-- scope: 'msg'(플레이어 스레드) | 'gm'(GM끼리의 대화)
-- actor: 'gm:<gmId>' | 'p:<participantId>'  — 누가 눌렀는지
CREATE TABLE IF NOT EXISTS reactions (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL,
  message_id TEXT NOT NULL,
  actor      TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_react_one ON reactions(message_id, actor, emoji);
CREATE INDEX IF NOT EXISTS idx_react_msg ON reactions(scope, message_id);

-- 라운드 타이머. 방마다 하나. 실행 중이면 ends_at, 멈춰 있으면 remaining_ms를 쓴다.
CREATE TABLE IF NOT EXISTS timers (
  room_id      TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  label        TEXT,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  ends_at      INTEGER,
  remaining_ms INTEGER,
  running      INTEGER NOT NULL DEFAULT 0,
  sound        TEXT,
  updated_at   INTEGER NOT NULL
);

-- 비밀 제출함. 플레이어는 자기 답만, GM은 전부 본다.
CREATE TABLE IF NOT EXISTS polls (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,          -- 제목
  items       TEXT NOT NULL DEFAULT '[]',  -- 세부 질문 목록 (JSON)
  created_at  INTEGER NOT NULL,
  closed_at   INTEGER,
  revealed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_polls_room ON polls(room_id, created_at);

-- 미리 만들어 두는 질문지. 세션 중에는 골라서 보내기만 하면 된다.
CREATE TABLE IF NOT EXISTS ask_templates (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  items      TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asktpl ON ask_templates(room_id, sort_order, created_at);

CREATE TABLE IF NOT EXISTS poll_answers (
  id             TEXT PRIMARY KEY,
  poll_id        TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  body           TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answer_poll ON poll_answers(poll_id, created_at);

CREATE TABLE IF NOT EXISTS roles (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_room ON roles(room_id, sort);

CREATE TABLE IF NOT EXISTS files (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  uploader       TEXT NOT NULL,              -- 'gm' | 'player'
  participant_id TEXT,                       -- 업로더가 플레이어일 때만
  filename       TEXT NOT NULL,
  mime           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  stored         TEXT NOT NULL,              -- 디스크상의 랜덤 파일명
  is_preset      INTEGER NOT NULL DEFAULT 0, -- 자료함에 보관중(미발송)
  label          TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,              -- 이 메시지가 속한 1:1 스레드
  sender         TEXT NOT NULL,              -- 'gm' | 'player' | 'system'
  kind           TEXT NOT NULL,              -- 'text' | 'file' | 'broadcast'
  body           TEXT,
  file_id        TEXT REFERENCES files(id),
  created_at     INTEGER NOT NULL,
  read_by_player INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(room_id, participant_id, created_at);
`);

/** 이미 있는 테이블에 컬럼을 더한다 (이미 있으면 넘어간다). */
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn('participants', 'role_id', 'TEXT');   // 배정된 배역
addColumn('files', 'role_id', 'TEXT');          // 이 자료가 속한 배역 자료함
addColumn('messages', 'deleted_at', 'INTEGER'); // 소프트 삭제 (원본은 남는다)
addColumn('messages', 'deleted_by', 'TEXT');    // 'gm' | 'player'
addColumn('messages', 'batch_id', 'TEXT');      // 한 번의 다중 발송을 묶는 id

// 입장 암호. 해시가 아니라 원문으로 둔다 — 개인 계정 비밀번호가 아니라 GM이
// 만들어 플레이어에게 알려주는 방 암호이고, 세션 중 다시 확인할 일이 많다.
// GM 토큰으로 인증된 요청에만 돌려준다.
addColumn('rooms', 'pass_code', 'TEXT');

// GM 전용 입장 암호. 링크가 새어도 이게 없으면 GM으로 못 들어온다.
addColumn('rooms', 'gm_pass_code', 'TEXT');

addColumn('messages', 'from_gm_id', 'TEXT');    // 어느 GM이 보냈는지
addColumn('participants', 'sort_order', 'INTEGER');  // GM이 끌어서 정한 순서
addColumn('files', 'sort_order', 'INTEGER');

// GM이 NPC 이름으로 보낸 경우 그 이름 (플레이어에게는 이 이름만 보인다)
addColumn('messages', 'npc_name', 'TEXT');

// 질문/답변 메시지를 하나로 묶는 id
addColumn('messages', 'poll_id', 'TEXT');

// GM이 내보낸 플레이어. 기록은 남기고 화면과 입장에서만 뺀다.
addColumn('participants', 'kicked_at', 'INTEGER');

// 닉네임은 '지금 방에 있는 사람들' 사이에서만 겹치지 않으면 된다.
// 내보낸 사람의 이름까지 계속 잡아두면 같은 사람이 다시 들어올 수 없다.
db.exec('DROP INDEX IF EXISTS idx_part_nick');
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_part_nick_live
           ON participants(room_id, nickname) WHERE kicked_at IS NULL`);
} catch (e) {
  // 아주 옛 데이터에 같은 이름이 살아 있으면 인덱스를 못 만든다.
  // 그렇다고 서버가 안 뜨면 방 전체를 못 쓰게 되므로, 알리고 지나간다.
  console.warn('[DB] 닉네임 중복 인덱스를 만들지 못했습니다 —', e.message);
}

// 이름에 입히는 색 (#rrggbb). 비어 있으면 예전처럼 기본 색으로 나온다.
// GM도 플레이어도 **자기 색은 자기가** 고르고, 모두가 같은 색을 본다.
addColumn('gms', 'color', 'TEXT');
addColumn('participants', 'color', 'TEXT');

// 새 사람만 못 들어오게 잠근 상태. 이미 들어온 사람은 그대로 쓴다.
addColumn('rooms', 'join_locked', 'INTEGER NOT NULL DEFAULT 0');

// 이 방에서 켜 둔 모듈 id 목록 (JSON 배열). 모듈별 설정값은 모듈이 자기 테이블에 둔다.
addColumn('rooms', 'modules', "TEXT NOT NULL DEFAULT '[]'");

// 예전 버전에서 만든 '1인 1답' 제약을 푼다 (여러 번 답할 수 있어야 한다)
db.exec('DROP INDEX IF EXISTS idx_answer_one');
addColumn('polls', 'items', "TEXT NOT NULL DEFAULT '[]'");
addColumn('poll_answers', 'item_index', 'INTEGER NOT NULL DEFAULT 0');
db.exec('DROP TABLE IF EXISTS scheduled');      // 예약 발송은 제거되었다

// 서버 재시작 시 온라인 표시는 신뢰할 수 없으므로 초기화한다.
db.prepare('UPDATE participants SET online = 0').run();

module.exports = { db, DATA_DIR, UPLOAD_DIR, addColumn };

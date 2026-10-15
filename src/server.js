'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { db, addColumn } = require('./db');
const roomsModule = require('./rooms');
const uploadModule = require('./upload');
const sendModule = require('./send');
const exportModule = require('./export');
const socketLayer = require('./socket');
const rolesModule = require('./roles');
const gmsModule = require('./gms');
const timerModule = require('./timer');
const askModule = require('./ask');
const tunnelUrlModule = require('./tunnel-url');
const presetsModule = require('./presets');
const bundleModule = require('./bundle');
const MODULES = require('./modules');
const modulesRouter = require('./modules/router');

// PORT=0은 '빈 포트 아무거나'라는 유효한 값이므로 || 로 떨어뜨리면 안 된다.
const PORT = process.env.PORT === undefined || process.env.PORT === '' ? 3000 : Number(process.env.PORT);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');

// Cloudflare 터널이나 리버스 프록시 뒤에 두면 모든 요청이 프록시의 IP로 보인다.
// 그대로 두면 입장 암호 제한이 '모든 플레이어를 한 사람'으로 취급해,
// 누구 하나가 8번 틀리면 전원이 1분간 막힌다.
// TRUST_PROXY=1 을 주면 X-Forwarded-For에 실린 원래 IP를 쓴다.
if (process.env.TRUST_PROXY) app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));

app.use('/api', roomsModule.router);
app.use('/api', rolesModule.router);
app.use('/api', gmsModule.router);
app.use('/api', timerModule.router);
app.use('/api', askModule.router);
app.use('/api', tunnelUrlModule.router);
app.use('/api', presetsModule.router);
app.use('/api', modulesRouter.router);
app.use('/api', bundleModule.router);

// 모듈 테이블을 만들고, 모듈이 가진 라우터와 화면 파일을 붙인다.
// 화면 파일은 모듈 폴더 안의 public/ 에서 온다 — 주소 모양은 /modules/<이름> 그대로라
// 화면 쪽 코드(shared.js)는 모듈이 어디서 왔는지 알 필요가 없다.
MODULES.initSchema(db, addColumn);
for (const mod of MODULES.list()) {
  if (mod.router) app.use('/api', mod.router);
  const dir = MODULES.publicDir(mod.id);
  if (dir) app.use('/modules', express.static(dir));
}
app.use('/api', sendModule.router);
app.use('/api', exportModule.router);
app.use('/', uploadModule.router);

// 플레이어용 짧은 링크: /r/ABC123
app.get('/r/:code', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'room.html')));

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.expose || status < 500 ? err.message : '서버 오류' });
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
socketLayer.register(io);

server.listen(PORT, () => {
  const port = server.address().port;
  console.log(`포담 — http://localhost:${port}`);
  // 런처가 자식으로 띄운 경우에만 알린다. 그생 실행(npm start · 도커)에서는 아무 일도 안 일어난다.
  if (process.send) process.send({ type: 'listening', port });
});

// 보관 기간이 한참 지난 방은 자동으로 지운다.
require('./cleanup').start();

// 기록과 자료를 밖에서 열어볼 수 있는 곳으로 복사해 둔다 (BACKUP_DIR 이 있을 때만).
require('./backup').start();

module.exports = { app, server, io };

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });

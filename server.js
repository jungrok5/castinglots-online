'use strict';

/*
 * 아주 심플한 온라인 제비뽑기 — 성경의 제비뽑기 (Casting Lots)
 *
 *   "제비는 사람이 뽑으나 모든 일을 작정하기는 여호와께 있느니라" (잠언 16:33)
 *
 * - 데이터베이스 없음: 모든 방 상태는 서버 메모리(rooms 객체)에 저장됩니다.
 *   서버를 재시작하면 진행 중이던 방은 사라집니다(잠깐 즐기는 용도).
 * - 의존성 없음: Node 내장 http 모듈만 사용. `node server.js` 로 바로 실행됩니다.
 * - 실시간 갱신은 WebSocket 대신 클라이언트 폴링으로 처리합니다.
 *
 * 게임 흐름: 방장이 제비 수와 각 제비에 숨길 결과(자유 입력)를 정해 방을 만든다 →
 *   링크를 공유 → 참가자들이 제비를 직접 고른다 → 방장이 시작하면 결과가 무작위
 *   순열로 제비에 배정되고, 제비를 던져/뽑아 공개하는 순간 결과가 드러난다.
 *
 * 사다리타기(ladder-online)와의 차이: 사다리 생성·경로추적 대신 결과 배정은
 *   그냥 무작위 순열(Fisher–Yates, buildMapping)이다. 나머지 골격은 동일하다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ROOMS = 5000;     // 메모리 보호: 동시 보관 방 수 상한
const MIN_LOTS = 2;
const MAX_LOTS = 12;        // 가독성 상한 (모바일에서도 잘 보이는 범위)
const HARD_CAP_LOTS = 50;   // 어떤 경우에도 넘지 않는 안전 한계
const MAX_RESULT_LEN = 24;  // 각 결과 텍스트 길이 제한
const MAX_NAME_LEN = 20;

/** @type {Record<string, Room>} 메모리 저장소 */
const rooms = Object.create(null);

// ---------------------------------------------------------------------------
// 게임 로직
// ---------------------------------------------------------------------------

const DRAW_MODES = ['pick', 'random'];

function randomId(len) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // 헷갈리는 0,O,1,l 제외
  let out = '';
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)]; // 예측 불가(암호학적)
  return out;
}

// 이름 없이 참여할 때 붙여줄 랜덤 닉네임 (수식어 + 성경 인물)
const NAME_ADJ = ['지혜로운', '용감한', '온유한', '신실한', '경건한', '담대한', '겸손한', '의로운', '슬기로운', '거룩한', '인내하는', '충성된', '기뻐하는', '평강의', '은혜로운', '빛나는'];
const NAME_NOUN = ['베드로', '요한', '룻', '한나', '다윗', '에스더', '드보라', '마리아', '바울', '디모데', '나오미', '사무엘', '리브가', '브리스길라', '바나바', '아브라함'];
function randomName() {
  return `${NAME_ADJ[crypto.randomInt(NAME_ADJ.length)]} ${NAME_NOUN[crypto.randomInt(NAME_NOUN.length)]}`;
}
// 방에 아직 없는 랜덤 닉네임을 고른다(자동 부여용 → 숫자 접미사 없이 깔끔하게).
function uniqueRandomName(room) {
  for (let i = 0; i < 50; i++) {
    const n = randomName();
    if (!room.players.some((p) => p.name === n)) return n;
  }
  // 조합이 동난 극단적 경우에만 숫자 폴백
  const base = randomName();
  let n = 2, name = base;
  while (room.players.some((p) => p.name === name)) name = `${base}${n++}`;
  return name;
}

function token() {
  return randomId(16);
}

/** 입력값을 안전한 제비 수(정수, 범위 내)로 강제한다. */
function sanitizeLotCount(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return MIN_LOTS;
  return Math.max(MIN_LOTS, Math.min(MAX_LOTS, Math.min(HARD_CAP_LOTS, n)));
}

/** 결과 배열을 제비 수에 맞게 정규화한다(길이 자르기, 빈 칸 기본값 채움). */
function sanitizeResults(arr, lotCount) {
  const out = [];
  for (let i = 0; i < lotCount; i++) {
    const raw = Array.isArray(arr) ? arr[i] : undefined;
    const txt = (typeof raw === 'string' ? raw : '').trim().slice(0, MAX_RESULT_LEN);
    out.push(txt || `결과 ${i + 1}`);
  }
  return out;
}

function createRoom(body) {
  let id;
  do { id = randomId(6); } while (rooms[id]);
  const lotCount = sanitizeLotCount(body.lotCount);
  const room = {
    id,
    title: (body.title || '오늘의 제비뽑기').toString().slice(0, 40),
    lotCount,
    results: sanitizeResults(body.results, lotCount),
    resultsHidden: body.resultsHidden !== false, // 기본: 숨김 (제비뽑기의 묘미)
    drawMode: DRAW_MODES.includes(body.drawMode) ? body.drawMode : 'pick',
    hostToken: token(),
    status: 'lobby', // 'lobby' | 'revealing' | 'finished'
    createdAt: Date.now(),
    players: [], // { id, name, lot: int|null }
    mapping: null, // int[lotCount] : 제비 인덱스 -> 결과 인덱스 (순열, 시작 시 확정)
  };
  rooms[id] = room;
  return room;
}

/** 현재 점유된 제비(set). */
function takenLots(room) {
  const set = new Set();
  for (const p of room.players) if (p.lot != null) set.add(p.lot);
  return set;
}

/** 가장 작은 빈 제비를 찾는다. 없으면 -1. */
function firstFreeLot(room) {
  const taken = takenLots(room);
  for (let i = 0; i < room.lotCount; i++) if (!taken.has(i)) return i;
  return -1;
}

/**
 * 0..N-1 의 무작위 순열을 만든다 (암호학적 Fisher–Yates).
 * 제비 인덱스 s 는 최종적으로 results[mapping[s]] 를 가진다.
 * 항상 전단사(순열)이므로 모든 결과가 정확히 한 번씩 배정된다.
 * (사다리타기의 buildLadder/tracePath/computeMapping 을 이 한 함수로 대체)
 */
function buildMapping(N) {
  const m = Array.from({ length: N }, (_, i) => i);
  for (let i = N - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [m[i], m[j]] = [m[j], m[i]];
  }
  return m;
}

/** 클라이언트에 보낼 상태. 시작 전에는 mapping(과 숨긴 결과)을 노출하지 않는다. */
function publicState(room) {
  const started = room.status !== 'lobby';
  return {
    id: room.id,
    title: room.title,
    lotCount: room.lotCount,
    drawMode: room.drawMode,
    resultsHidden: room.resultsHidden,
    // 결과는 공개(resultsHidden=false)면 항상, 숨김이면 시작 후에만 노출
    results: (!room.resultsHidden || started) ? room.results : null,
    status: room.status,
    players: room.players.map((p) => ({ id: p.id, name: p.name, lot: p.lot })),
    mapping: started ? room.mapping : null,  // 시작 전 절대 노출 금지
  };
}

// ---------------------------------------------------------------------------
// HTTP 유틸
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  if (res.writableEnded || res.destroyed) return; // 끊긴 연결엔 쓰지 않음(중복/에러 방지)
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { data = ''; req.destroy(); finish({}); } // 과대 페이로드 차단 + 대기 종료
    });
    req.on('end', () => { try { finish(data ? JSON.parse(data) : {}); } catch { finish({}); } });
    req.on('error', () => finish({}));   // 끊김/오류 시에도 핸들러가 멈추지 않도록
    req.on('close', () => finish({}));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};
const GZIP_TYPES = new Set(['.html', '.css', '.js', '.svg', '.json', '.txt']);

// ---- 레이트 리미팅 (IP 기준, 인메모리·무의존성) ----
const RL_WINDOW = 60 * 1000;   // 1분 창
const RL_GENERAL = 3000;       // IP당 1분 전체 API 요청 상한(공유 IP 여유 + 폭주 차단)
const RL_CREATE = 30;          // IP당 1분 방 생성 상한
const rlGeneral = new Map();   // ip -> { count, resetAt }
const rlCreate = new Map();

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip']; // Cloudflare(=Render 엣지)가 설정 → 위조 불가
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function rateLimit(map, key, limit) {
  const now = Date.now();
  let e = map.get(key);
  if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + RL_WINDOW }; map.set(key, e); }
  e.count++;
  return e.count <= limit; // true = 허용
}
function send429(res) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '10' });
  res.end(JSON.stringify({ error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' }));
}

// ---- 정적 파일 인메모리 캐시 (디스크 읽기·gzip 1회만) ----
// 파일은 배포(프로세스 재시작) 전엔 바뀌지 않으므로 메모리에 보관해도 안전하다.
const fileCache = new Map(); // filePath -> { buf, gz, mime, immutable }

function sendCached(res, req, e) {
  if (res.writableEnded || res.destroyed) return;
  const headers = {
    'Content-Type': e.mime,
    'Cache-Control': e.immutable ? 'public, max-age=31536000, immutable' : 'no-store, must-revalidate',
  };
  const acceptsGzip = req && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (acceptsGzip && e.gz) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers); res.end(e.gz);
  } else {
    res.writeHead(200, headers); res.end(e.buf);
  }
}

function serveFile(res, filePath, req) {
  const hit = fileCache.get(filePath);
  if (hit) return sendCached(res, req, hit);
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return;
    }
    const ext = path.extname(filePath);
    // 라이브러리/에셋(/vendor, /assets)은 불변 → 장기 캐시. 그 외(HTML/CSS)는 항상 최신.
    const immutable = /[\\/](vendor|assets)[\\/]/.test(filePath);
    const e = { buf, gz: null, mime: MIME[ext] || 'application/octet-stream', immutable };
    if (GZIP_TYPES.has(ext)) {
      zlib.gzip(buf, (gzErr, gz) => {
        if (!gzErr) e.gz = gz;
        fileCache.set(filePath, e);
        sendCached(res, req, e);
      });
    } else {
      fileCache.set(filePath, e);
      sendCached(res, req, e);
    }
  });
}

// ---------------------------------------------------------------------------
// 라우팅
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  // --- API ---
  if (pathname.startsWith('/api/')) {
    try {
      const ip = clientIp(req);
      if (!rateLimit(rlGeneral, ip, RL_GENERAL)) return send429(res);
      if (pathname === '/api/rooms' && req.method === 'POST' && !rateLimit(rlCreate, ip, RL_CREATE)) return send429(res);

      // 방 생성
      if (pathname === '/api/rooms' && req.method === 'POST') {
        const body = await readBody(req);
        if (Object.keys(rooms).length >= MAX_ROOMS) {
          return sendJson(res, 503, { error: '지금 방이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
        }
        const room = createRoom(body);
        return sendJson(res, 200, { roomId: room.id, hostToken: room.hostToken });
      }

      const m = pathname.match(/^\/api\/rooms\/([a-z0-9]+)(\/[a-z]+)?$/);
      if (m) {
        const room = rooms[m[1]];
        if (!room) return sendJson(res, 404, { error: '방을 찾을 수 없어요 (만료되었을 수 있어요).' });
        const action = m[2];

        if (!action && req.method === 'GET') {
          return sendJson(res, 200, publicState(room));
        }

        if (action === '/join' && req.method === 'POST') {
          const body = await readBody(req);
          if (room.status !== 'lobby') return sendJson(res, 409, { error: '이미 시작되어 참가할 수 없어요. 관전만 가능합니다.' });
          if (room.players.length >= room.lotCount) return sendJson(res, 409, { error: '모든 제비가 찼어요.' });

          // 제비 결정 (pick: 지정/빈 제비 자동, random: 시작 시 일괄 배정 → 여기선 null)
          let lot = null;
          if (room.drawMode === 'pick') {
            const taken = takenLots(room);
            if (body.lot != null) {
              const want = Math.floor(Number(body.lot));
              if (!Number.isInteger(want) || want < 0 || want >= room.lotCount) {
                return sendJson(res, 400, { error: '잘못된 제비예요.' });
              }
              if (taken.has(want)) return sendJson(res, 409, { error: '이미 선택된 제비예요. 다른 제비를 골라주세요.' });
              lot = want;
            } else {
              lot = firstFreeLot(room);
              if (lot < 0) return sendJson(res, 409, { error: '모든 제비가 찼어요.' });
            }
          }

          let name = (body.name || '').toString().trim().slice(0, MAX_NAME_LEN);
          if (!name) {
            name = uniqueRandomName(room); // 미입력 → 겹치지 않는 랜덤 닉네임(숫자 없음)
          } else if (room.players.some((p) => p.name === name)) {
            // 직접 입력한 이름이 겹칠 때만 숫자 접미사
            let n = 2;
            while (room.players.some((p) => p.name === `${name}${n}`)) n++;
            name = `${name}${n}`;
          }
          const player = { id: token(), name, lot };
          room.players.push(player);
          return sendJson(res, 200, { playerId: player.id, name: player.name, lot: player.lot });
        }

        if (action === '/start' && req.method === 'POST') {
          const body = await readBody(req);
          if (body.hostToken !== room.hostToken) return sendJson(res, 403, { error: '방장만 시작할 수 있어요.' });
          if (room.players.length < 1) return sendJson(res, 400, { error: '최소 1명 이상이어야 시작할 수 있어요.' });

          // random 모드: 빈 제비에 랜덤 배정
          if (room.drawMode === 'random') {
            const free = [];
            const taken = takenLots(room);
            for (let i = 0; i < room.lotCount; i++) if (!taken.has(i)) free.push(i);
            // Fisher–Yates
            for (let i = free.length - 1; i > 0; i--) {
              const j = crypto.randomInt(i + 1);
              [free[i], free[j]] = [free[j], free[i]];
            }
            let k = 0;
            for (const p of room.players) if (p.lot == null) p.lot = free[k++];
          }

          room.mapping = buildMapping(room.lotCount);
          room.status = 'revealing';
          return sendJson(res, 200, publicState(room));
        }

        if (action === '/finish' && req.method === 'POST') {
          // 연출이 끝났음을 표시(누구나 호출 가능 — 단순 상태 전이). 멱등.
          if (room.status === 'revealing') room.status = 'finished';
          return sendJson(res, 200, publicState(room));
        }

        if (action === '/reset' && req.method === 'POST') {
          const body = await readBody(req);
          if (body.hostToken !== room.hostToken) return sendJson(res, 403, { error: '방장만 다시 뽑을 수 있어요.' });
          room.status = 'lobby';
          room.mapping = null;
          // 제비 선택(lot)은 유지 → 같은 멤버/제비로 다시 뽑을 수 있음.
          // random 모드는 매번 새로 배정하도록 비운다.
          if (room.drawMode === 'random') room.players.forEach((p) => { p.lot = null; });
          return sendJson(res, 200, publicState(room));
        }
      }

      return sendJson(res, 404, { error: 'Unknown API' });
    } catch (e) {
      return sendJson(res, 500, { error: '서버 오류' });
    }
  }

  // --- 정적 페이지 ---
  if (pathname === '/') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), req);
  if (pathname === '/privacy') return serveFile(res, path.join(PUBLIC_DIR, 'privacy.html'), req);
  if (/^\/r\/[a-z0-9]+$/.test(pathname)) return serveFile(res, path.join(PUBLIC_DIR, 'room.html'), req);

  // 정적 자산 (디렉터리 탈출 방지): 인코딩 해제 후 정규화하고, PUBLIC_DIR 하위인지 엄격 확인
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { decoded = pathname; }
  const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return serveFile(res, filePath, req); // 파일이 없으면 serveFile 이 404 처리
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found');
});

// 레이트리밋 기록 정리 (만료 항목 제거 + 안전밸브) — 메모리 누수 방지
setInterval(() => {
  const now = Date.now();
  for (const map of [rlGeneral, rlCreate]) {
    if (map.size > 100000) { map.clear(); continue; } // 비정상 폭증 시 안전밸브
    for (const [k, e] of map) if (now >= e.resetAt) map.delete(k);
  }
}, 60 * 1000).unref();

// 오래된 방 정리 (12시간 지난 방 제거) — 메모리 누수 방지
setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const id of Object.keys(rooms)) {
    if (rooms[id].createdAt < cutoff) delete rooms[id];
  }
}, 60 * 60 * 1000).unref();

// 테스트에서 로직을 직접 부르기 위해 export (require 시), 직접 실행 시 서버 listen
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`🪧  제비뽑기 서버 실행 중: http://localhost:${PORT}`);
  });
} else {
  module.exports = { server, buildMapping, sanitizeLotCount, sanitizeResults, MAX_LOTS, MIN_LOTS };
}

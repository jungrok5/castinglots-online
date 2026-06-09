'use strict';
/*
 * 의존성 없는 테스트 하니스 (Node 18+ 의 전역 fetch 사용).
 *   node test/test.js
 * 서버 로직(순열성 등) 단위 테스트 + 실제 HTTP 통합 테스트를 함께 수행한다.
 */

const assert = require('assert');
const mod = require('../server.js');
const { server, buildMapping, sanitizeLotCount, sanitizeResults, MAX_LOTS } = mod;

let passed = 0;
function ok(name) { passed++; console.log('  ✓', name); }
function section(t) { console.log('\n' + t); }

// ---------------------------------------------------------------------------
// 1) 단위 테스트: 결과 배정 매핑 (무작위 순열)
// ---------------------------------------------------------------------------
section('결과 배정 매핑 (전단사) 단위 테스트');
for (let N = 2; N <= 12; N++) {
  for (let trial = 0; trial < 500; trial++) {
    const mapping = buildMapping(N);
    assert.strictEqual(mapping.length, N, `매핑 길이 N=${N}`);
    // 순열인지 (0..N-1 정확히 한 번씩)
    const sorted = [...mapping].sort((a, b) => a - b);
    for (let i = 0; i < N; i++) assert.strictEqual(sorted[i], i, `N=${N} 매핑이 순열이 아님: ${mapping}`);
  }
}
ok('N=2..12, 각 500회: buildMapping 은 항상 0..N-1 의 순열');

section('입력 정규화 단위 테스트');
assert.strictEqual(sanitizeLotCount(1), 2, '최소 2');
assert.strictEqual(sanitizeLotCount(999), MAX_LOTS, '상한 클램프');
assert.strictEqual(sanitizeLotCount('5'), 5, '문자열 숫자 허용');
assert.strictEqual(sanitizeLotCount(null), 2, 'null → 최소');
assert.strictEqual(sanitizeLotCount(4.7), 4, '소수 내림');
ok('sanitizeLotCount 범위/형변환');
const rs = sanitizeResults(['a', '', 'x'.repeat(40)], 4);
assert.strictEqual(rs.length, 4, '길이를 제비 수에 맞춤');
assert.strictEqual(rs[1], '결과 2', '빈 칸 기본값');
assert.strictEqual(rs[2].length, 24, '결과 길이 제한 24');
ok('sanitizeResults 길이/기본값/슬라이스');

// ---------------------------------------------------------------------------
// 2) 통합 테스트 (실제 HTTP)
// ---------------------------------------------------------------------------
async function http(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function integration() {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  section(`통합 테스트 (포트 ${port})`);

  // 방 생성 + 검증 (결과 공개 방)
  let r = await http(base, 'POST', '/api/rooms', {
    title: '점심 제비뽑기', lotCount: 4, results: ['꽝', '당첨', '꽝', '커피'], drawMode: 'pick', resultsHidden: false,
  });
  assert.strictEqual(r.status, 200); assert.ok(r.data.roomId && r.data.hostToken);
  const room = r.data.roomId, host = r.data.hostToken;
  ok('방 생성 → roomId/hostToken 반환');

  // 시작 전: mapping 미노출, 결과는 공개(resultsHidden=false)
  r = await http(base, 'GET', `/api/rooms/${room}`);
  assert.strictEqual(r.data.status, 'lobby');
  assert.strictEqual(r.data.mapping, null, '시작 전 mapping 노출 금지');
  assert.deepStrictEqual(r.data.results, ['꽝', '당첨', '꽝', '커피'], '공개 결과는 로비에서도 보임');
  ok('시작 전 mapping 미노출 (결과는 공개 설정이라 노출)');

  // 숨김 방(기본값): 시작 전 결과 null
  let h = await http(base, 'POST', '/api/rooms', { lotCount: 3, results: ['1','2','3'] });
  let hg = await http(base, 'GET', `/api/rooms/${h.data.roomId}`);
  assert.strictEqual(hg.data.resultsHidden, true, 'resultsHidden 기본값은 true(숨김)');
  assert.strictEqual(hg.data.results, null, 'resultsHidden=true 면 시작 전 결과 null');
  ok('기본 숨김 방: 시작 전 결과 숨김');

  // join: 제비 선택
  r = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '철수', lot: 0 });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.lot, 0);
  ok('join: 0번 제비 배정');

  // 제비 충돌 → 409
  r = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '영희', lot: 0 });
  assert.strictEqual(r.status, 409, '점유된 제비 → 409');
  ok('join: 점유된 제비 거부(409)');

  // 범위 밖 → 400
  r = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '범위', lot: 99 });
  assert.strictEqual(r.status, 400, '범위 밖 제비 → 400');
  ok('join: 범위 밖 제비 거부(400)');

  // lot 미지정 → 가장 작은 빈 제비
  r = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '영희' });
  assert.strictEqual(r.data.lot, 1, '빈 제비 자동 배정(1)');
  ok('join: lot 미지정 시 최소 빈 제비 자동 배정');

  // 이름 중복 → 자동 변경
  r = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '철수', lot: 2 });
  assert.strictEqual(r.data.name, '철수2', '이름 중복 방지');
  ok('join: 이름 중복 시 접미사 부여');

  // 방장 아님 → start 거부
  r = await http(base, 'POST', `/api/rooms/${room}/start`, { hostToken: 'wrong' });
  assert.strictEqual(r.status, 403);
  ok('start: 잘못된 토큰 거부(403)');

  // start
  r = await http(base, 'POST', `/api/rooms/${room}/start`, { hostToken: host });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.status, 'revealing');
  assert.ok(Array.isArray(r.data.mapping), '시작 후 mapping 노출');
  const sorted = [...r.data.mapping].sort((a, b) => a - b);
  assert.deepStrictEqual(sorted, [0, 1, 2, 3], 'mapping 은 순열');
  ok('start: mapping 노출, mapping 순열 확인');

  // 시작 후 join 거부
  r = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '지각', lot: 3 });
  assert.strictEqual(r.status, 409);
  ok('start 후 join 거부(409, 관전)');

  // finish (멱등)
  r = await http(base, 'POST', `/api/rooms/${room}/finish`, {});
  assert.strictEqual(r.data.status, 'finished');
  ok('finish: revealing → finished');

  // reset (방장)
  r = await http(base, 'POST', `/api/rooms/${room}/reset`, { hostToken: host });
  assert.strictEqual(r.data.status, 'lobby');
  assert.strictEqual(r.data.mapping, null, 'reset 후 mapping 초기화');
  // pick 모드: 제비 유지
  assert.ok(r.data.players.every((p) => p.lot != null), 'pick 모드 reset 시 제비 유지');
  ok('reset: lobby 복귀, mapping 초기화, pick 제비 유지');

  // 최소 인원 미달 start
  let r2 = await http(base, 'POST', '/api/rooms', { lotCount: 4, results: ['a','b','c','d'] });
  await http(base, 'POST', `/api/rooms/${r2.data.roomId}/join`, { name: 'solo', lot: 0 });
  r = await http(base, 'POST', `/api/rooms/${r2.data.roomId}/start`, { hostToken: r2.data.hostToken });
  assert.strictEqual(r.status, 400, '2명 미만 start 거부');
  ok('start: 2명 미만 거부(400)');

  // random 모드: 시작 시 제비 일괄 배정 + reset 시 제비 비움
  let rr = await http(base, 'POST', '/api/rooms', { lotCount: 5, results: ['a','b','c','d','e'], drawMode: 'random' });
  for (const nm of ['a','b','c']) await http(base, 'POST', `/api/rooms/${rr.data.roomId}/join`, { name: nm });
  let rg = await http(base, 'GET', `/api/rooms/${rr.data.roomId}`);
  assert.ok(rg.data.players.every((p) => p.lot == null), 'random: 로비에선 lot null');
  r = await http(base, 'POST', `/api/rooms/${rr.data.roomId}/start`, { hostToken: rr.data.hostToken });
  const lots = r.data.players.map((p) => p.lot);
  assert.ok(lots.every((l) => l != null), 'random: 시작 후 모두 배정');
  assert.strictEqual(new Set(lots).size, lots.length, 'random: 제비 중복 없음');
  // reset → lot 비워짐
  r = await http(base, 'POST', `/api/rooms/${rr.data.roomId}/reset`, { hostToken: rr.data.hostToken });
  assert.ok(r.data.players.every((p) => p.lot == null), 'random reset 시 제비 비움');
  ok('random 모드: 시작 시 빈 제비 랜덤 배정(중복 없음), reset 시 비움');

  // 이름 없이 참여 → 랜덤 닉네임 부여
  let anon = await http(base, 'POST', '/api/rooms', { lotCount: 4, results: ['a','b','c','d'] });
  let a1 = await http(base, 'POST', `/api/rooms/${anon.data.roomId}/join`, { lot: 0 });
  let a2 = await http(base, 'POST', `/api/rooms/${anon.data.roomId}/join`, { name: '   ', lot: 1 });
  assert.ok(a1.data.name && a1.data.name.trim().length > 0, '이름 없이 join 시 랜덤 이름');
  assert.ok(!/^참가자/.test(a1.data.name), '기본값(참가자N)이 아닌 랜덤 이름');
  assert.ok(a2.data.name && a2.data.name.trim().length > 0, '공백 이름도 랜덤 이름으로 대체');
  assert.ok(!/\d$/.test(a1.data.name) && !/\d$/.test(a2.data.name), '자동 닉네임엔 숫자 접미사가 붙지 않음');
  assert.notStrictEqual(a1.data.name, a2.data.name, '자동 닉네임은 서로 겹치지 않음');
  ok('join: 이름 없이 참여 시 겹치지 않는 랜덤 닉네임(숫자 없음)');

  // 디렉터리 트래버설 가드
  r = await fetch(base + '/../server.js').then((x) => x.status).catch(() => 'err');
  assert.notStrictEqual(r, 200, '트래버설로 server.js 노출 금지');
  const enc = await fetch(base + '/%2e%2e/server.js').then((x) => x.status).catch(() => 'err');
  assert.notStrictEqual(enc, 200, '인코딩 트래버설 차단');
  ok('정적 트래버설 가드 (../server.js 비노출)');

  // 없는 방
  r = await http(base, 'GET', '/api/rooms/zzzzzz');
  assert.strictEqual(r.status, 404);
  ok('없는 방 → 404');

  await new Promise((r) => server.close(r));
}

integration().then(() => {
  console.log(`\n✅ 모든 테스트 통과 (${passed}개)\n`);
  process.exit(0);
}).catch((e) => {
  console.error('\n❌ 테스트 실패:', e && e.message);
  console.error(e);
  process.exit(1);
});

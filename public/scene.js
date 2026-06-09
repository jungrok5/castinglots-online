// 3D 무대 (Three.js + Kenney Mini Characters) — 성경의 제비뽑기 버전
// room.html 의 클래식 스크립트에서 window.L3D 로 호출한다. WebGL/로딩 실패 시
// ready=false 로 남아 room.html 이 자동으로 2D 연출로 폴백한다.
//
// 연출: 제비(돌)들을 작은 토기 받침 위에 한 줄로 늘어놓고, 각 참가자 캐릭터가
// 자기 제비 뒤에 선다. 시작하면 제비를 하나씩 "던져"(공중에 띄워 회전) 결과를
// 공개한다. 내 제비는 맨 마지막에 공개(쫄깃). 사다리 하강 대신 제비 던지기.
import * as THREE from 'three';
import { GLTFLoader } from '/vendor/jsm/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject } from '/vendor/jsm/renderers/CSS2DRenderer.js';
import { clone as cloneSkinned } from '/vendor/jsm/utils/SkeletonUtils.js';

// ---- 튜닝 상수 ----
const MODELS = [
  'character-female-a', 'character-male-a', 'character-female-b', 'character-male-b',
  'character-female-c', 'character-male-c', 'character-female-d', 'character-male-d',
  'character-female-e', 'character-male-e', 'character-female-f', 'character-male-f',
];
const TARGET_H = 1.2;       // 캐릭터 목표 키(월드 단위)
const LOT_DX = 1.7;         // 제비(돌) 간격
const STONE_Z = 0.7;        // 제비 줄의 z (카메라에 가까운 쪽)
const CHAR_Z = -0.7;        // 캐릭터가 서는 z (제비 뒤)
const PEDESTAL_H = 0.22;    // 토기 받침 높이
const PEDESTAL_R = 0.5;
const STONE_R = 0.34;       // 제비(돌) 반경
const STONE_BASE_Y = PEDESTAL_H + STONE_R;  // 제비가 받침 위에 놓이는 높이
const TOSS_DUR = 850;       // 제비 던지기 1회 시간(ms)
const TOSS_H = 1.5;         // 던졌을 때 최고 높이
const UP = new THREE.Vector3(0, 1, 0);

let renderer, labelRenderer, scene, camera, clock, ground;
let ready = false, running = false, revealMode = false;
const loader = new GLTFLoader();
const modelCache = new Map();  // idx -> Promise<{scene, animations, scale, yOffset}>
const chars = new Map();       // playerId -> char object
let banners = [];
let tweens = [];               // 활성 애니메이션 (now => done?)

let currentN = 0;
let trackGroup = null;         // 받침 + 제비 + 결과 라벨을 담는 그룹
let trackSig = '';             // 트랙 재생성 판단용 서명
let lotStones = [];            // 제비별 { stone, label, baseY }
let zStartG = -1.5, zEndG = 1.4;

const camPos = new THREE.Vector3(0, 8, 10);
const camLook = new THREE.Vector3(0, 0, 0);
const curLook = new THREE.Vector3(0, 0, 0);

const xOf = (c) => (c - (currentN - 1) / 2) * LOT_DX;

function hashIdx(id) {
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % MODELS.length;
}

function loadModel(idx) {
  if (modelCache.has(idx)) return modelCache.get(idx);
  const p = new Promise((resolve, reject) => {
    loader.load(`/assets/characters/${MODELS[idx]}.glb`, (gltf) => {
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const h = Math.max(0.001, box.max.y - box.min.y);
      const scale = TARGET_H / h;
      gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
      resolve({ scene: gltf.scene, animations: gltf.animations, scale, yOffset: -box.min.y * scale });
    }, undefined, reject);
  });
  modelCache.set(idx, p);
  return p;
}

export function init(container) {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.left = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(labelRenderer.domElement);

    scene = new THREE.Scene();
    // 따뜻한 어스톤 배경/안개 (양피지·사막 느낌)
    scene.background = new THREE.Color(0x2a2016);
    scene.fog = new THREE.Fog(0x2a2016, 26, 100);

    camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);
    camera.position.copy(camPos);
    camera.lookAt(curLook);

    const hemi = new THREE.HemisphereLight(0xfff1d0, 0x3a2a18, 1.15);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffe6b0, 1.5); // 금빛 햇살
    dir.position.set(5, 11, 7);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 1; dir.shadow.camera.far = 70;
    dir.shadow.camera.left = -20; dir.shadow.camera.right = 20;
    dir.shadow.camera.top = 20; dir.shadow.camera.bottom = -20;
    scene.add(dir);

    ground = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 1, metalness: 0 }) // 모래/황토 바닥
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    clock = new THREE.Clock();
    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) loop(); });
    running = true;
    ready = true;
    loop();
    return true;
  } catch (e) {
    console.warn('[L3D] init 실패 → 2D 폴백', e);
    ready = false;
    return false;
  }
}

function resize() {
  if (!renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  fitCamera();
}

// 제비 줄 전체(폭·깊이·던지는 높이)가 화면에 들어오도록 카메라 거리를 이분탐색으로 맞춤
function fitCamera() {
  if (!camera || !currentN) { camPos.set(0, 8, 10); camLook.set(0, 0, 0); return; }
  const halfX = (currentN * LOT_DX) / 2 + 1.0;
  const yTop = TARGET_H + TOSS_H + 0.4;
  const corners = [];
  for (const sx of [-halfX, halfX])
    for (const sz of [zStartG, zEndG])
      for (const sy of [0, yTop]) corners.push(new THREE.Vector3(sx, sy, sz));
  const look = new THREE.Vector3(0, 0.5, (zStartG + zEndG) / 2);
  const viewDir = new THREE.Vector3(0, 0.6, 0.8).normalize(); // look → 카메라 방향(위+앞)

  const probe = camera.clone();
  const fits = (dist) => {
    probe.position.copy(look).addScaledVector(viewDir, dist);
    probe.up.copy(UP);
    probe.lookAt(look);
    probe.updateMatrixWorld(true);
    probe.updateProjectionMatrix();
    for (const c of corners) {
      const v = c.clone().project(probe);
      if (Math.abs(v.x) > 0.97 || Math.abs(v.y) > 0.97 || v.z > 1) return false;
    }
    return true;
  };
  let lo = 4, hi = 80;
  for (let i = 0; i < 26; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
  const dist = hi * 1.03;
  camPos.copy(look).addScaledVector(viewDir, dist);
  camLook.copy(look);
}

function loop() {
  if (!running || !ready) return;
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();
  camera.position.lerp(camPos, Math.min(1, dt * 2.5));
  curLook.lerp(camLook, Math.min(1, dt * 2.5));
  camera.lookAt(curLook);

  // 활성 애니메이션(제비 던지기 등) 진행
  if (tweens.length) tweens = tweens.filter((t) => !t(now));

  for (const c of chars.values()) {
    if (c.mixer) c.mixer.update(dt);
    if (!c.lockAnim) {
      const d = c.group.position.distanceTo(c.target);
      c.group.position.lerp(c.target, Math.min(1, dt * 6));
      play(c, d > 0.06 ? 'walk' : 'idle');
    }
  }
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

function makeLabel(cls, text, y) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text || '';
  const obj = new CSS2DObject(el);
  obj.position.set(0, y, 0);
  obj.center.set(0.5, 1);
  return { el, obj };
}

function play(c, name, opts) {
  const action = c.actions[name] || c.actions['idle'] || c.actions['static'];
  if (!action || c.current === action) return;
  const o = opts || {};
  action.reset();
  if (o.once) { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
  else action.setLoop(THREE.LoopRepeat, Infinity);
  action.fadeIn(0.2).play();
  if (c.current) c.current.fadeOut(0.2);
  c.current = action;
}

// ---- 제비(돌) 트랙: 받침 + 돌 + 결과 라벨 ----
// 살짝 찌그러진 저폴리 돌 지오메트리 (외부 에셋 없이 Three.js 기본 도형)
function makeStoneGeo() {
  const geo = new THREE.IcosahedronGeometry(STONE_R, 1);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const j = 0.82 + 0.36 * Math.abs(Math.sin(v.x * 7.1 + v.y * 5.3 + v.z * 9.7));
    v.multiplyScalar(j);
    v.y *= 0.8; // 살짝 납작하게
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

// 시작 전/관전 시 라벨에 보일 텍스트 (finished 면 실제 결과, 아니면 비밀)
function lotText(state, lot) {
  if (state.status === 'finished' && state.mapping && state.results) {
    return state.results[state.mapping[lot]];
  }
  return '?';
}

function buildTrack(state) {
  const N = state.lotCount;
  zStartG = CHAR_Z - 0.8;
  zEndG = STONE_Z + 0.8;

  if (trackGroup) { scene.remove(trackGroup); disposeGroup(trackGroup); }
  lotStones.forEach((l) => l.label && l.label.obj.parent && l.label.obj.parent.remove(l.label.obj));
  lotStones = [];
  trackGroup = new THREE.Group();

  const pedGeo = new THREE.CylinderGeometry(PEDESTAL_R * 0.78, PEDESTAL_R, PEDESTAL_H, 20);
  const pedMat = new THREE.MeshStandardMaterial({ color: 0x6b4f33, roughness: 1 }); // 토기/점토
  const stoneGeo = makeStoneGeo();

  for (let c = 0; c < N; c++) {
    const x = xOf(c);

    // 토기 받침
    const ped = new THREE.Mesh(pedGeo, pedMat);
    ped.position.set(x, PEDESTAL_H / 2, STONE_Z);
    ped.castShadow = true; ped.receiveShadow = true;
    trackGroup.add(ped);

    // 제비(돌) — 칸마다 색을 살짝 달리해 구분
    const hue = 0.07 + (c % 5) * 0.012;
    const stoneMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(hue, 0.28, 0.42 + (c % 2) * 0.05),
      roughness: 0.95, metalness: 0.02, flatShading: true,
    });
    const stone = new THREE.Mesh(stoneGeo, stoneMat);
    stone.position.set(x, STONE_BASE_Y, STONE_Z);
    stone.rotation.set(c * 0.7, c * 1.3, c * 0.4);
    stone.castShadow = true;
    trackGroup.add(stone);

    // 결과 라벨 (제비 위) — 던지기 전엔 '?'
    const lab = makeLabel('result', lotText(state, c), STONE_BASE_Y + 0.5);
    lab.obj.position.set(x, STONE_BASE_Y + 0.5, STONE_Z);
    if (state.status === 'finished') lab.el.classList.add('hit');
    trackGroup.add(lab.obj);

    lotStones.push({ stone, label: lab, baseY: STONE_BASE_Y });
  }

  scene.add(trackGroup);
}

function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); }
  });
}

async function spawn(player, pos) {
  const idx = hashIdx(player.id);
  const m = await loadModel(idx);
  if (chars.has(player.id)) return;
  const group = new THREE.Group();
  const model = cloneSkinned(m.scene);
  model.scale.setScalar(m.scale);
  model.position.y = m.yOffset;
  group.add(model);
  group.position.copy(pos);

  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const clip of m.animations) actions[clip.name] = mixer.clipAction(clip);

  const nick = makeLabel('nick', player.name, TARGET_H + 0.35);
  group.add(nick.obj);

  const c = { group, model, mixer, actions, current: null, nick, target: pos.clone(), lockAnim: false };
  chars.set(player.id, c);
  scene.add(group);
  play(c, 'idle');
}

// 캐릭터는 자기 제비 뒤에 선다 (제비를 못 고른 경우 중앙 대기).
function charPos(lot) {
  return new THREE.Vector3(lot != null ? xOf(lot) : 0, 0, CHAR_Z);
}

export function sync(state, meId) {
  if (!ready) return;
  try {
    const players = state.players || [];
    currentN = state.lotCount || players.length || 1;

    // 트랙 재생성 판단 (제비 수 / 상태 / 결과 / 매핑 변화) — 연출 중에는 보류
    const sig = JSON.stringify([currentN, state.status, state.results, state.mapping]);
    if (sig !== trackSig && !revealMode) { trackSig = sig; buildTrack(state); fitCamera(); }

    const seen = new Set();
    players.forEach((p) => {
      seen.add(p.id);
      const c = chars.get(p.id);
      const home = charPos(p.lot);
      if (!c) { spawn(p, home); return; }
      c.nick.el.textContent = p.name;
      c.nick.el.classList.toggle('me', p.id === meId);
      if (revealMode) return; // 연출 중에는 위치/애니 건드리지 않음
      c.target = home;
      c.lockAnim = false;
      if (state.status === 'finished') {
        c.group.position.copy(home);
        c.group.rotation.y = 0;
        c.lockAnim = true;
        play(c, c.actions['emote-yes'] ? 'emote-yes' : 'idle', { once: !!c.actions['emote-yes'] });
        c.nick.el.classList.add('win');
      } else {
        c.group.rotation.y = 0;
        c.nick.el.classList.remove('win');
      }
    });
    for (const [id, c] of chars) {
      if (!seen.has(id)) { scene.remove(c.group); chars.delete(id); }
    }
  } catch (e) { console.warn('[L3D] sync 오류', e); }
}

function banner(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  document.body.appendChild(el);
  banners.push(el);
  return el;
}

export function endReveal() {
  revealMode = false;
  tweens = [];
  banners.forEach((b) => b.remove());
  banners = [];
  document.querySelectorAll('.flashbang').forEach((e) => e.remove());
  // 라벨은 finished 상태에서 다시 그려질 때 정리되므로 여기선 유지
}

// 제비 하나를 공중에 던져(회전) 결과를 공개하는 애니메이션.
function tossLot(state, lot, onComplete) {
  const ls = lotStones[lot];
  if (!ls) { onComplete && onComplete(); return; }
  const t0 = performance.now();
  const spinX = (2 + Math.random() * 2) * Math.PI;
  const spinY = (2 + Math.random() * 2) * Math.PI;
  const r0 = { x: ls.stone.rotation.x, y: ls.stone.rotation.y };
  tweens.push((now) => {
    const t = Math.min(1, (now - t0) / TOSS_DUR);
    const up = Math.sin(Math.PI * t);          // 0 → 1 → 0 (포물선)
    ls.stone.position.y = ls.baseY + TOSS_H * up;
    ls.stone.rotation.x = r0.x + spinX * t;
    ls.stone.rotation.y = r0.y + spinY * t;
    if (t >= 1) {
      ls.stone.position.y = ls.baseY;
      // 결과 공개
      const res = (state.results && state.mapping) ? state.results[state.mapping[lot]] : '?';
      if (ls.label) { ls.label.el.textContent = res; ls.label.el.classList.add('hit'); }
      if (navigator.vibrate) navigator.vibrate(30);
      onComplete && onComplete();
      return true;
    }
    return false;
  });
}

// 제비뽑기 연출. state 에는 mapping/results 가 모두 들어있어야 한다.
export function reveal(state, meId, onDone) {
  if (!ready) { onDone && onDone(); return; }
  let finished = false;
  const finish = () => { if (finished) return; finished = true; onDone && onDone(); };
  try {
    revealMode = true;
    const occupied = (state.players || []).filter((p) => p.lot != null).sort((a, b) => a.lot - b.lot);
    if (!occupied.length || !state.mapping) { endReveal(); finish(); return; }
    // 내 제비를 맨 마지막에 (쫄깃)
    const order = occupied.filter((p) => p.id !== meId).concat(occupied.filter((p) => p.id === meId));

    const drum = banner('r3d-drum', '🙏 제비를 던지나이다…');
    let remaining = order.length;

    const onAllDone = () => {
      drum.remove();
      banner('r3d-verdict', '제비뽑기 완료! 📜');
      const flash = document.createElement('div'); flash.className = 'flashbang';
      document.body.appendChild(flash); setTimeout(() => flash.remove(), 500);
      setTimeout(() => { endReveal(); finish(); }, 2200);
    };

    let idx = 0;
    const step = () => {
      if (idx >= order.length) return;
      const p = order[idx++];
      tossLot(state, p.lot, () => {
        // 도착: 캐릭터 만세 + 닉네임 강조
        const c = chars.get(p.id);
        if (c) {
          c.lockAnim = true;
          c.group.rotation.y = 0;
          play(c, c.actions['emote-yes'] ? 'emote-yes' : (c.actions['jump'] ? 'jump' : 'idle'), { once: true });
          c.nick.el.classList.add('win');
        }
        if (--remaining === 0) onAllDone();
      });
      if (idx < order.length) setTimeout(step, 760);
    };
    setTimeout(step, 600);
  } catch (e) {
    console.warn('[L3D] reveal 오류 → 종료', e);
    endReveal(); finish();
  }
}

export const isReady = () => ready;
export const charCount = () => chars.size; // 디버그/테스트용

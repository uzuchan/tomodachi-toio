/* ともだちtoio — 手で動かすあなたのキューブに、AIの"友"キューブが心を開いていく。
   全日本AIハッカソン テーマ「友」

   あなた側キューブ: 手で動かす（モーターは使わない、位置だけ読む）
   とも側キューブ  : 感情エンジンで自律走行（なつき度で行動が変わる）

   実機なしでも遊べる: シミュレーションモード（あなた=マウス、とも=仮想キューブ）
*/

// ─── マット (A3 簡易プレイマット) ─────────────────────────────────────────
const MAT = { xMin: 98, yMin: 142, xMax: 402, yMax: 358 };
const MAT_PAD = 18;                    // ともが端に寄りすぎないためのマージン
const CUBE_U = 23.5;                   // キューブ一辺 ≈ 23.5 座標単位 (32mm)

// ─── 画面 ────────────────────────────────────────────────────────────────
const VIEW_W = 940, VIEW_H = 680;
let stage;                              // {sx, sy, scale} マット→画面変換

// ─── 役者 ────────────────────────────────────────────────────────────────
// human: { mode:'none'|'ble'|'mouse', cube, x,y,angle, valid, speed, hist:[] }
// friend:{ mode:'none'|'ble'|'sim',  cube, sim, x,y,angle, valid, held }
const human  = { mode: 'none', cube: null, x: 180, y: 250, angle: 90, valid: false, speed: 0, hist: [] };
const friend = { mode: 'none', cube: null, sim: null, x: 320, y: 250, angle: 270, valid: false, held: false };

// ─── 感情エンジン ─────────────────────────────────────────────────────────
const emo = {
  affection: 22,          // なつき度 0..100
  mood: 'sleep',          // sleep/wary/friendly/bestie/love/lonely/sulk/heldHappy/heldScared/surprised
  moodUntil: 0,           // 一時ムードの期限 (millis)
  nearSince: 0, farSince: 0, lastPet: -99999, lastSound: 0,
  stillSince: 0,          // 人間キューブが静止し始めた時刻
  orbitPhase: 0,          // しんゆうダンスの旋回位相
  bubble: '', bubbleUntil: 0,
  lastTier: 'wary',       // 昇格演出の検出用
};

const TIERS = [
  { min: 0,  name: 'wary',     label: 'ためらい',   col: [255, 170, 40],  standoff: 145, maxSpd: 26 },
  { min: 32, name: 'friendly', label: 'なかよし',   col: [52, 199, 123],  standoff: 88,  maxSpd: 42 },
  { min: 70, name: 'bestie',   label: 'しんゆう',   col: [255, 111, 165], standoff: 58,  maxSpd: 55 },
];

const BUBBLES = {
  wary:      ['…だれ？', 'ちょっと きになる…', 'こわくない…？'],
  friendly:  ['あそぼ！', 'まって〜', 'いっしょにいこ！'],
  bestie:    ['だいすき！', 'ずっといっしょ！', 'えへへ'],
  love:      ['えへへ♡', 'もっとなでて！'],
  lonely:    ['ねえ、こっちむいて…', 'さみしいよ…'],
  sulk:      ['…ぷん。', 'しーらないっ'],
  heldHappy: ['たかーい！', 'とんでる〜！'],
  heldScared:['わわわっ！', 'おろして〜！'],
  surprised: ['わっ！'],
};

// ─── パーティクル ─────────────────────────────────────────────────────────
let hearts = [];   // {x,y,vy,life,size,char}
let trailH = [], trailF = [];

// ─── BLE 送信ガード ───────────────────────────────────────────────────────
let motorBusy = false, lastLED = '';
let choreo = null;  // {seq:[{l,r,ms}], i, until} スクリプト動作（スピン等）

// ══════════════════════════════════════════════════════════════════════════
// p5 セットアップ
// ══════════════════════════════════════════════════════════════════════════
function setup() {
  const c = createCanvas(VIEW_W, VIEW_H);
  c.parent(document.getElementById('stage-wrap'));
  textFont('"Hiragino Maru Gothic ProN", sans-serif');

  const mw = MAT.xMax - MAT.xMin, mh = MAT.yMax - MAT.yMin;
  const scale = Math.min((VIEW_W - 80) / mw, (VIEW_H - 150) / mh);
  stage = { scale, sx: (VIEW_W - mw * scale) / 2, sy: 96 };

  document.getElementById('btn-you').onclick    = () => connectCube('you');
  document.getElementById('btn-friend').onclick = () => connectCube('friend');
  document.getElementById('btn-sim').onclick    = startSim;
  document.getElementById('btn-reset').onclick  = resetGame;

  setInterval(brainTick, 150);   // 感情＆制御ループ（描画と独立）

  if (new URLSearchParams(location.search).get('sim')) startSim();
}

function m2s(x, y) { return [stage.sx + (x - MAT.xMin) * stage.scale, stage.sy + (y - MAT.yMin) * stage.scale]; }

function resetGame() {
  emo.affection = 22; emo.mood = 'sleep'; emo.moodUntil = 0; emo.lastTier = 'wary';
  emo.bubble = ''; hearts = []; trailH = []; trailF = []; choreo = null;
  if (friend.mode !== 'none') wake();
  if (friend.mode === 'sim') { friend.sim.x = 320; friend.sim.y = 250; friend.sim.a = 270; }
}

// ══════════════════════════════════════════════════════════════════════════
// 接続まわり
// ══════════════════════════════════════════════════════════════════════════
async function connectCube(role) {
  try {
    const cube = await toioManager.addCube();
    if (role === 'you') {
      human.mode = 'ble'; human.cube = cube;
      document.getElementById('btn-you').classList.add('connected');
      document.getElementById('btn-you').textContent = `① ${cube.name} ✓（手で動かしてね）`;
      cube.setLED(255, 255, 255, 0).catch(() => {});
    } else {
      friend.mode = 'ble'; friend.cube = cube;
      document.getElementById('btn-friend').classList.add('connected');
      document.getElementById('btn-friend').textContent = `② ${cube.name} ✓`;
      cube.on('button', p => { if (p) petEvent('button'); });
      cube.on('motion', m => {
        friend.held = !m.horizontal;
        if (m.doubleTap) petEvent('tap');
        if (m.collision && human.speed > 55) surprise();
      });
      cube.on('matMissed', () => { friend.held = true; });
      cube.playSoundEffect(0).catch(() => {});
      wake();
    }
  } catch (e) { console.warn('connect cancelled', e); }
}

function startSim() {
  if (human.mode === 'none')  { human.mode = 'mouse'; }
  if (friend.mode === 'none') {
    friend.mode = 'sim';
    friend.sim = { x: 320, y: 250, a: 270, l: 0, r: 0 };
    document.getElementById('btn-sim').textContent = 'シミュレーション中（あなた＝マウス）';
    wake();
  }
}

function wake() { if (emo.mood === 'sleep') { setMood('wary', 0); say('wary'); } }

// ══════════════════════════════════════════════════════════════════════════
// 感情エンジン（150ms ごと）
// ══════════════════════════════════════════════════════════════════════════
function brainTick() {
  const now = millis();
  syncBodies();
  if (emo.mood === 'sleep') return;

  const dt = 0.15;
  const d = dist(human.x, human.y, friend.x, friend.y);
  const humanOn = human.valid;

  // ── 持ち上げ ──
  if (friend.held) {
    const m = emo.affection >= 55 ? 'heldHappy' : 'heldScared';
    if (emo.mood !== m) { setMood(m, 0); say(m); sfx(m === 'heldHappy' ? 6 : 7); }
    drive(0, 0);
    ledForMood(now); updateBubbleLife(now);
    return;
  } else if (emo.mood === 'heldHappy' || emo.mood === 'heldScared') {
    setMood(tierOf().name, 0);
  }

  // ── なでなで判定（人間キューブを近くで小刻みにゆらす）──
  if (humanOn && d < 95 && human.speed > 65 && now - emo.lastPet > 2500) petEvent('wiggle');

  // ── なつき度の増減 ──
  if (humanOn && d < 115) {
    if (!emo.nearSince) emo.nearSince = now;
    emo.farSince = 0;
    emo.affection = Math.min(100, emo.affection + 1.4 * dt);
  } else if (humanOn && d > 185) {
    if (!emo.farSince) emo.farSince = now;
    emo.nearSince = 0;
    if (now - emo.farSince > 9000) emo.affection = Math.max(0, emo.affection - 1.2 * dt);
  } else { emo.nearSince = 0; emo.farSince = 0; }

  // ── 一時ムードの期限切れ → 基本ムードへ ──
  if (emo.moodUntil && now > emo.moodUntil) { emo.moodUntil = 0; setMood(tierOf().name, 0); }

  // ── 昇格のお祝い（ためらい→なかよし→しんゆう）──
  const tierNow = tierOf().name;
  if (tierNow !== emo.lastTier) {
    const rank = { wary: 0, friendly: 1, bestie: 2 };
    if (rank[tierNow] > rank[emo.lastTier] && !['sulk', 'lonely'].includes(emo.mood)) {
      setMood(tierNow, 0); say(tierNow); spawnHearts(tierNow === 'bestie' ? 14 : 7);
      happyNotes(); sfx(6);
      choreo = { seq: [{ l: 55, r: -55, ms: 900 }, { l: -55, r: 55, ms: 900 }], i: 0, until: 0 }; // うれしさスピン
    }
    emo.lastTier = tierNow;
  }

  // ── 放置 → さみしい → すねる ──
  if (!['love', 'surprised', 'sulk', 'lonely'].includes(emo.mood)) {
    if (emo.farSince && now - emo.farSince > 10000) {
      if (emo.affection >= 35) { setMood('lonely', 0); say('lonely'); sadNote(); }
      else                     { setMood('sulk', 0);   say('sulk');   sadNote(); }
    }
    if (emo.mood === tierNameStale()) setMood(tierOf().name, 0); // 昇格/降格を反映
  }
  if (emo.mood === 'lonely' && emo.farSince && now - emo.farSince > 24000) { setMood('sulk', 0); say('sulk'); }
  if ((emo.mood === 'lonely' || emo.mood === 'sulk') && humanOn && d < 90) {
    emo.farSince = 0; petlikeForgive();
  }

  // ── 人間キューブの静止検出（しんゆうダンスのトリガ）──
  if (human.speed < 8) { if (!emo.stillSince) emo.stillSince = now; }
  else emo.stillSince = 0;

  // ── 行動（モーター）──
  act(now, d, humanOn);

  // ── LED・吹き出し ──
  ledForMood(now);
  updateBubbleLife(now);
}

function tierOf() { return TIERS.filter(t => emo.affection >= t.min).pop(); }
function tierNameStale() {
  return ['wary', 'friendly', 'bestie'].includes(emo.mood) && emo.mood !== tierOf().name ? emo.mood : '__no__';
}

function setMood(m, until) { emo.mood = m; emo.moodUntil = until; }
function say(key) {
  const arr = BUBBLES[key]; if (!arr) return;
  emo.bubble = arr[Math.floor(Math.random() * arr.length)];
  emo.bubbleUntil = millis() + 2600;
}
function updateBubbleLife(now) { if (now > emo.bubbleUntil) emo.bubble = ''; }

function petEvent(kind) {
  const now = millis();
  emo.lastPet = now;
  emo.affection = Math.min(100, emo.affection + (kind === 'button' || kind === 'tap' ? 9 : 6));
  setMood('love', now + 2200); say('love');
  spawnHearts(6);
  happyNotes();
  choreo = { seq: [{ l: 45, r: -45, ms: 320 }, { l: -45, r: 45, ms: 320 }, { l: 45, r: -45, ms: 220 }], i: 0, until: 0 };
}
function petlikeForgive() {
  emo.affection = Math.min(100, emo.affection + 4);
  setMood(tierOf().name, 0); say(tierOf().name); spawnHearts(3); sfx(5);
}
function surprise() { setMood('surprised', millis() + 1200); say('surprised'); sfx(2); }

// ══════════════════════════════════════════════════════════════════════════
// 行動 → モーター
// ══════════════════════════════════════════════════════════════════════════
function act(now, d, humanOn) {
  // スクリプト動作を消化（なでなでの「ぷるぷる」等）
  if (choreo) {
    if (!choreo.until) choreo.until = now + choreo.seq[choreo.i].ms;
    const step = choreo.seq[choreo.i];
    drive(step.l, step.r);
    if (now > choreo.until) {
      choreo.i++;
      if (choreo.i >= choreo.seq.length) choreo = null;
      else choreo.until = now + choreo.seq[choreo.i].ms;
    }
    return;
  }

  if (!humanOn) { wander(now); return; }
  const tier = tierOf();

  switch (emo.mood) {
    case 'sulk': {
      // 顔をそむけて距離を取る
      if (d < 165) driveToward(awayPoint(), 30, now);
      else facePoint(2 * friend.x - human.x, 2 * friend.y - human.y); // 背を向ける
      break;
    }
    case 'lonely': {
      driveToward(standoffPoint(120), 22, now);  // そーっと近づく
      break;
    }
    case 'surprised': drive(0, 0); break;
    case 'love': break; // choreo で処理済み・終わったら fallthrough しない
    default: {
      // しんゆう＋人間静止 → まわりをくるくるダンス
      if (tier.name === 'bestie' && emo.stillSince && now - emo.stillSince > 3500 && d < 150) {
        emo.orbitPhase += 0.055;
        const R = 62;
        const tx = human.x + R * Math.cos(emo.orbitPhase);
        const ty = human.y + R * Math.sin(emo.orbitPhase);
        driveToward({ x: tx, y: ty }, 50, now, true);
        if (now - emo.lastSound > 5000) { happyNotes(); emo.lastSound = now; }
        break;
      }
      // ためらい: ちょっと進んでは止まる
      if (tier.name === 'wary') {
        const phase = Math.floor(now / 1300) % 2 === 0;
        if (d > tier.standoff && phase) driveToward(standoffPoint(tier.standoff), tier.maxSpd, now);
        else { drive(0, 0); facePoint(human.x, human.y); }
        break;
      }
      // なかよし/しんゆう: スタンドオフ距離で追従
      if (d > tier.standoff + 12) driveToward(standoffPoint(tier.standoff), tier.maxSpd, now);
      else if (d < tier.standoff - 25) driveToward(standoffPoint(tier.standoff), 25, now); // 近すぎたら下がる寄り
      else { drive(0, 0); facePoint(human.x, human.y); }
    }
  }
}

function standoffPoint(standoff) {
  // 人間から見て「とも」側に standoff 離れた点（体当たりしない）
  const dx = friend.x - human.x, dy = friend.y - human.y;
  const L = Math.hypot(dx, dy) || 1;
  return clampMat({ x: human.x + dx / L * standoff, y: human.y + dy / L * standoff });
}
function awayPoint() {
  const dx = friend.x - human.x, dy = friend.y - human.y;
  const L = Math.hypot(dx, dy) || 1;
  return clampMat({ x: friend.x + dx / L * 80, y: friend.y + dy / L * 80 });
}
function clampMat(p) {
  return { x: constrain(p.x, MAT.xMin + MAT_PAD, MAT.xMax - MAT_PAD),
           y: constrain(p.y, MAT.yMin + MAT_PAD, MAT.yMax - MAT_PAD) };
}

let wanderTarget = null, wanderUntil = 0;
function wander(now) {
  if (!wanderTarget || now > wanderUntil) {
    wanderTarget = { x: random(MAT.xMin + 40, MAT.xMax - 40), y: random(MAT.yMin + 40, MAT.yMax - 40) };
    wanderUntil = now + 4000;
  }
  driveToward(wanderTarget, 20, now);
}

// P制御の差動駆動: とも → target
function driveToward(target, maxSpd, now, keepMoving = false) {
  const t = clampMat(target);
  const dx = t.x - friend.x, dy = t.y - friend.y;
  const distTo = Math.hypot(dx, dy);
  if (distTo < (keepMoving ? 6 : 12)) { drive(0, 0); return; }
  const targetHead = Math.atan2(dy, dx);                       // 0 = +X, y下向き正
  const head = (friend.angle - 90) * Math.PI / 180;            // lib角(0=北) → math角
  let err = targetHead - head;
  while (err > Math.PI)  err -= 2 * Math.PI;
  while (err < -Math.PI) err += 2 * Math.PI;
  const fwd  = Math.abs(err) > 1.2 ? 8 : Math.min(maxSpd, 10 + distTo * 0.55);
  const turn = constrain(err * 34, -40, 40);
  drive(fwd + turn, fwd - turn);
}
function facePoint(px, py) {
  const targetHead = Math.atan2(py - friend.y, px - friend.x);
  const head = (friend.angle - 90) * Math.PI / 180;
  let err = targetHead - head;
  while (err > Math.PI)  err -= 2 * Math.PI;
  while (err < -Math.PI) err += 2 * Math.PI;
  if (Math.abs(err) < 0.25) { drive(0, 0); return; }
  const turn = constrain(err * 30, -28, 28);
  drive(turn, -turn);
}

function drive(l, r) {
  if (friend.mode === 'sim') { friend.sim.l = l; friend.sim.r = r; return; }
  if (friend.mode !== 'ble' || motorBusy) return;
  motorBusy = true;
  friend.cube.move(l, r, 0).catch(() => {}).finally(() => { motorBusy = false; });
}

// ══════════════════════════════════════════════════════════════════════════
// LED・音
// ══════════════════════════════════════════════════════════════════════════
function moodColor(now) {
  switch (emo.mood) {
    case 'love':       return [255, 60, 130];
    case 'lonely':     return [80, 120, 255];
    case 'sulk':       return [60, 60, 200];
    case 'surprised':  return [255, 255, 0];
    case 'heldHappy':  { const h = (now / 8) % 360; return hsb2rgb(h, 90, 100); }
    case 'heldScared': return [0, 80, 255];
    case 'sleep':      { const b = 40 + 30 * Math.sin(now / 600); return [b, b, b]; }
    default: {
      const c = tierOf().col;
      if (tierOf().name === 'bestie') { // ハートビート
        const p = (now % 1100) / 1100, b = p < .12 || (p > .2 && p < .32) ? 1 : .45;
        return [c[0] * b, c[1] * b, c[2] * b];
      }
      return c;
    }
  }
}
function ledForMood(now) {
  if (friend.mode !== 'ble') return;
  const [r, g, b] = moodColor(now).map(v => Math.round(v));
  const key = `${r >> 4},${g >> 4},${b >> 4}`;      // 量子化して書き込み頻度を抑える
  if (key === lastLED) return;
  lastLED = key;
  friend.cube.setLED(r, g, b, 0).catch(() => {});
}
function sfx(id) { if (friend.mode === 'ble') friend.cube.playSoundEffect(id).catch(() => {}); beep(id === 7 ? 220 : 660, 120); }
async function happyNotes() {
  beep(784, 90); setTimeout(() => beep(988, 90), 110); setTimeout(() => beep(1319, 140), 220);
  if (friend.mode !== 'ble') return;
  try { await friend.cube.playSound(79, 90); await friend.cube.playSound(83, 90); await friend.cube.playSound(88, 150); } catch (e) {}
}
async function sadNote() {
  beep(494, 200); setTimeout(() => beep(392, 300), 230);
  if (friend.mode !== 'ble') return;
  try { await friend.cube.playSound(71, 200); await friend.cube.playSound(67, 320); } catch (e) {}
}

// シム用の小さなビープ（WebAudio）
let _actx = null;
function beep(freq, ms) {
  if (friend.mode === 'ble') return;   // 実機ならキューブが鳴る
  try {
    _actx = _actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = _actx.createOscillator(), g = _actx.createGain();
    o.frequency.value = freq; o.type = 'sine';
    g.gain.value = 0.06; o.connect(g); g.connect(_actx.destination);
    o.start(); o.stop(_actx.currentTime + ms / 1000);
  } catch (e) {}
}

function hsb2rgb(h, s, v) {
  push(); colorMode(HSB, 360, 100, 100);
  const col = color(h, s, v);
  const out = [red(col), green(col), blue(col)]; pop();
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// 位置の同期（実機 / シム / マウス）
// ══════════════════════════════════════════════════════════════════════════
function syncBodies() {
  const now = millis();

  // あなた
  if (human.mode === 'ble' && human.cube) {
    const p = human.cube.position;
    human.x = p.x; human.y = p.y; human.angle = p.angle;
    human.valid = human.cube.onMat !== false;
  } else if (human.mode === 'mouse') {
    const mx = (mouseX - stage.sx) / stage.scale + MAT.xMin;
    const my = (mouseY - stage.sy) / stage.scale + MAT.yMin;
    const inside = mx > MAT.xMin - 10 && mx < MAT.xMax + 10 && my > MAT.yMin - 10 && my < MAT.yMax + 10;
    if (inside) {
      const dx = mx - human.x, dy = my - human.y;
      if (Math.hypot(dx, dy) > 2) human.angle = ((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360;
      human.x = mx; human.y = my;
    }
    human.valid = inside;
  }

  // 速度（なでなで検出用: 直近 ~0.8s の平均速度）
  human.hist.push({ t: now, x: human.x, y: human.y });
  while (human.hist.length && now - human.hist[0].t > 800) human.hist.shift();
  if (human.hist.length > 1) {
    let sum = 0;
    for (let i = 1; i < human.hist.length; i++) {
      sum += Math.hypot(human.hist[i].x - human.hist[i - 1].x, human.hist[i].y - human.hist[i - 1].y);
    }
    human.speed = sum / ((now - human.hist[0].t) / 1000 || 1);
  }

  // とも
  if (friend.mode === 'ble' && friend.cube) {
    const p = friend.cube.position;
    friend.x = p.x; friend.y = p.y; friend.angle = p.angle;
    friend.valid = friend.cube.onMat !== false;
  }

  // 軌跡
  pushTrail(trailH, human.x, human.y, human.valid);
  pushTrail(trailF, friend.x, friend.y, friend.mode !== 'none');
}
function pushTrail(arr, x, y, ok) {
  if (!ok) return;
  const last = arr[arr.length - 1];
  if (!last || Math.hypot(x - last.x, y - last.y) > 2) {
    arr.push({ x, y });
    if (arr.length > 400) arr.shift();
  }
}

// シムの物理（draw から毎フレーム）
function stepSim(dtMs) {
  if (friend.mode !== 'sim') return;
  const s = friend.sim, dt = Math.min(0.05, dtMs / 1000);
  const SPEED = 1.55;                        // 速度値 → 座標単位/s の係数（実機の体感に合わせる）
  const v = (s.l + s.r) / 2 * SPEED;
  const w = (s.l - s.r) / CUBE_U * SPEED;    // rad/s
  const head = (s.a - 90) * Math.PI / 180;
  s.x += v * Math.cos(head) * dt;
  s.y += v * Math.sin(head) * dt;
  s.x = constrain(s.x, MAT.xMin + 5, MAT.xMax - 5);
  s.y = constrain(s.y, MAT.yMin + 5, MAT.yMax - 5);
  s.a = ((s.a + w * dt * 180 / Math.PI) % 360 + 360) % 360;
  friend.x = s.x; friend.y = s.y; friend.angle = s.a; friend.valid = true;
}

// ══════════════════════════════════════════════════════════════════════════
// 描画
// ══════════════════════════════════════════════════════════════════════════
function draw() {
  stepSim(deltaTime);
  background('#FDF6EC');
  drawMat();
  drawTrails();
  if (human.mode !== 'none') drawCube(human.x, human.y, human.angle, '#59C1E8', 'あなた', false);
  if (friend.mode !== 'none') drawFriend();
  drawHearts();
  drawHUD();
  if (emo.mood === 'sleep') drawTitle();
}

function drawMat() {
  const [x0, y0] = m2s(MAT.xMin, MAT.yMin);
  const w = (MAT.xMax - MAT.xMin) * stage.scale, h = (MAT.yMax - MAT.yMin) * stage.scale;
  noStroke(); fill(255); rect(x0 - 8, y0 - 8, w + 16, h + 16, 18);
  fill('#FBF0DC'); rect(x0, y0, w, h, 10);
  stroke('#EFDFC2'); strokeWeight(1);
  for (let gx = MAT.xMin; gx <= MAT.xMax; gx += 43.4) { const [sx] = m2s(gx, 0); line(sx, y0, sx, y0 + h); }
  for (let gy = MAT.yMin; gy <= MAT.yMax; gy += 43.2) { const [, sy] = m2s(0, gy); line(x0, sy, x0 + w, sy); }
}

function drawTrails() {
  noFill();
  stroke(89, 193, 232, 70); strokeWeight(2); beginShape();
  trailH.forEach(p => { const [sx, sy] = m2s(p.x, p.y); vertex(sx, sy); }); endShape();
  stroke(255, 111, 165, 70); beginShape();
  trailF.forEach(p => { const [sx, sy] = m2s(p.x, p.y); vertex(sx, sy); }); endShape();
}

function drawCube(x, y, angle, col, label, isFriend) {
  const [sx, sy] = m2s(x, y);
  const s = CUBE_U * stage.scale;
  push();
  translate(sx, sy); rotate(radians(angle));
  noStroke(); fill(0, 24); rect(-s / 2 + 3, -s / 2 + 4, s, s, 6);   // 影
  fill(col); rect(-s / 2, -s / 2, s, s, 6);
  fill(255, 230); triangle(0, -s / 2 + 3, -6, -s / 2 + 12, 6, -s / 2 + 12); // 前方向
  pop();
  noStroke(); fill('#4A3F35'); textAlign(CENTER); textSize(12);
  text(label, sx, sy + s / 2 + 16);
}

function drawFriend() {
  const now = millis();
  const [r, g, b] = moodColor(now);
  drawCube(friend.x, friend.y, friend.angle, color(r, g, b), 'とも', true);

  const [sx, sy] = m2s(friend.x, friend.y);
  const s = CUBE_U * stage.scale;

  // 顔（マット上向き＝画面上の向きに固定して描く）
  const blink = (now % 3400) < 140;
  push(); translate(sx, sy);
  fill(60); noStroke();
  if (blink) { rect(-8, -4, 6, 2, 1); rect(3, -4, 6, 2, 1); }
  else { ellipse(-5, -3, 5.5, emo.mood === 'sulk' ? 3 : 6.5); ellipse(6, -3, 5.5, emo.mood === 'sulk' ? 3 : 6.5); }
  noFill(); stroke(60); strokeWeight(2);
  if (['love', 'bestie', 'heldHappy', 'friendly'].includes(emo.mood)) arc(0.5, 4, 10, 8, 0.15 * PI, 0.85 * PI);
  else if (['sulk', 'lonely', 'heldScared'].includes(emo.mood))       arc(0.5, 9, 10, 7, 1.15 * PI, 1.85 * PI);
  else { line(-3, 6, 4, 6); }
  pop();

  // 吹き出し
  if (emo.bubble) {
    textSize(14); const tw = textWidth(emo.bubble) + 22;
    const bx = sx + s * 0.8, by = sy - s * 1.15;
    fill(255); stroke('#E8D9C0'); strokeWeight(1.5);
    rect(bx, by - 16, tw, 30, 14);
    triangle(bx + 8, by + 12, bx + 20, by + 12, bx + 4, by + 24);
    noStroke(); fill('#4A3F35'); textAlign(LEFT, CENTER);
    text(emo.bubble, bx + 11, by - 1);
  }
}

function spawnHearts(n) {
  for (let i = 0; i < n; i++) {
    hearts.push({ x: friend.x + random(-12, 12), y: friend.y + random(-8, 8),
                  vy: random(14, 26), life: 1, size: random(10, 17),
                  char: random() < 0.85 ? '♥' : '✦' });
  }
}
function drawHearts() {
  const dt = deltaTime / 1000;
  hearts = hearts.filter(h => (h.life -= dt * 0.7) > 0);
  hearts.forEach(h => {
    h.y -= h.vy * dt;
    const [sx, sy] = m2s(h.x, h.y);
    noStroke(); fill(255, 90, 140, 255 * h.life);
    textSize(h.size); textAlign(CENTER, CENTER); text(h.char, sx, sy);
  });
}

function drawHUD() {
  // なつき度ゲージ
  const gx = 30, gy = 26, gw = VIEW_W - 320, gh = 22;
  noStroke(); fill('#4A3F35'); textSize(15); textAlign(LEFT, CENTER);
  text('ともだち度', gx, gy + gh / 2);
  const bx = gx + 92;
  fill('#EFE3CF'); rect(bx, gy, gw - 92, gh, 12);
  const t = tierOf();
  const frac = emo.affection / 100;
  const grad = lerpColor(color('#FFC53D'), color('#FF6FA5'), frac);
  fill(grad); rect(bx, gy, (gw - 92) * frac, gh, 12);
  // 段階マーカー
  [32, 70].forEach(v => { stroke(255, 180); strokeWeight(2);
    const mx = bx + (gw - 92) * v / 100; line(mx, gy + 2, mx, gy + gh - 2); });
  noStroke(); fill('#4A3F35'); textAlign(LEFT, CENTER); textSize(13);
  const stateLabel = {
    sleep: 'ねむってる…', wary: 'ためらい', friendly: 'なかよし', bestie: 'しんゆう♥',
    love: 'うっとり♡', lonely: 'さみしい…', sulk: 'すねてる…', surprised: 'びっくり！',
    heldHappy: 'そらのたび！', heldScared: 'こわいよ〜',
  }[emo.mood] || t.label;
  text(`いまのきもち: ${stateLabel}`, bx, gy + gh + 16);

  // 接続状態
  textAlign(RIGHT, CENTER); textSize(12); fill('#9A8C7E');
  const hm = { none: '未接続', ble: '実機', mouse: 'マウス' }[human.mode];
  const fm = { none: '未接続', ble: '実機', sim: 'シム' }[friend.mode];
  text(`あなた: ${hm} ／ とも: ${fm}`, VIEW_W - 26, gy + 6);
  if (human.mode === 'ble' && !human.valid) {
    fill('#D97706'); text('あなたのキューブをマットに置いてね', VIEW_W - 26, gy + 24);
  }
}

function drawTitle() {
  noStroke(); fill(74, 63, 53, 150); rect(0, 0, VIEW_W, VIEW_H);
  fill(255); textAlign(CENTER, CENTER);
  textSize(34); text('ともだちtoio', VIEW_W / 2, VIEW_H / 2 - 60);
  textSize(16); text('きみと友だちになりたい', VIEW_W / 2, VIEW_H / 2 - 22);
  textSize(14);
  text('上のボタンからキューブを2台つなぐか、「シミュレーションで遊ぶ」を押してね', VIEW_W / 2, VIEW_H / 2 + 30);
  text('そばにいると、なついてくれる。ほうっておくと…？', VIEW_W / 2, VIEW_H / 2 + 56);
}

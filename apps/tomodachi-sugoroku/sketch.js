/* ともだちすごろく — A3マットが24マスのすごろく盤になる。
   あなた(954)のコマは手で置く／ともキューブ(h4i)は自走するコマ。
   競争だけど、さきにゴールしても待っててくれる。ふたりでゴールしてこそ「友」。

   ともだちtoioの感情エンジンを搭載:
   あそぶほど「ともだち度」が育ち、ためらい→なかよし→しんゆう に昇格。
   なでなで(コマをクリック/実機ボタン/トントン)・うた・ダンス・いっしょのマスで上がり、
   おいてけぼりにすると さみしがって下がる。きもちは顔・吹き出し・実機LEDに出る。
   エンディングは最終ともだち度で変化。実機なしでも遊べる。 */

// ── 盤面 ─────────────────────────────────────────────────────
const MAT = { xMin: 98, yMin: 142, xMax: 402, yMax: 358 };
const COLS = 6, ROWS = 4, GOAL = COLS * ROWS - 1;   // 24マス, GOAL=23
const CELL_W = (MAT.xMax - MAT.xMin) / COLS;
const CELL_H = (MAT.yMax - MAT.yMin) / ROWS;

// マスの種類（固定レイアウト）
const CELL_TYPE = { 0:'start', 2:'dance', 5:'song', 8:'dance', 11:'nade',
                    14:'jump', 17:'rest', 20:'song', 23:'goal' };
const TYPE_INFO = {
  start: { icon: '🏁', label: 'スタート', col: '#EFE3CF' },
  goal:  { icon: '🏆', label: 'ゴール',   col: '#FFE9A8' },
  song:  { icon: '🎵', label: 'うた',     col: '#D9C9F5' },
  dance: { icon: '💃', label: 'ダンス',   col: '#C9E8F5' },
  nade:  { icon: '💗', label: 'なでなで', col: '#FCD7E4' },
  jump:  { icon: '🚀', label: '3ススム',  col: '#CFF0D8' },
  rest:  { icon: '💤', label: 'ひとやすみ', col: '#E4E0DA' },
  plain: { icon: '',   label: '',         col: '#FBF3E2' },
};

// すごろくパス p → マット座標（下段左から蛇行して上段左のゴールへ）
function cellPos(p) {
  const rb  = Math.floor(p / COLS);            // 下から何段目か
  const row = ROWS - 1 - rb;
  const w   = p % COLS;
  const col = rb % 2 === 0 ? w : COLS - 1 - w;
  return { x: MAT.xMin + CELL_W * (col + 0.5), y: MAT.yMin + CELL_H * (row + 0.5), col, row };
}
function typeOf(p) { return CELL_TYPE[p] || 'plain'; }

// ── 画面 ─────────────────────────────────────────────────────
const VIEW_W = 960, VIEW_H = 640;
let stage;
function m2s(x, y) { return [stage.sx + (x - MAT.xMin) * stage.scale, stage.sy + (y - MAT.yMin) * stage.scale]; }

// ── ゲーム状態 ────────────────────────────────────────────────
const players = [
  { name: 'あなた', emoji: '🐣', cube: null, pos: 0, drawPos: 0, color: '#3AA6D8', rest: false, goal: false },
  { name: 'とも',   emoji: '🤖', cube: null, pos: 0, drawPos: 0, color: '#F0598A', rest: false, goal: false },
];
let phase = 'setup';       // setup / dice / rolling / placing / petting / moving / end
let turn = 0;              // 0=あなた 1=とも
let dice = 0, diceAnim = 0, targetIdx = 0;
let message = 'キューブをつないで「▶はじめる」！（実機なしでもOK）';
let hearts = [], confetti = [];
let lastShakeAt = 0;
let petDeadline = 0;
let AUTO = false;          // ?auto=1 で全自動デモ（動作確認用）

const $ = id => document.getElementById(id);
const pick = a => a[Math.floor(Math.random() * a.length)];

// ── 感情エンジン（ともだちtoioから移植）──────────────────────────
const emo = {
  affection: 25,          // ともだち度 0..100
  mood: 'normal',         // normal / love / lonely / cheer / sleepy
  moodUntil: 0,
  bubble: '', bubbleUntil: 0,
  lastPet: -99999,
  lastTier: 'wary',       // 昇格演出の検出用
  lonelySaidAt: 0,
};
const TIERS = [
  { min: 0,  name: 'wary',     label: 'ためらい', col: [255, 170, 40] },
  { min: 32, name: 'friendly', label: 'なかよし', col: [52, 199, 123] },
  { min: 70, name: 'bestie',   label: 'しんゆう', col: [255, 111, 165] },
];
function tierOf() { return TIERS.filter(t => emo.affection >= t.min).pop(); }
function setMood(m, until) { emo.mood = m; emo.moodUntil = until; }

function addAffection(d) {
  emo.affection = Math.max(0, Math.min(100, emo.affection + d));
  const t = tierOf();
  if (t.name !== emo.lastTier) {
    const rank = { wary: 0, friendly: 1, bestie: 2 };
    if (rank[t.name] > rank[emo.lastTier]) tierUp(t);
    emo.lastTier = t.name;
  }
}
function tierUp(t) {
  const c = cellPos(players[1].drawPos);
  spawnHearts(c.x, c.y, t.name === 'bestie' ? 16 : 9);
  friendSay(t.name === 'bestie' ? 'しんゆうだ！！だいすき！' : 'なかよしになれた！うれしい！');
  if (phase !== 'end') {
    players[1].cube?.playMelody([[90, 79], [90, 83], [150, 88]]).catch(() => {});
    spinCube();
  }
}

// とものセリフ: 吹き出し + 読み上げ + ピヨピヨ語
function friendSay(text) {
  emo.bubble = text;
  emo.bubbleUntil = millis() + 2800;
  say(text);
}

// ── なでなで ─────────────────────────────────────────────────
function casualPet() {
  if (!['dice', 'placing', 'setup'].includes(phase)) return;   // とも走行中は実機が暴れるので不可
  if (millis() - emo.lastPet < 2500) return;
  emo.lastPet = millis();
  setMood('love', millis() + 2000);
  friendSay(pick(['えへへ♡', 'くすぐったいよ〜', 'なでなで、すき！']));
  const c = cellPos(players[1].drawPos);
  spawnHearts(c.x, c.y, 5);
  players[1].cube?.playSoundEffect(6).catch(() => {});
  wiggleCube();
  addAffection(4);
}
function cubePet() {         // 実機とものボタン / ダブルタップ
  if (phase === 'petting') resolvePet(true);
  else casualPet();
}
function resolvePet(ok) {    // なでなでマスの結果
  if (phase !== 'petting') return;
  phase = 'moving';
  emo.lastPet = millis();
  const c = cellPos(players[1].drawPos);
  if (ok) {
    setMood('love', millis() + 2400);
    friendSay(pick(['えへへ♡だいすき！', 'もっとなでて〜！', 'しあわせだなあ']));
    spawnHearts(c.x, c.y, 10);
    players[1].cube?.playSoundEffect(6).catch(() => {});
    wiggleCube();
    addAffection(12);
    message = '💗 なでなで だいせいこう！';
  } else {
    setMood('lonely', millis() + 3200);
    friendSay('あれ…なでてくれないの…？');
    addAffection(-4);
    message = '💧 なでてもらえなかった…';
  }
  setTimeout(nextTurn, 1800);
}

// うれしさの実機アクション（回転系なのでズレたらマスへ戻る）
async function wiggleCube() {
  const cube = players[1].cube; if (!cube) return;
  try {
    await cube.move(45, -45, 220);
    await cube.move(-45, 45, 220);
    await cube.move(45, -45, 160);
    const c = cellPos(players[1].drawPos);
    await cube.moveTo(c.x, c.y, null, 50, 'POS_ONLY');
  } catch (e) {}
}
async function spinCube() {
  const cube = players[1].cube; if (!cube) return;
  try {
    await cube.move(55, -55, 650);
    await cube.move(-55, 55, 650);
    const c = cellPos(players[1].drawPos);
    await cube.moveTo(c.x, c.y, null, 60, 'POS_ONLY');
  } catch (e) {}
}

// ── セットアップ ──────────────────────────────────────────────
function setup() {
  const c = createCanvas(VIEW_W, VIEW_H);
  c.parent($('stage-wrap'));
  textFont('"Hiragino Maru Gothic ProN", sans-serif');
  const mw = MAT.xMax - MAT.xMin, mh = MAT.yMax - MAT.yMin;
  const scale = Math.min((VIEW_W - 60) / mw, (VIEW_H - 124) / mh);
  stage = { scale, sx: (VIEW_W - mw * scale) / 2, sy: 96 };

  $('btn-you').onclick    = () => connect(0);
  $('btn-friend').onclick = () => connect(1);
  $('btn-start').onclick  = startGame;
  $('btn-dice').onclick   = () => { if (phase === 'dice') roll(); };
  $('btn-placed').onclick = () => { if (phase === 'placing') arrive(0); };

  setInterval(ledTick, 300);   // 実機LEDをきもち色に

  AUTO = !!new URLSearchParams(location.search).get('auto');
  if (AUTO) setTimeout(startGame, 600);
}

async function connect(i) {
  try {
    const id = $(i === 0 ? 'id-you' : 'id-friend').value;
    const cube = await toioManager.addCube(id);
    players[i].cube = cube;
    const btn = $(i === 0 ? 'btn-you' : 'btn-friend');
    btn.classList.add('connected'); btn.textContent = `✓ ${cube.name}`;
    cube.setLED(...hexRGB(players[i].color), 0).catch(() => {});
    cube.playSoundEffect(0).catch(() => {});
    if (i === 0) {
      cube.on('motion', m => {   // 954を振る=サイコロ／なでなで中はなでる
        if (!m.shake) return;
        if (phase === 'petting') { resolvePet(true); return; }
        if (phase === 'dice' && turn === 0 && millis() - lastShakeAt > 2000) {
          lastShakeAt = millis(); roll();
        }
      });
      cube.on('position', p => {  // 手で置いたマスの検出
        if (phase !== 'placing') return;
        const c = posToCell(p.x, p.y);
        if (c === targetIdx) arrive(0);
      });
    } else {                     // ともに触れる＝なでなで（ともだちtoioと同じ）
      cube.on('button', p => { if (p) cubePet(); });
      cube.on('motion', m => { if (m.doubleTap) cubePet(); });
    }
    cube.on('disconnect', () => { players[i].cube = null; });
  } catch (e) { console.warn(e); }
}

function posToCell(x, y) {
  for (let p = 0; p <= GOAL; p++) {
    const c = cellPos(p);
    if (Math.abs(x - c.x) < CELL_W * 0.42 && Math.abs(y - c.y) < CELL_H * 0.42) return p;
  }
  return -1;
}

function hexRGB(h) { return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]; }

// ── ゲーム進行 ────────────────────────────────────────────────
function startGame() {
  players.forEach(pl => { pl.pos = 0; pl.drawPos = 0; pl.rest = false; pl.goal = false; });
  confetti = []; hearts = [];
  emo.affection = 25; emo.mood = 'normal'; emo.moodUntil = 0;
  emo.bubble = ''; emo.bubbleUntil = 0; emo.lastPet = -99999;
  emo.lastTier = 'wary'; emo.lonelySaidAt = 0;
  turn = 0;
  friendSay('ともだちすごろく、はじめよう！あそぶほど なかよくなれるよ！');
  message = 'ゲームスタート！';
  const s = cellPos(0);
  players[1].cube?.moveTo(s.x, s.y, 0, 60).catch(() => {});
  setTimeout(yourTurn, 2200);
}

function yourTurn() {
  if (checkEnd()) return;
  turn = 0; phase = 'dice';
  $('btn-dice').disabled = false;
  message = '🎲 あなたのばん！サイコロを押す（か、954をシャカシャカ振る）';
  if (players[1].goal) {          // ゴールで待つ とも が応援してくれる
    setMood('cheer', millis() + 4000);
    friendSay(pick(['がんばれ〜！', 'まってるよ〜！', 'あとちょっと！']));
    addAffection(2);
  } else say('きみのばん！さいころふって！');
  if (AUTO) setTimeout(() => { if (phase === 'dice' && turn === 0) roll(); }, 700);
}

function friendTurn() {
  if (checkEnd()) return;
  turn = 1; phase = 'dice';
  $('btn-dice').disabled = true;
  message = '🤖 ともの ばん…';
  if (players[0].goal) {          // あなたが先にゴールして待っていてくれた
    friendSay(pick(['おうえんありがと！', 'みてて、がんばるから！']));
    addAffection(2);
  } else friendSay('ぼくのばん！えいっ！');
  setTimeout(roll, 1800);
}

function roll() {
  phase = 'rolling';
  $('btn-dice').disabled = true;
  dice = 1 + Math.floor(Math.random() * 6);
  diceAnim = millis();
  players[turn].cube?.playSoundEffect(3).catch(() => {});
  setTimeout(() => {
    const pl = players[turn];
    targetIdx = Math.min(GOAL, pl.pos + dice);
    if (turn === 0) {
      enterPlacing();
      message = `🎲 ${dice}！ 光っているマスへ954を置いて（クリックでもOK）`;
      say(`${dice}だ！${dice}マスすすんでね！`);
    } else {
      friendSay(`${dice}がでた！`);
      message = `🎲 とも は ${dice}マス すすむ！`;
      moveFriend();
    }
  }, 900);
}

function enterPlacing() {
  phase = 'placing';
  $('btn-placed').style.display = 'inline-block';
  if (AUTO) setTimeout(() => { if (phase === 'placing') arrive(0); }, 800);
}

function arrive(i) {
  if (phase !== 'placing') return;
  phase = 'moving';
  $('btn-placed').style.display = 'none';
  players[i].pos = targetIdx; players[i].drawPos = targetIdx;
  players[i].cube?.playSoundEffect(1).catch(() => {});
  onLand(i);
}

async function moveFriend() {
  phase = 'moving';
  const pl = players[1];
  const from = pl.pos;
  pl.pos = targetIdx;
  if (pl.cube) {
    for (let p = from + 1; p <= targetIdx; p++) {
      const c = cellPos(p);
      pl.drawPos = p;
      try { await pl.cube.moveTo(c.x, c.y, null, 70, 'POS_ONLY'); } catch (e) {}
    }
  } else {
    for (let p = from + 1; p <= targetIdx; p++) { pl.drawPos = p; await sleep(420); }
  }
  onLand(1);
}

async function onLand(i) {
  const pl = players[i];
  const t = typeOf(pl.pos);
  const c = cellPos(pl.pos);

  if (pl.pos >= GOAL) { await reachGoal(i); return; }

  // いっしょのマス！（とちゅうのマスでふたりが重なったら）
  if (pl.pos > 0 && players[0].pos === players[1].pos) {
    message = '💞 いっしょのマス！';
    friendSay(pick(['いっしょのマスだ！えへへ！', 'ぐうぜん！うれしいね！']));
    spawnHearts(c.x, c.y, 10);
    addAffection(8);
    await sleep(1600);
  }

  switch (t) {
    case 'song': {
      message = `🎵 うたのマス！`;
      if (i === 0) say('うたのますだ！いっしょにうたお！');
      else friendSay('うたっちゃうよ〜！');
      const beat = 60000 / 108;
      const notes = [['G4',.5],['D4',.5],['G4',.5],['B4',.5],['D5',1]]
        .map(([n, b]) => [b * beat, NOTE[n]]);
      pl.cube?.playMelody(notes).catch(() => {});
      await sleep(1800);
      spawnHearts(c.x, c.y, 4);
      addAffection(5);
      break;
    }
    case 'dance': {
      message = '💃 ダンスのマス！くるくる〜';
      if (i === 0) say('だんすたいむ！');
      else friendSay('だんすたいむ！みてて！');
      if (pl.cube) {
        pl.cube.move(50, -50, 700).then(() => pl.cube.move(-50, 50, 700)).then(() => pl.cube.stop()).catch(() => {});
      }
      await sleep(1800);
      spawnHearts(c.x, c.y, 4);
      addAffection(5);
      break;
    }
    case 'nade': {
      message = '💗 なでなでのマス！とものコマをなでて！（クリック／実機はボタンかトントン）';
      phase = 'petting';
      petDeadline = millis() + 6000;
      friendSay(i === 0 ? 'なでなでのますだ！なでて〜！' : 'なでなでして〜！');
      if (AUTO) setTimeout(() => { if (phase === 'petting') resolvePet(true); }, 900);
      return;                       // つづきは resolvePet → nextTurn
    }
    case 'jump': {
      message = '🚀 3マスすすむ！';
      say('ろけっとだ！さんますすすむ！');
      targetIdx = Math.min(GOAL, pl.pos + 3);
      if (i === 0) {
        enterPlacing();
        return;                       // もう一度置く（イベントは onLand で再判定）
      } else { await sleep(600); moveFriend(); return; }
    }
    case 'rest': {
      message = '💤 ひとやすみ… つぎの1回やすみ';
      if (i === 0) say('ひとやすみ…つぎのばん、おやすみだよ');
      else { setMood('sleepy', millis() + 5000); friendSay('ねむねむ…いっかいやすむね'); }
      pl.rest = true;
      await sleep(1800);
      break;
    }
    default: await sleep(900);
  }
  nextTurn();
}

async function reachGoal(i) {
  const pl = players[i];
  pl.goal = true; pl.pos = GOAL; pl.drawPos = GOAL;
  const other = players[1 - i];
  if (!other.goal) {
    message = `🏆 ${pl.name} がゴール！でも…まっててあげる！`;
    if (i === 1) { setMood('cheer', millis() + 4000); friendSay('ゴール！でも、きみがくるまでまってるね！'); }
    else say('ゴール！ともがくるまで、おうえんしよう！');
    pl.cube?.setLED(255, 215, 0, 0).catch(() => {});
    await sleep(2000);
    nextTurn();
  } else {
    addAffection(10);               // ふたりでゴールのごほうび
    endGame();
  }
}

function nextTurn() {
  if (checkEnd()) return;

  // おいてけぼりチェック（8マス以上はなれたら）
  const gap = players[0].pos - players[1].pos;
  const now = millis();
  if (now - emo.lonelySaidAt > 15000) {
    if (gap >= 8 && !players[1].goal) {
      emo.lonelySaidAt = now;
      setMood('lonely', now + 3500);
      friendSay(pick(['まってよぉ…', 'おいてかないで〜', 'さみしいよ…']));
      addAffection(-3);
    } else if (gap <= -8 && !players[0].goal) {
      emo.lonelySaidAt = now;
      setMood('cheer', now + 3500);
      friendSay(pick(['がんばれ〜！', 'こっちだよ〜！']));
    }
  }

  let n = 1 - turn;
  if (players[n].goal) n = turn;              // 相手がゴール済みなら自分の番が続く
  if (players[n].rest) {
    players[n].rest = false;
    say(`${players[n].name === 'とも' ? 'ぼく' : 'きみ'}、いっかいおやすみ…`);
    n = 1 - n;
    if (players[n].goal) { setTimeout(nextTurn, 1500); return; }
  }
  setTimeout(n === 0 ? yourTurn : friendTurn, 1200);
}

function checkEnd() {
  if (players[0].goal && players[1].goal && phase !== 'end') { endGame(); return true; }
  return phase === 'end';
}

async function endGame() {
  phase = 'end';
  addAffection(6);
  const t = tierOf();               // エンディングは最終ともだち度で分岐
  if (t.name === 'bestie') {
    message = '🎉 ふたりでゴール！ずっとずっと しんゆう！';
    friendSay('ふたりともゴール！ずーっとしんゆうだよ！だいすき！');
  } else if (t.name === 'friendly') {
    message = '🎉 ふたりとも ゴール！ずっとともだち！';
    friendSay('ふたりともゴール！ずっとともだちだよ！やったー！');
  } else {
    message = '🎉 ふたりとも ゴール！ともだちの はじまり！';
    friendSay('ゴールできたね！これから、もっとなかよくなろうね！');
  }
  for (let k = 0; k < 80; k++) confetti.push({
    x: random(VIEW_W), y: random(-300, 0), vy: random(60, 160),
    col: [random(120,255), random(120,255), random(120,255)], size: random(6,12), rot: random(TWO_PI),
  });
  const beat = 60000 / 132;
  const fanfare = [['G4',.5],['B4',.5],['D5',.5],['G5',1],['D5',.5],['G5',1.5]]
    .map(([n, b]) => [b * beat, NOTE[n]]);
  for (const pl of players) {
    pl.cube?.playMelody(fanfare).catch(() => {});
  }
  rainbow(players[0].cube); rainbow(players[1].cube);
}
async function rainbow(cube) {
  if (!cube) return;
  for (let t = 0; t < 14; t++) {
    const h = (t * 40) % 360;
    const [r, g, b] = hsb2rgbArr(h);
    try { await cube.setLED(r, g, b, 180); } catch (e) { return; }
  }
  cube.setLED(255, 215, 0, 0).catch(() => {});
}
function hsb2rgbArr(h) {
  push(); colorMode(HSB, 360, 100, 100);
  const c = color(h, 85, 100);
  const out = [red(c), green(c), blue(c)].map(Math.round); pop();
  return out;
}

// ── LED（きもち色・ともだちtoioから）───────────────────────────
let lastLED = '';
function moodColor(now) {
  switch (emo.mood) {
    case 'love':   return [255, 60, 130];
    case 'lonely': return [80, 120, 255];
    case 'cheer':  return [255, 200, 40];
    case 'sleepy': { const b = 90 + 40 * Math.sin(now / 500); return [b, b, 160]; }
    default: {
      const t = tierOf(), c = t.col;
      if (t.name === 'bestie') {   // ハートビート
        const p = (now % 1100) / 1100, b = p < .12 || (p > .2 && p < .32) ? 1 : .55;
        return [c[0] * b, c[1] * b, c[2] * b];
      }
      return c;
    }
  }
}
function ledTick() {
  const cube = players[1].cube;
  if (!cube || phase === 'end') return;    // エンディングはレインボー担当
  const [r, g, b] = moodColor(millis()).map(Math.round);
  const key = `${r >> 4},${g >> 4},${b >> 4}`;   // 量子化して書き込み頻度を抑える
  if (key === lastLED) return;
  lastLED = key;
  cube.setLED(r, g, b, 0).catch(() => {});
}

// ── 音名表 ───────────────────────────────────────────────────
const NOTE = (() => {
  const base = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 }, m = {};
  for (let o = 3; o <= 6; o++) for (const [k, v] of Object.entries(base)) {
    m[`${k}${o}`] = 12 * (o + 1) + v; m[`${k}#${o}`] = 12 * (o + 1) + v + 1;
  }
  return m;
})();

function say(text) { TTS.speak(text); chirpCube(); }
function chirpCube() {
  const cube = players[1].cube; if (!cube) return;
  const notes = []; for (let i = 0; i < 4; i++) notes.push([50, 96 + Math.floor(Math.random() * 9), 150]);
  cube.playMelody(notes).catch(() => {});
}
function spawnHearts(mx, my, n) {
  for (let i = 0; i < n; i++) hearts.push({ x: mx + random(-15, 15), y: my + random(-10, 10),
    vy: random(12, 24), life: 1, size: random(10, 18) });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── クリック: コマを置く／とものコマをなでなで ─────────────────
function mousePressed() {
  if (phase === 'placing') {                   // 置くほうを優先
    const mx = (mouseX - stage.sx) / stage.scale + MAT.xMin;
    const my = (mouseY - stage.sy) / stage.scale + MAT.yMin;
    const c = posToCell(mx, my);
    if (c === targetIdx) { arrive(0); return; }
    if (c >= 0 && !nearFriendPiece()) { message = 'そこじゃないよ〜！ひかってるマスだよ'; say('そこじゃないよ〜'); return; }
  }
  if (nearFriendPiece()) {                     // とものコマをクリック＝なでなで
    if (phase === 'petting') resolvePet(true);
    else casualPet();
  }
}
function nearFriendPiece() {
  const c = cellPos(players[1].drawPos);
  const [fx, fy] = m2s(c.x, c.y);
  return dist(mouseX, mouseY, fx + 12, fy) < 26;
}

// ── 描画 ─────────────────────────────────────────────────────
function draw() {
  const now = millis();
  if (emo.moodUntil && now > emo.moodUntil) { emo.mood = 'normal'; emo.moodUntil = 0; }
  if (phase === 'petting' && now > petDeadline) resolvePet(false);
  background('#FDF6EC');
  drawBoard();
  drawPieces();
  drawFX();
  drawBubble();
  drawHUD();
}

function drawBoard() {
  const [x0, y0] = m2s(MAT.xMin, MAT.yMin);
  const w = (MAT.xMax - MAT.xMin) * stage.scale, h = (MAT.yMax - MAT.yMin) * stage.scale;
  noStroke(); fill(255); rect(x0 - 8, y0 - 8, w + 16, h + 16, 16);

  for (let p = 0; p <= GOAL; p++) {
    const t = typeOf(p), info = TYPE_INFO[t];
    const c = cellPos(p);
    const [sx, sy] = m2s(c.x, c.y);
    const cw = CELL_W * stage.scale - 7, ch = CELL_H * stage.scale - 7;
    // 置き先マスをハイライト
    const isTarget = phase === 'placing' && p === targetIdx;
    fill(isTarget ? lerpColor(color('#FFE9A8'), color('#FFC53D'), (sin(millis() / 180) + 1) / 2) : color(info.col));
    stroke(isTarget ? '#E8940A' : '#EADFC8'); strokeWeight(isTarget ? 3 : 1.5);
    rect(sx - cw / 2, sy - ch / 2, cw, ch, 12);
    noStroke(); fill('#4A3F35');
    textAlign(CENTER, CENTER);
    if (info.icon) { textSize(20); text(info.icon, sx, sy - 8); textSize(10); text(info.label, sx, sy + 14); }
    textSize(9); fill('#B7A893'); text(p === 0 ? '' : p, sx + cw / 2 - 10, sy - ch / 2 + 9);
  }
  // 経路の矢印
  stroke('#E3D5BC'); strokeWeight(2);
  for (let p = 0; p < GOAL; p++) {
    const a = cellPos(p), b = cellPos(p + 1);
    const [ax, ay] = m2s(a.x, a.y), [bx, by] = m2s(b.x, b.y);
    line(lerp(ax, bx, 0.36), lerp(ay, by, 0.36), lerp(ax, bx, 0.64), lerp(ay, by, 0.64));
  }
}

function drawPieces() {
  players.forEach((pl, i) => {
    const c = cellPos(pl.drawPos);
    const [sx, sy] = m2s(c.x, c.y);
    const off = i === 0 ? -12 : 12;
    const bob = (turn === i && phase !== 'end') ? -4 - 3 * abs(sin(millis() / 250)) : 0;
    // リアルタイム実機位置（あなた・接続時のみ）を薄いリングで
    if (i === 0 && pl.cube && pl.cube.onMat) {
      const [rx, ry] = m2s(pl.cube.position.x, pl.cube.position.y);
      noFill(); stroke(pl.color + '88'); strokeWeight(3); circle(rx, ry, 30);
    }
    noStroke(); fill(0, 25); ellipse(sx + off, sy + 16, 30, 10);
    if (i === 0) {
      fill(pl.color); circle(sx + off, sy + bob, 34);
      textSize(18); textAlign(CENTER, CENTER);
      text(pl.emoji, sx + off, sy + bob - 1);
    } else {
      drawTomo(sx + off, sy + bob);
    }
  });
}

// とものコマ＝ミニキューブ（きもち色のボディ + 顔。ともだちtoioの顔を移植）
function drawTomo(x, y) {
  const now = millis(), s = 36;
  const [r, g, b] = moodColor(now);
  push(); translate(x, y);
  if (phase === 'petting') {       // なでなで待ち: ピンクのリングでさそう
    noFill(); stroke(255, 90, 140, 150 + 100 * sin(now / 150)); strokeWeight(3);
    rect(-s / 2 - 5, -s / 2 - 5, s + 10, s + 10, 12);
  }
  noStroke(); fill(r, g, b); rect(-s / 2, -s / 2, s, s, 9);
  // 顔
  const closed = (now % 3400) < 140 || emo.mood === 'sleepy';
  fill(60); noStroke();
  if (closed) { rect(-8, -6, 6, 2, 1); rect(3, -6, 6, 2, 1); }
  else { ellipse(-5, -5, 5.5, 6.5); ellipse(6, -5, 5.5, 6.5); }
  noFill(); stroke(60); strokeWeight(2);
  if (emo.mood === 'love' || emo.mood === 'cheer' || (emo.mood === 'normal' && tierOf().name !== 'wary'))
    arc(0.5, 3, 10, 8, 0.15 * PI, 0.85 * PI);
  else if (emo.mood === 'lonely') arc(0.5, 8, 10, 7, 1.15 * PI, 1.85 * PI);
  else line(-3, 5, 4, 5);
  pop();
}

// とものコマの上に吹き出し
function drawBubble() {
  if (!emo.bubble || millis() > emo.bubbleUntil) { emo.bubble = ''; return; }
  const c = cellPos(players[1].drawPos);
  const [sx, sy] = m2s(c.x, c.y);
  textSize(13);
  const tw = textWidth(emo.bubble) + 20;
  const bx = Math.min(sx + 26, VIEW_W - tw - 8);
  const by = Math.max(sy - 44, 26);
  fill(255); stroke('#E8D9C0'); strokeWeight(1.5);
  rect(bx, by - 15, tw, 28, 13);
  triangle(bx + 6, by + 9, bx + 18, by + 9, bx + 2, by + 20);
  noStroke(); fill('#4A3F35'); textAlign(LEFT, CENTER); textSize(13);
  text(emo.bubble, bx + 10, by - 1);
}

function drawFX() {
  const dt = deltaTime / 1000;
  hearts = hearts.filter(hh => (hh.life -= dt * 0.6) > 0);
  hearts.forEach(hh => {
    hh.y -= hh.vy * dt;
    const [sx, sy] = m2s(hh.x, hh.y);
    noStroke(); fill(255, 90, 140, 255 * hh.life);
    textSize(hh.size); textAlign(CENTER, CENTER); text('♥', sx, sy);
  });
  confetti.forEach(cf => {
    cf.y += cf.vy * dt; cf.rot += dt * 3;
    if (cf.y > VIEW_H + 20) { cf.y = random(-100, -10); }
    push(); translate(cf.x, cf.y); rotate(cf.rot);
    noStroke(); fill(cf.col[0], cf.col[1], cf.col[2]); rect(-cf.size/2, -cf.size/4, cf.size, cf.size/2, 2);
    pop();
  });
}

function drawHUD() {
  noStroke(); fill('#4A3F35'); textAlign(LEFT, CENTER); textSize(16);
  text(message, 28, 26);

  // ともだち度ゲージ（ともだちtoioから）
  const gx = 28, gy = 46, gw = 300, gh = 16;
  fill('#4A3F35'); textSize(13); textAlign(LEFT, CENTER);
  text('ともだち度', gx, gy + gh / 2);
  const bx = gx + 76;
  noStroke(); fill('#EFE3CF'); rect(bx, gy, gw, gh, 9);
  const frac = emo.affection / 100;
  fill(lerpColor(color('#FFC53D'), color('#FF6FA5'), frac));
  rect(bx, gy, gw * frac, gh, 9);
  [32, 70].forEach(v => { stroke(255, 180); strokeWeight(2);
    const mx = bx + gw * v / 100; line(mx, gy + 2, mx, gy + gh - 2); });
  noStroke(); fill('#4A3F35'); textSize(12); textAlign(LEFT, CENTER);
  const moodLabel = { love: 'うっとり♡', lonely: 'さみしい…', cheer: 'おうえん！', sleepy: 'ねむねむ…' }[emo.mood]
    || `${tierOf().label}${tierOf().name === 'bestie' ? '♥' : ''}`;
  text(`きもち: ${moodLabel}`, bx + gw + 14, gy + gh / 2);

  // サイコロ
  if (phase === 'rolling' || dice) {
    const shown = phase === 'rolling' && millis() - diceAnim < 850
      ? 1 + Math.floor(random(6)) : dice;
    fill(255); stroke('#E8D9C0'); strokeWeight(2);
    rect(VIEW_W - 76, 12, 52, 52, 12);
    noStroke(); fill('#4A3F35'); textAlign(CENTER, CENTER); textSize(30);
    text(shown || '', VIEW_W - 50, 40);
  }
  // 接続状態（下段）
  textSize(12); textAlign(LEFT, CENTER); fill('#9A8C7E');
  const vv = typeof TTS !== 'undefined' && TTS.available ? '🔊VOICEVOX' : '🔊PC音声';
  text(`${vv} ／ あなた:${players[0].cube ? '実機' : 'クリック'} とも:${players[1].cube ? '実機' : '画面'} ／ とものコマをクリックすると なでなで できるよ`, 28, VIEW_H - 12);
}

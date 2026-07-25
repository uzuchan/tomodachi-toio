/* ともだちすごろく2 — 協力ゲート版。
   3つの合流ゲート(🔒)で「二人が揃うまで先へ進めない」。
   先にゲートへ着いた側のサイコロは、遅れている相手を進める「応援サイコロ」になる。
   合流するたび友情ハート💗を獲得。ハート3個＋二人ともゴールでクリア。
   競争ではなく最初から最後まで協力するすごろく。実機0台でも遊べる。 */

// ── 盤面 ─────────────────────────────────────────────────────
const MAT = { xMin: 98, yMin: 142, xMax: 402, yMax: 358 };
const COLS = 6, ROWS = 4, GOAL = COLS * ROWS - 1;   // 24マス, GOAL=23
const CELL_W = (MAT.xMax - MAT.xMin) / COLS;
const CELL_H = (MAT.yMax - MAT.yMin) / ROWS;

// 合流ゲート。二人が揃うまでここより先へは進めない
const CHECKPOINTS = [5, 11, 17];
const HEARTS_TO_WIN = 3;

// 追い抜き迂回: near=コマがいる判定距離 / side=よけ幅 / land=同マス着地の駐車ずらし
// / margin=マット端の安全余白（すべてマット座標単位、キューブ一辺≈23.5）
const AVOID = { near: 36, side: 38, land: 30, margin: 14 };

// マスの種類（固定レイアウト）
const CELL_TYPE = { 0:'start', 2:'cheer', 3:'song', 4:'walk', 5:'gate',
                    7:'walk', 8:'dance', 9:'rock', 10:'cheer', 11:'gate',
                    13:'nade', 14:'walk', 15:'rock', 16:'cheer', 17:'gate',
                    19:'song', 20:'cheer', 21:'walk', 22:'touch', 23:'goal' };
const TYPE_INFO = {
  start: { icon: '🏁', label: 'スタート',   col: '#EFE3CF' },
  goal:  { icon: '🏆', label: 'ゴール',     col: '#FFE9A8' },
  gate:  { icon: '🔒', label: 'ごうりゅう', col: '#F7D9A8' },
  cheer: { icon: '📣', label: 'おうえん',   col: '#FFE1C9' },
  walk:  { icon: '👣', label: 'いっしょ',   col: '#CFF0D8' },
  rock:  { icon: '🪨', label: 'たすけて',   col: '#E4E0DA' },
  song:  { icon: '🎵', label: 'ハーモニー', col: '#D9C9F5' },
  dance: { icon: '💃', label: 'まねっこ',   col: '#C9E8F5' },
  nade:  { icon: '💗', label: 'なでなで',   col: '#FCD7E4' },
  touch: { icon: '🤝', label: 'ハイタッチ', col: '#FFD9E8' },
  plain: { icon: '',   label: '',           col: '#FBF3E2' },
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
  { name: 'あなた', emoji: '🐣', cube: null, pos: 0, drawPos: 0, color: '#3AA6D8', stuck: false, goal: false },
  { name: 'とも',   emoji: '🤖', cube: null, pos: 0, drawPos: 0, color: '#F0598A', stuck: false, goal: false },
];
let phase = 'setup';       // setup / dice / rolling / placing / moving / waitact / end
let turn = 0;              // 0=あなた 1=とも
let dice = 0, diceAnim = 0, targetIdx = 0;
let gatesCleared = 0, heartsWon = 0;
let message = 'キューブをつないで「▶はじめる」！（実機なしでもOK）';
let hearts = [], confetti = [];
let lastShakeAt = 0;
let placeResolver = null;  // あなたのコマ置き待ち
let actionResolver = null; // なでなで/ハイタッチ等の操作待ち

const $ = id => document.getElementById(id);

// 未解除の最初のゲート。全部解除済みならゴールまで進める
function gateLimit() { return gatesCleared < CHECKPOINTS.length ? CHECKPOINTS[gatesCleared] : GOAL; }
// ゲート(またはゴール)で相手を待っている状態か
function isWaiting(i) {
  const pl = players[i], other = players[1 - i];
  if (pl.goal && !other.goal) return true;
  return gatesCleared < CHECKPOINTS.length && pl.pos === CHECKPOINTS[gatesCleared];
}

// ── セットアップ ──────────────────────────────────────────────
function setup() {
  const c = createCanvas(VIEW_W, VIEW_H);
  c.parent($('stage-wrap'));
  textFont('"Hiragino Maru Gothic ProN", sans-serif');
  const mw = MAT.xMax - MAT.xMin, mh = MAT.yMax - MAT.yMin;
  const scale = Math.min((VIEW_W - 60) / mw, (VIEW_H - 120) / mh);
  stage = { scale, sx: (VIEW_W - mw * scale) / 2, sy: 84 };

  $('btn-you').onclick    = () => connect(0);
  $('btn-friend').onclick = () => connect(1);
  $('btn-start').onclick  = startGame;
  $('btn-dice').onclick   = () => { if (phase === 'dice') roll(); };
  $('btn-placed').onclick = () => placedOk();
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
    cube.on('motion', m => {
      if (i === 0 && m.shake && phase === 'dice' && turn === 0 && millis() - lastShakeAt > 2000) {
        lastShakeAt = millis(); roll();          // 954を振る=サイコロ
      }
      if (phase === 'waitact' && (m.doubleTap || m.collision || m.shake)) actionDone();
    });
    cube.on('button', b => { if (b.pressed && phase === 'waitact') actionDone(); });
    if (i === 0) {
      cube.on('position', p => {  // 手で置いたマスの検出
        if (phase !== 'placing') return;
        if (posToCell(p.x, p.y) === targetIdx) placedOk();
      });
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

// ── 追い抜き迂回（あなたの実機コマをよけて走る）───────────────
function obstaclePos() {
  const c = players[0].cube;
  return c && c.onMat && c.position ? { x: c.position.x, y: c.position.y } : null;
}
function clampMat(x, y) {
  return { x: constrain(x, MAT.xMin + AVOID.margin, MAT.xMax - AVOID.margin),
           y: constrain(y, MAT.yMin + AVOID.margin, MAT.yMax - AVOID.margin) };
}
const near = (a, b) => dist(a.x, a.y, b.x, b.y) < AVOID.near;

// 通過マス p にあなたのコマがいたら、進行方向と直交に膨らむ迂回点を返す
function detourVia(p) {
  const ob = obstaclePos();
  if (!ob) return null;
  const c = cellPos(p);
  if (!near(ob, c)) return null;
  const a = cellPos(Math.max(0, p - 1)), b = cellPos(Math.min(GOAL, p + 1));
  const len = dist(a.x, a.y, b.x, b.y) || 1;
  const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
  const cand = [ clampMat(c.x - dy * AVOID.side, c.y + dx * AVOID.side),
                 clampMat(c.x + dy * AVOID.side, c.y - dx * AVOID.side) ];
  // マット内に収めた上で、コマから遠い側を通る
  return dist(cand[0].x, cand[0].y, ob.x, ob.y) >= dist(cand[1].x, cand[1].y, ob.x, ob.y)
    ? cand[0] : cand[1];
}

// 着地マスにあなたのコマがいたら、ひとつ前のマス側に寄せて「となりにちょこん」
function landSpot(p) {
  const c = cellPos(p);
  const ob = obstaclePos();
  if (!ob || !near(ob, c)) return { x: c.x, y: c.y };
  let dx = 0, dy = -1;                       // スタートマスは上方向に寄せる
  if (p > 0) {
    const back = cellPos(p - 1);
    const len = dist(back.x, back.y, c.x, c.y) || 1;
    dx = (back.x - c.x) / len; dy = (back.y - c.y) / len;
  }
  return clampMat(c.x + dx * AVOID.land, c.y + dy * AVOID.land);
}

// ── ゲーム進行 ────────────────────────────────────────────────
function startGame() {
  players.forEach(pl => { pl.pos = 0; pl.drawPos = 0; pl.stuck = false; pl.goal = false; });
  confetti = []; hearts = [];
  gatesCleared = 0; heartsWon = 0; dice = 0;
  turn = 0;
  say('ともだちすごろくツー！ゲートでまちあわせして、ハートをみっつあつめてね！');
  message = '🔒のマスで合流→💗ゲット！ハート3つでふたりゴールをめざせ！';
  const s = landSpot(0);   // スタートマスに954が置いてあったら横にちょこん
  players[1].cube?.moveTo(s.x, s.y, 0, 60).catch(() => {});
  setTimeout(() => beginTurn(0), 2400);
}

function beginTurn(i) {
  if (phase === 'end') return;
  turn = i;
  const pl = players[i];
  if (pl.stuck) {                       // 🪨で停止中→手番スキップ（相手のサイコロで救出）
    message = `🪨 ${pl.name} は うごけない… ${players[1-i].name} のたすけをまってる`;
    say(i === 1 ? 'たすけて〜！' : 'いわにはさまった…ともー、たすけて〜！');
    setTimeout(() => beginTurn(1 - i), 2200);
    return;
  }
  phase = 'dice';
  const cheering = isWaiting(i);
  if (i === 0) {
    $('btn-dice').disabled = false;
    message = cheering
      ? '📣 きみは合流地点でまちぶせ中！応援サイコロで「とも」をすすめよう！'
      : '🎲 あなたのばん！サイコロを押す（か、954をシャカシャカ振る）';
    say(cheering ? 'おうえんさいころ、ふって！' : 'きみのばん！さいころふって！');
  } else {
    $('btn-dice').disabled = true;
    message = cheering ? '📣 とも の応援サイコロ…！' : '🤖 ともの ばん…';
    say(cheering ? 'おうえんするよ〜！えいっ！' : 'ぼくのばん！えいっ！');
    setTimeout(roll, 1800);
  }
}

function roll() {
  if (phase !== 'dice') return;
  phase = 'rolling';
  $('btn-dice').disabled = true;
  dice = 1 + Math.floor(Math.random() * 6);
  diceAnim = millis();
  players[turn].cube?.playSoundEffect(3).catch(() => {});
  setTimeout(resolveRoll, 900);
}

async function resolveRoll() {
  const i = turn, other = players[1 - i];
  // 「相手の次のサイコロで救出」— 振った瞬間に🪨から解放
  if (other.stuck) {
    other.stuck = false;
    message = `🪨→✨ ${players[i].name} のサイコロで ${other.name} きゅうしゅつ！`;
    say(i === 0 ? 'たすけてくれてありがとう！' : 'よいしょっと！たすけたよ！');
    const c = cellPos(other.pos); spawnHearts(c.x, c.y, 6);
    other.cube?.setLED(...hexRGB(other.color), 0).catch(() => {});
    await sleep(1600);
  }
  let mover = i;
  if (isWaiting(i)) {                    // 応援サイコロ：待っている側の出目は相手のもの
    mover = 1 - i;
    message = `📣 応援サイコロ！${players[mover].name} が ${dice}マスすすむ！`;
    say(i === 1 ? `${dice}だ！すすんですすんで〜！` : `おうえんありがと！${dice}マスすすむね！`);
    await sleep(900);
  } else {
    message = `🎲 ${dice}！`;
    if (i === 1) say(`${dice}がでた！`);
  }
  await advance(mover, dice, true);
  await endOfTurn();
}

async function endOfTurn() {
  if (phase === 'end') return;
  if (checkClear()) return;
  setTimeout(() => beginTurn(1 - turn), 1200);
}

// i を steps 進める（ゲートでクランプ）。withEffect=trueならマス効果も発動
async function advance(i, steps, withEffect) {
  const pl = players[i];
  if (pl.goal) return;
  const target = Math.min(pl.pos + steps, gateLimit());
  if (target <= pl.pos) {
    if (gateLimit() < GOAL) { message = `🔒 ${pl.name} はゲートでまちあわせ中！`; await sleep(800); }
    return;
  }
  if (i === 0) await placeYou(target);
  else await moveFriend(target);
  await checkGate();
  if (pl.pos >= GOAL && !pl.goal) { await reachGoal(i); return; }
  if (withEffect) await applyCell(i);
}

// あなたのコマ：実機を置く or クリックで確定するまで待つ
function placeYou(target) {
  return new Promise(res => {
    placeResolver = res;
    targetIdx = target;
    phase = 'placing';
    $('btn-placed').style.display = 'inline-block';
    message = `✨ 光っているマスへ954を置いて（クリックでもOK）`;
  });
}
function placedOk() {
  if (phase !== 'placing' || !placeResolver) return;
  phase = 'moving';
  $('btn-placed').style.display = 'none';
  players[0].pos = targetIdx; players[0].drawPos = targetIdx;
  players[0].cube?.playSoundEffect(1).catch(() => {});
  const r = placeResolver; placeResolver = null; r();
}

async function moveFriend(target) {
  phase = 'moving';
  const pl = players[1];
  const from = pl.pos;
  pl.pos = target;
  if (pl.cube) {
    let dodged = false;
    for (let p = from + 1; p <= target; p++) {
      pl.drawPos = p;
      // 通過マスにあなたのコマ → 横に膨らんで迂回。着地マスにいたら手前に寄せて駐車
      const via  = p < target ? detourVia(p) : null;
      const goal = p === target ? landSpot(p) : cellPos(p);
      if (via && !dodged) { dodged = true; say('よけてとおりま〜す！'); }
      try {
        if (via) await pl.cube.moveTo(via.x, via.y, null, 70, 'POS_ONLY');
        else     await pl.cube.moveTo(goal.x, goal.y, null, 70, 'POS_ONLY');
      } catch (e) {}
    }
  } else {
    for (let p = from + 1; p <= target; p++) { pl.drawPos = p; await sleep(420); }
  }
}

// ── 合流ゲート ────────────────────────────────────────────────
async function checkGate() {
  if (gatesCleared >= CHECKPOINTS.length) return;
  const g = CHECKPOINTS[gatesCleared];
  if (players[0].pos !== g || players[1].pos !== g) return;
  gatesCleared++; heartsWon++;
  const c = cellPos(g);
  spawnHearts(c.x, c.y, 16);
  message = `🔓 ごうりゅう！ 友情ハート💗ゲット！(${heartsWon}/${HEARTS_TO_WIN})`;
  say(`あえたね！ゆうじょうハート、${heartsWon}こめ、げっと！`);
  // 二台同時：同色LED＋ハモる短いファンファーレ
  const beat = 60000 / 120;
  const melo = [['G4',.5],['B4',.5],['D5',1]].map(([n,b]) => [b*beat, NOTE[n]]);
  const harm = [['B4',.5],['D5',.5],['G5',1]].map(([n,b]) => [b*beat, NOTE[n]]);
  players[0].cube?.setLED(255, 80, 150, 2600).catch(() => {});
  players[1].cube?.setLED(255, 80, 150, 2600).catch(() => {});
  players[0].cube?.playMelody(melo).catch(() => {});
  players[1].cube?.playMelody(harm).catch(() => {});
  await sleep(2600);
}

// ── マス効果 ─────────────────────────────────────────────────
async function applyCell(i) {
  const pl = players[i], other = players[1 - i];
  const t = typeOf(pl.pos);
  const c = cellPos(pl.pos);
  switch (t) {
    case 'cheer': {   // 📣 相手が2マスすすむ
      message = `📣 おうえんマス！${other.name} が2マスすすむ！`;
      say(i === 0 ? 'とも、がんばれ〜！2マスすすんで！' : 'きみもすすんで〜！おうえんするよ！');
      await sleep(1200);
      await advance(1 - i, 2, false);
      break;
    }
    case 'walk': {    // 👣 二人とも1マスすすむ
      message = '👣 いっしょにすすむ！ふたりとも +1マス';
      say('いっしょにすすもう！せーのっ！');
      await sleep(1000);
      await advance(1 - i, 1, false);
      await advance(i, 1, false);
      break;
    }
    case 'rock': {    // 🪨 停止。相手の次のサイコロで救出
      pl.stuck = true;
      message = `🪨 ${pl.name} は岩にはさまった！${other.name} のサイコロで救出できる`;
      say(i === 1 ? 'うわわ、はさまっちゃった！たすけて〜！' : 'いわだ！ともにたすけてもらおう…');
      pl.cube?.setLED(120, 120, 120, 0).catch(() => {});
      await sleep(1800);
      break;
    }
    case 'song': {    // 🎵 二台でハーモニー
      message = '🎵 ハーモニー！ふたりで合奏♪';
      say('いっしょにうたおう！ハモるよ〜！');
      const beat = 60000 / 108;
      const melo = [['G4',.5],['D4',.5],['G4',.5],['B4',.5],['D5',1]].map(([n,b]) => [b*beat, NOTE[n]]);
      const harm = [['B4',.5],['G4',.5],['B4',.5],['D5',.5],['G5',1]].map(([n,b]) => [b*beat, NOTE[n]]);
      players[0].cube?.setLED(170, 120, 255, 2200).catch(() => {});
      players[1].cube?.setLED(170, 120, 255, 2200).catch(() => {});
      players[0].cube?.playMelody(melo).catch(() => {});
      players[1].cube?.playMelody(harm).catch(() => {});
      await sleep(2200);
      break;
    }
    case 'dance': {   // 💃 ともが踊る→あなたが真似（954を回す/振る）
      message = '💃 まねっこダンス！ともの動きを954でまねしよう（振ってもOK）';
      say('まねっこだんす！ぼくのまねしてね！くるくる〜！');
      const fc = players[1].cube;
      if (fc) fc.move(50, -50, 700).then(() => fc.move(-50, 50, 700)).then(() => fc.stop()).catch(() => {});
      const ok = await waitAction(5000);
      if (ok) { message = '💃 じょうず〜！'; say('わ〜、じょうず！'); spawnHearts(c.x, c.y, 6); }
      await sleep(1200);
      break;
    }
    case 'nade': {    // 💗 なでなで成功でふたりとも+1
      message = '💗 なでなでタイム！ともをダブルタップかボタン（クリックでもOK）';
      say('なでなでして〜！');
      players[1].cube?.setLED(255, 80, 150, 6000).catch(() => {});
      await waitAction(7000);
      message = '💗 なでなでせいこう！ふたりとも +1マス';
      say('えへへ、うれしい！おれいにいっしょにすすもう！');
      spawnHearts(c.x, c.y, 10);
      await sleep(1200);
      await advance(1 - i, 1, false);
      await advance(i, 1, false);
      break;
    }
    case 'touch': {   // 🤝 ハイタッチ（こっつんこ or ボタン）
      message = '🤝 ハイタッチ！キューブをこっつんこ（ボタンやクリックでもOK）';
      say('ハイタッチしよう！こっつんこ〜！');
      players[0].cube?.setLED(255, 215, 0, 6000).catch(() => {});
      players[1].cube?.setLED(255, 215, 0, 6000).catch(() => {});
      await waitAction(6000);
      message = '🤝 ナイスハイタッチ！';
      say('いえーい！さいこうのともだち！');
      spawnHearts(c.x, c.y, 12);
      players[0].cube?.playSoundEffect(6).catch(() => {});
      players[1].cube?.playSoundEffect(6).catch(() => {});
      await sleep(1500);
      break;
    }
    default: await sleep(900);
  }
}

// なでなで/ハイタッチ等の操作待ち。実機イベント・クリック・タイムアウトで解決
function waitAction(ms) {
  return new Promise(res => {
    phase = 'waitact';
    let done = false;
    const finish = ok => { if (done) return; done = true; actionResolver = null; phase = 'moving'; res(ok); };
    actionResolver = () => finish(true);
    setTimeout(() => finish(false), ms);
  });
}
function actionDone() { actionResolver?.(); }

// ── ゴール ───────────────────────────────────────────────────
async function reachGoal(i) {
  const pl = players[i];
  pl.goal = true; pl.pos = GOAL; pl.drawPos = GOAL;
  const other = players[1 - i];
  if (!other.goal) {
    message = `🏆 ${pl.name} がゴール！応援サイコロで ${other.name} をよぼう！`;
    say(i === 1 ? 'ゴール！きみがくるまで、おうえんするね！' : 'ゴール！ともをおうえんでよんであげよう！');
    pl.cube?.setLED(255, 215, 0, 0).catch(() => {});
    await sleep(2000);
  }
}

function checkClear() {
  if (players[0].goal && players[1].goal && heartsWon >= HEARTS_TO_WIN && phase !== 'end') {
    endGame(); return true;
  }
  return phase === 'end';
}

async function endGame() {
  phase = 'end';
  message = `🎉 ハート${heartsWon}こ＋ふたりでゴール！さいこうの「友」！`;
  say('ハートみっつあつめて、ふたりともゴール！ずっとずっとともだちだよ！やったー！');
  for (let k = 0; k < 80; k++) confetti.push({
    x: random(VIEW_W), y: random(-300, 0), vy: random(60, 160),
    col: [random(120,255), random(120,255), random(120,255)], size: random(6,12), rot: random(TWO_PI),
  });
  const beat = 60000 / 132;
  const melo = [['G4',.5],['B4',.5],['D5',.5],['G5',1],['D5',.5],['G5',1.5]].map(([n,b]) => [b*beat, NOTE[n]]);
  const harm = [['B4',.5],['D5',.5],['G5',.5],['B5',1],['G5',.5],['B5',1.5]].map(([n,b]) => [b*beat, NOTE[n]]);
  players[0].cube?.playMelody(melo).catch(() => {});
  players[1].cube?.playMelody(harm).catch(() => {});
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

// ── クリック（コマを置く／なでなで等の代替操作）───────────────
function mousePressed() {
  if (phase === 'waitact') { actionDone(); return; }
  if (phase !== 'placing') return;
  const mx = (mouseX - stage.sx) / stage.scale + MAT.xMin;
  const my = (mouseY - stage.sy) / stage.scale + MAT.yMin;
  const c = posToCell(mx, my);
  if (c === targetIdx) placedOk();
  else if (c >= 0) { message = 'そこじゃないよ〜！ひかってるマスだよ'; say('そこじゃないよ〜'); }
}

// ── 描画 ─────────────────────────────────────────────────────
function draw() {
  background('#FDF6EC');
  drawBoard();
  drawPieces();
  drawFX();
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
    const isTarget = phase === 'placing' && p === targetIdx;
    const gi = CHECKPOINTS.indexOf(p);
    const gateOpen = gi >= 0 && gi < gatesCleared;   // 解除済みゲートは💗マークに
    const isNextGate = gi >= 0 && gi === gatesCleared;
    if (isTarget) {
      fill(lerpColor(color('#FFE9A8'), color('#FFC53D'), (sin(millis() / 180) + 1) / 2));
    } else if (isNextGate && phase !== 'setup') {
      fill(lerpColor(color(info.col), color('#FFB36B'), (sin(millis() / 300) + 1) / 2 * 0.5));
    } else fill(gateOpen ? '#FCE4EE' : info.col);
    stroke(isTarget ? '#E8940A' : '#EADFC8'); strokeWeight(isTarget ? 3 : 1.5);
    rect(sx - cw / 2, sy - ch / 2, cw, ch, 12);
    noStroke(); fill('#4A3F35');
    textAlign(CENTER, CENTER);
    const icon = gateOpen ? '💗' : info.icon;
    const label = gateOpen ? 'あえた！' : info.label;
    if (icon) { textSize(20); text(icon, sx, sy - 8); textSize(10); text(label, sx, sy + 14); }
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
    // リアルタイム実機位置（あなた・接続時のみ）を薄いリングで
    if (i === 0 && pl.cube && pl.cube.onMat) {
      const [rx, ry] = m2s(pl.cube.position.x, pl.cube.position.y);
      noFill(); stroke(pl.color + '88'); strokeWeight(3); circle(rx, ry, 30);
    }
    noStroke(); fill(0, 25); ellipse(sx + off, sy + 16, 30, 10);
    fill(pl.color); circle(sx + off, sy + (turn === i && phase !== 'end' ? -4 - 3 * abs(sin(millis() / 250)) : 0), 34);
    textSize(18); textAlign(CENTER, CENTER);
    text(pl.emoji, sx + off, sy + (turn === i && phase !== 'end' ? -5 - 3 * abs(sin(millis() / 250)) : -1));
    if (pl.stuck) { textSize(14); text('🪨', sx + off + 14, sy - 14); }
  });
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
  text(message, 28, 30);
  // サイコロ
  if (phase === 'rolling' || dice) {
    const shown = phase === 'rolling' && millis() - diceAnim < 850
      ? 1 + Math.floor(random(6)) : dice;
    fill(255); stroke('#E8D9C0'); strokeWeight(2);
    rect(VIEW_W - 76, 12, 52, 52, 12);
    noStroke(); fill('#4A3F35'); textAlign(CENTER, CENTER); textSize(30);
    text(shown || '', VIEW_W - 50, 40);
  }
  // 友情ハート＋つぎの合流ゲート
  textAlign(RIGHT, CENTER); textSize(15); fill('#E14D82');
  let hstr = '';
  for (let k = 0; k < HEARTS_TO_WIN; k++) hstr += k < heartsWon ? '💗' : '🤍';
  const gate = gatesCleared < CHECKPOINTS.length ? `つぎの合流: ${CHECKPOINTS[gatesCleared]}マス` : 'ゴールへ！';
  text(`${hstr} ${heartsWon}/${HEARTS_TO_WIN} ／ ${gate}`, VIEW_W - 90, 40);
  // ステータス行
  textSize(12); textAlign(LEFT, CENTER); fill('#9A8C7E');
  const vv = typeof TTS !== 'undefined' && TTS.available ? '🔊VOICEVOX' : '🔊PC音声';
  text(`${vv} ／ あなた:${players[0].cube ? '実機' : 'クリック'} とも:${players[1].cube ? '実機' : '画面'}`, 28, 52);
}

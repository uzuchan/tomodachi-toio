# ともだちtoio — 全日本AIハッカソン「友」

Sony toio (Core Cube) を Web Bluetooth + p5.js で動かすミニアプリ集。
ハッカソン(2026-07-25, 締切16:00)の作品。審査は toio 開発者の田中さんの興味を引けるか。

## 構成

```
index.html              … ホームページ（アプリランチャー）
apps/
  connect-check/        … 実機との接続確認だけをする最小ツール（トラブルシュート用）
  tomodachi-toio/       … メイン作品。AIの"友"キューブが手動キューブになついていくゲーム
  toio-concert/         … 1台用。MIDI一括送信で演奏(アイネクライネ等)+拍同期ダンス/LED。マット不要
  moji-board/           … 1台用。簡易カード(数字/A-Z/記号)のStandard IDを読んで表示+読み上げ
    index.html          … UI（接続ボタン等はHTML側）
    sketch.js           … 感情エンジン + デジタルツイン描画 (p5.js)
    toio.js             … Web Bluetooth ライブラリ（下記参照）
    p5.min.js           … p5.js v1.9.4 ローカルコピー（会場Wi-Fi対策で CDN 不使用）
memo.md                 … 作戦メモ（gitignore済み・公開しない）
```

## 実行方法

```bash
python3 -m http.server 8080   # リポジトリルートで
# Chrome で http://localhost:8080 を開く
```

- **Web Bluetooth は Chrome/Edge のみ・secure context 必須**（localhost か https）。
  `file://` で開くと接続できない。Safari 不可。
- 公開版: GitHub Pages（push すれば自動反映）。https なのでそのまま実機接続できる。
- 実機なしテスト: ともだちtoio は「シミュレーションで遊ぶ」ボタン、または `?sim=1` を付ける
  （あなた=マウス、友=仮想キューブ。ロジックは実機と共通）。
- ヘッドレス確認: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --screenshot=... --virtual-time-budget=8000 "http://localhost:8080/?sim=1"`

## toio.js（BLEライブラリ）の要点

配布されたデジタルツインビューワー同梱のライブラリを流用（+motion通知を拡張）。
各アプリに**コピーして**自己完結させる方針（共有パス参照にしない）。

- `toioManager.addCube(cubeId?)` → 選択ダイアログ→接続済み `ToioDevice` を返す。
  `cubeId`（例 `"954"`）を渡すと `namePrefix: "toio Core Cube-954"` でダイアログを絞り込む
  （会場に他人のtoioが大量にある対策）。空なら全toio表示。手持ちは 954 と h4i。
- `cube.move(l, r, ms)` 速度 -115..115。`ms=0` は書きっぱなし(即return)
- `cube.moveTo(x, y, angle, speed)` キューブ内蔵の目標地点移動(0x83応答をawait)
- `cube.setLED(r,g,b,ms)` / `cube.playSound(note,ms)` / `cube.playSoundEffect(id)`
- `cube.playMelody([[ms,note,vol?],...], repeat)` メロディ一括再生（独自拡張）。
  1書き込み59音まで自動分割。音符128=休符。タイミングはキューブ側で刻む。`stopSound()`で中断
- イベント: `cube.on('position'|'button'|'motion'|'attitude'|'matMissed'|'standardId'|'standardIdMissed'|'disconnect', fn)`
  - `motion` は `{horizontal, collision, doubleTap, posture, shake}`（この拡張は独自）
  - `standardId` は `{id, angle}`。ID通知type: 0x01=位置, 0x02=Standard ID, 0x03=マット外, 0x04=カード外
  - **簡易カード（コアキューブ付属の数字/A-Z/記号）の Standard ID = `0x380100 + ASCIIコード`**
    （公式表: toio-spec docs/info_standard_id.md。moji-board の decode() に実装済み）
- コマンド系メソッドは完了まで await する設計。連続駆動ループでは
  `move(l,r,0)` を busy フラグ付きで送る（sketch.js の `drive()` 参照）

### 座標・角度の約束（ハマりどころ）

- **使える物理素材は A3簡易プレイマット と レゴブロックのみ**。
  toio既製品のカード・トイコレマット等は使用禁止（ハッカソン制約）。Standard IDの読み取りは前提にしない。
- マット座標: A3簡易プレイマット `x: 98..402, y: 142..358`（1単位≈1.36mm、キューブ一辺≈23.5単位）
- y は下向きが正。
- **toio.js の `position.angle` は 0°=北(画面上)**（BLE生値 0°=東 に +90 済み）。
  math系の計算をするときは `(angle - 90) * π/180` で 0=+X のラジアンへ変換する。
- キューブのBLE接続は同時に1本だけ。**他のタブ/アプリが掴んでいると選択一覧に出ない**。
- **toio単体は音声合成（PCM再生）不可**。喋らせたい時は PC側の Web Speech API
  (`SpeechSynthesisUtterance`, lang=ja-JP, pitch高め) ＋ キューブ側は高速ランダム音符の
  「ピヨピヨ語」チャープ（tomodachi-toio の speak()/chirp() 参照）。

## デプロイ

```bash
git push        # GitHub Pages (main / root) が自動で更新される
```

リポジトリ: github.com/uzuchan（public）。`memo.md` と配布ビューワーの保存ファイルは
.gitignore で除外（他者の著作物・作戦メモのため）。コミットしないこと。

## 設計方針

- UIは日本語・ひらがな多め（かわいさ重視、審査員に刺さる方向）
- 新アプリは `apps/<name>/index.html` で自己完結 → ホーム `index.html` のグリッドにカード追加
- 感情・行動パラメータ（追従距離、なでなで判定しきい値等）は sketch.js 冒頭の定数に集約

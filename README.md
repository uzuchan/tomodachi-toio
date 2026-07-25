# ともだちtoio 🤝

手のひらのロボット [toio](https://toio.io) と**友だちになる**ゲームたち。
全日本AIハッカソン 2026（テーマ「友」）の作品です。

**▶ あそぶ: https://uzuchan.github.io/tomodachi-toio/** （Chrome / Edge で開いてください）

## アプリ

| アプリ | 内容 |
|---|---|
| 🔌 [接続チェック](apps/connect-check/) | 環境診断つき。実機とつながるかだけを確認する最小ツール |
| 🤝 [ともだちtoio](apps/tomodachi-toio/) | 手で動かすあなたのキューブに、AIの"友"キューブが心を開いていく。なでなでで喜び、放置ですねる。実機なしでもシミュレーションで遊べます |
| 🎻 [toioコンサート](apps/toio-concert/) | キューブ1台がオーケストラ。アイネ・クライネ・ナハトムジーク等を演奏しながらダンス＆LEDショー。マット不要 |
| 🔤 [もじボード](apps/moji-board/) | 数字・アルファベット・記号カード（Standard ID）を読んで表示＆読み上げ。文字を集めて英単語として発音 |

## 手元で動かす

```bash
python3 -m http.server 8080
# Chrome で http://localhost:8080
```

Web Bluetooth の制約により **Chrome / Edge + localhost または https** が必要です。

## 使用技術

- Sony toio Core Cube（[BLE仕様](https://toio.github.io/toio-spec/)） × Web Bluetooth
- p5.js（デジタルツイン描画）
- BLEライブラリはワークショップ配布のデジタルツインビューワー同梱 `toio.js` を拡張して使用

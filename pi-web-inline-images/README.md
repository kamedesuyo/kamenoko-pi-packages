# pi-web-inline-images

[pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) のプラグイン。ツール出力欄の次の形の行を見つけて、その下に画像を表示する。

```text
画像: D:\path\to\image.png（seed 123）
```

- 画像は pi-web-ui の `/api/file` から読む。モデルへ渡す内容（会話の文脈）には何も足さない。
- タップ / クリックで原寸を開く。
- ツールカードを畳んでいる間は表示しない（開くと戻る）。

## 入れ方

```bash
pi-web-ui install <このフォルダのパス>
```

画面を書き換えるため `dom` 権限を使う。入れた後、pi-web-ui の 設定 → UI plugins → Plugin list で「Grant DOM access」を押し、
「Rescan」してから画面を再読み込みする。

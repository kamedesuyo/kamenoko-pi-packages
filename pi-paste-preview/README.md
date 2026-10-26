# pi-paste-preview

pi の入力欄に貼り付けた画像（Alt+V などで一時ファイルとして入るもの）を、送信前に入力欄の近くへ小さく表示する pi 拡張。

- 追加の操作なしで表示する。クリックで拡大できる。
- 入力欄から画像を消す・送信して入力欄が空になると、表示も消える。
- 画像を描ける端末（WezTerm・kitty・Ghostty、その中の Herdr）で動く。

設計の経緯は [docs/design.md](docs/design.md)。

## 入れ方

```bash
pi install <このフォルダのパス>
```

設定は無い。

## テスト

```bash
npm test
```

Node 22 では `--experimental-test-module-mocks` が要る（`npm test` に入れてある）。
pi 本体はグローバルに入っているものを使い、場所は `PI_ROOT` で指定できる。
`imgpane` との併用テストは、隣の `../imgpane` か環境変数 `IMAGE_PANE_EXTENSION` の拡張を使い、見つからなければ飛ばす。

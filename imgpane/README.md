# imgpane

エージェント（pi・Claude Code・Codex）が作った・読んだ画像を見るための部品。

- `viewer/` — Windows Terminal の横ペインに Sixel で画像を描くビューア（Python、Pillow と numpy を使う）。
- `pi/image-pane.ts` — pi 拡張。読んだ・作った画像をビューアへ送り、画像に対応した端末（WezTerm・kitty・Ghostty、その中の Herdr）では会話の中にも描く。
- `e2e/check-inline-image.ps1` — Herdr + WezTerm 上の pi で、会話の中の画像表示が動くかを裏で確かめる。

## 約束（ほかの道具から送る方法）

`%LOCALAPPDATA%\imgpane\queue.txt` に、画像の絶対パスを1行ずつ追記する。ビューアが開いていなくても失敗しない。
pi 拡張・画像生成・Claude Code / Codex のフックは、すべてこの形で送る。

## 入れ方

```bash
pi install <このフォルダのパス>
```

ビューアだけ使うなら pi は要らない。`viewer\imgpane.bat` を直接使う:

```text
imgpane.bat              今の Windows Terminal のタブを左右に割って、右にビューアを開く
imgpane.bat show A.png   ビューアへ画像を送る
imgpane.bat view         今のコンソールでビューアを動かす
imgpane.bat hook         Claude Code・Codex のフック用（標準入力の JSON から画像のパスを拾う）
```

pi の中では `/imgpane` でビューアを開き、`/imgshow <パス>` で会話の中に描く。

## 設定

| 何を | どこで |
|---|---|
| ビューアを動かす Python | 環境変数 `IMGPANE_PYTHON`、なければ `%LOCALAPPDATA%\imgpane\python.txt` の1行目、なければ PATH の `python` |
| 新しい画像を自動で拾うフォルダ | `%LOCALAPPDATA%\imgpane\config.json` の `{"watch": ["C:\\path\\to\\images"]}` |
| E2E 検査で LLM の起動を確かめる URL | `check-inline-image.ps1 -LlmHealthUrl <URL>` または環境変数 `IMGPANE_CHECK_LLM_HEALTH` |

## テスト

```bash
npm test
```

pi 本体はグローバルに入っているものを使う。場所は `PI_ROOT` で指定できる。

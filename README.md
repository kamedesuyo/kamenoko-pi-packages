# kamenoko-pi-packages

コーディングエージェント pi（npm の `@earendil-works/pi-coding-agent`）を、ローカル LLM（llama.cpp・Strata）で使うための拡張と、画像生成の道具をまとめたもの。
使いたい部品だけを選んで入れられる。

## 何が入っているか

| フォルダ | 種類 | できること | そのまま使えるか |
|---|---|---|---|
| [pi-local-compact](pi-local-compact) | pi 拡張 | llama.cpp（llama-server）のモデルで、長い会話の compact を速く、壊れにくくする | 使える（対象の provider 名を設定する） |
| [pi-paste-preview](pi-paste-preview) | pi 拡張 | 入力欄に貼った画像を、送信前に入力欄の近くへ小さく表示する | 使える（画像を描ける端末で） |
| [imgpane](imgpane) | pi 拡張 + ビューア | 読んだ・作った画像を、会話の中や Windows Terminal の横のペインに表示する | 使える（ビューアは Windows と Python） |
| [pi-web-inline-images](pi-web-inline-images) | pi-web-ui プラグイン | ブラウザやスマホの pi-web-ui で、ツール出力の「画像: パス」の行をその場で画像にする | 使える |
| [pi-imagegen](pi-imagegen) | pi 拡張 | pi から画像を描くツール（`list_image_profiles`・`generate_image` ほか）と、生成中のプレビュー | 下の「画像生成について」 |
| [imagegen](imagegen) | スクリプト | ComfyUI のノードを直接呼んで描く本体（Qwen-Image 2.1・SDXL・登録した workflow） | 同上 |
| [strata-image-bridge](strata-image-bridge) | Strata への差分 | Strata の画像 API に、登録した profile で描く入口を足す patch | 同上 |

## 必要なもの

- pi（`@earendil-works/pi-coding-agent`）。作者は 1.4.0 で使っている。
- Windows（PowerShell・Windows Terminal・`%LOCALAPPDATA%` を使う部品がある）。
- 画像を会話の中に表示するには、画像を描ける端末（WezTerm・kitty・Ghostty）。
- 部品ごとの条件は、各フォルダの README に書いてある。

## 入れ方

pi はパッケージを置いた場所から、コピーせずにそのまま読み込む。消したり動かしたりしない場所へ clone する。

```powershell
git clone https://github.com/kamedesuyo/kamenoko-pi-packages.git
cd kamenoko-pi-packages
```

使う部品だけを、絶対パスで入れる（PowerShell なら `$PWD` が今のフォルダの絶対パスになる）。

```powershell
pi install "$PWD\pi-local-compact"
pi install "$PWD\pi-paste-preview"
pi install "$PWD\imgpane"
pi install "$PWD\pi-imagegen"
```

起動中の pi には `/reload` で読み直させる。入っているものは `pi list`、外す時は `pi remove <入れた時のパス>`。

pi-web-inline-images は pi ではなく pi-web-ui に入れる。

```powershell
pi-web-ui install "$PWD\pi-web-inline-images"
```

入れた後、pi-web-ui の 設定 → UI plugins → Plugin list で「Grant DOM access」を押し、「Rescan」してから画面を読み直す。

## 最初の設定

| 部品 | 設定 |
|---|---|
| pi-local-compact | 対象にする provider 名を `~/.pi/agent/settings.json` の `{"localCompact": {"providers": ["<provider 名>"]}}` に書く。書かなければ何もしない |
| pi-paste-preview | 無し。Alt+V などで画像を貼ると表示され、Alt+O やクリックで大きく開く |
| imgpane | 無くても動く。pi の中で `/imgpane` を打つとビューアが開き、`/imgshow <パス>` で会話の中に描く。ビューアの Python や監視するフォルダは [imgpane/README.md](imgpane/README.md) |
| pi-imagegen・imagegen | `%LOCALAPPDATA%\imagegen\config.json` に ComfyUI とモデルの場所を書く。[imagegen/config.example.json](imagegen/config.example.json) を写して直す |

## 画像生成について

画像生成の部品（pi-imagegen・imagegen・strata-image-bridge）は、作者の環境に合わせて作っていて、そのままでは動かない所がある。
読んで参考にするか、自分の環境に合わせて直して使う想定。

- 本流の profile 経由の生成（`list_image_profiles` → `generate_image(profile, prompt)`）は、`/health` が `image_profiles: true` を返す Strata サーバーを通して描く。
  strata-image-bridge の patch は、作者が手元で画像の機能を足した Strata に当てるもので、公開されている Strata にはそのまま当たらない。
- Strata を通さない旧入口（`generate_image` に `tags` だけを渡す SDXL、`generate_image_qwen`）には、GPU を製品名で確かめる所や、LLM が止まったかを決まったポートで確かめる所が残っている。
- 残っている前提の一覧は [imagegen/README.md](imagegen/README.md)、profile の設定は [imagegen/PROFILES.md](imagegen/PROFILES.md)。

## ライセンス

MIT（[LICENSE](LICENSE)）。ただし次の2つは例外。

- [imagegen](imagegen) は GPL-3.0（[imagegen/LICENSE](imagegen/LICENSE)）。ComfyUI（GPL-3.0）を読み込んで動くため。
- [strata-image-bridge](strata-image-bridge) の patch に含まれる Strata のコードは、Strata の MIT（[LICENSE-Strata](strata-image-bridge/LICENSE-Strata)、Copyright (c) 2026 Niko1221 and the Strata contributors）に従う。

## 直したい人へ

テストの流し方は各フォルダの README の「テスト」にある。
[tools](tools) には、今の pi の設定で読み込まれる拡張とエラーを一覧する `check-pi-load.mjs` と、`settings.json` の1キーを書き換える `set-pi-setting.mjs` がある。

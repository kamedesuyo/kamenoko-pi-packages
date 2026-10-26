# packages

ローカルLLM（pi + Strata / llama.cpp）まわりの部品を、1つずつ持ち出せる形でまとめたリポジトリ。
各フォルダは単体で `pi install <フォルダ>` または clone して使える。

このPC固有の値（パス・ポート・GPU・モデル名）は部品に書かない。設定で渡す。
部品の組み合わせ方（起動・切り替え・このPCの設定）は使う側に置き、このリポジトリには入れない。

| 部品 | 種類 | 内容 |
|---|---|---|
| [imagegen](imagegen) | スクリプト一式 | ComfyUIのノードを直接呼ぶ画像生成（SDXL・Qwen-Image 2.1）と、Strata画像APIのクライアント |
| [pi-imagegen](pi-imagegen) | piパッケージ | `generate_image` / `generate_image_qwen` ツールと生成中の途中表示 |
| [pi-local-compact](pi-local-compact) | piパッケージ | llama.cpp向けの高速compactと健全性監視 |
| [imgpane](imgpane) | ビューア + piパッケージ | Windows Terminal の横ペインに Sixel で画像を描くビューアと、pi の会話内画像表示 |
| [pi-paste-preview](pi-paste-preview) | piパッケージ | 入力欄に貼った画像を送信前に小さく表示 |
| [pi-web-inline-images](pi-web-inline-images) | pi-web-uiプラグイン | ツール出力の「画像: パス」をその場で画像表示 |
| [strata-image-bridge](strata-image-bridge) | Strataへの差分 | 画像対応の休眠版Strataに、imagegenの登録profileで描く入口を足すpatch |

開発用の小道具は [tools](tools)（piの拡張読み込み確認、settings.json の1キー更新）。

各パッケージのテストは、そのフォルダで `npm test`。

## ライセンス

MIT（[LICENSE](LICENSE)）。ただし次の2つは例外。

- [imagegen](imagegen) は GPL-3.0（[imagegen/LICENSE](imagegen/LICENSE)）。ComfyUI（GPL-3.0）を読み込んで動くため。
- [strata-image-bridge](strata-image-bridge) の patch に含まれる Strata のコードは、Strata の MIT（[LICENSE-Strata](strata-image-bridge/LICENSE-Strata)、Copyright (c) 2026 Niko1221 and the Strata contributors）に従う。

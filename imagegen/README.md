# imagegen

ComfyUI のノードをサーバなしで直接呼んで画像を描くスクリプト一式。pi からは [pi-imagegen](../pi-imagegen) が呼ぶ。

| 入口 | 中身 |
|---|---|
| `gen-image.ps1` / `.bat` | SDXL。Danbooru タグで書く |
| `gen-image-qwen21.ps1` / `.bat` | Qwen-Image 2.1。文章で書く。Strata が動いていれば Strata の画像APIへ、なければ自前で描く |
| `gen-image-strata.ps1` | Strata の画像API（`/v1/images/generations`、SSE）へ頼む |
| `gen-image-strata-edit.py` | 参照画像つきの編集を Strata の画像APIへ頼む |
| `comfyui-qwen21.ps1` / `.bat` | Qwen 用の ComfyUI を画面つきで開く |

内部: `gen-image-runner.py`（SDXL の生成役）、`gen-image-qwen21-runner.py`（Qwen の生成役。Strata の `local_comfy` からも呼ばれる）、
`gen-image-strata-client.py`（SSE の受け手）、`comfyui-qwen21-server.py`。

## 出力の約束

- 完成画像: `画像: <絶対パス>（seed <数>）` の行。pi-imagegen・pi-web-inline-images・imgpane はこの行を読む。
- 途中経過: 環境変数 `GEN_IMAGE_PROGRESS_EVENTS=1` の時、`QWEN_EVENT {...}` / `IMAGE_EVENT {...}` の行（JSON）。

## 設定

場所は `-Config <パス>` > 環境変数 `IMAGEGEN_CONFIG` > `%LOCALAPPDATA%\imagegen\config.json`。
[config.example.json](config.example.json) を写して直す。

| キー | 意味 |
|---|---|
| `outputDir` | 画像の保存先（無ければ ピクチャ\imagegen） |
| `comfyPython` | ComfyUI portable の `python_embeded\python.exe` |
| `sdxl.checkpoint` | SDXL の checkpoint |
| `qwen.root` / `unet` / `clip` / `vae` / `comfyPort` | Qwen 用 ComfyUI（`ComfyUI`・`site`・`ComfyUI-GGUF` を含むフォルダ）、モデル3つ、画面つき ComfyUI のポート |
| `strata.url` / `strata.python` | Strata の URL と、SSE クライアントを動かす Python |
| `legacyLlm.url` / `pauseScript` / `stateFile` | 任意。VRAM を空けるために止めて戻す LLM（llama-server）と、その止め戻しスクリプト |

## まだこのPC向けに残っている前提

- 生成役（runner）は GPU を名前で確かめる（SDXL の専用 GPU は RTX 4060、Qwen は RTX 5060 Ti + RTX 4060）。
  別の構成で使うには、GPU の割り当てを設定から渡す変更が要る。
- SDXL の生成役（`gen-image-runner.py`）は、LLM が止まっているかを `127.0.0.1` のポートが閉じているかで確かめる。
  8080（旧 llama-server）は毎回、8090（Strata）は共有 GPU で描く時に見る。設定の `legacyLlm.url` / `strata.url` は見ていない。
  LLM を別のポートで動かしていると確認が素通りし、8080 / 8090 を別のものが使っていると生成が止まる。
- 設定に `strata.url` が無い時は `http://127.0.0.1:8090`、`qwen.comfyPort` が無い時は 8188 を使う。

## テスト

```bash
python -m unittest discover -s test
```

Strata 側の画像APIの検査は Strata 本体と一緒に動かすものなので、このリポジトリには入れていない。

## ライセンス

GPL-3.0（[LICENSE](LICENSE)）。ComfyUI（GPL-3.0）を読み込んで動くため、このフォルダだけリポジトリ全体の MIT と分けている。

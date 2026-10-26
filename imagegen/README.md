# imagegen

新しい入口は **利用者が登録するローカルモデル／workflowプロファイル**。
使い方と設定仕様は [PROFILES.md](PROFILES.md)。配布用の設定例はQwenのみで、Qwenの導入自体は必須ではない。
`gen-image-profile.ps1 -ListProfiles`で一覧、`-Profile <ID> -Prompt <文章>`でStrata管理下の生成を行う。
以下には旧入口の互換仕様も含む。

ComfyUI のノードをサーバなしで直接呼んで画像を描くスクリプト一式。pi からは [pi-imagegen](../pi-imagegen) が呼ぶ。

| 入口 | 中身 |
|---|---|
| `gen-image.ps1` / `.bat` | SDXL。Danbooru タグで書く |
| `gen-image-qwen21.ps1` / `.bat` | Qwen-Image 2.1。文章で書く。Strata が動いていれば Strata の画像APIへ、なければ自前で描く |
| `gen-image-strata.ps1` | Strata の画像API（`/v1/images/generations`、SSE）へ頼む |
| `gen-image-strata-edit.py` | 参照画像つきの編集を Strata の画像APIへ頼む |
| `comfyui-qwen21.ps1` / `.bat` | Qwen 用の ComfyUI を画面つきで開く |
| `comfy-catalog-server.py --port <port>` | 公式Comfy MCP向けのCPU専用調査API。既存ComfyUIのノード・モデル情報を公開し、生成は受け付けない |

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
| `qwen.min_free_ram_gib` | Strata経由のQwen生成中に残す空きRAM（GiB、既定3、正の有限数）。jobの`min_free_ram_gib` > 環境変数`IMAGEGEN_MIN_FREE_RAM_GIB` > この設定の順。空きcommitの下限3GiBは維持し、いずれかを2回連続で下回ると生成子プロセスを終了する。約1秒間隔の監視なので、一時的に下限を割ることはある |
| `strata.url` / `strata.python` | Strata の URL と、SSE クライアントを動かす Python |
| `comfyMcp.modelPaths` | 調査APIで追加するモデルフォルダ。`{"loras": ["絶対パス"]}` のようにComfyUIの分類名→パスの配列。生成時に適用する設定ではない |
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

## 公式Comfy MCPとの境界

`comfy-catalog-server.py` は `--config` > `IMAGEGEN_CONFIG` > 通常のimagegen設定から既存ComfyUIを選ぶ。
ComfyUI本体のHTTPルートとノード登録処理を使い、モデルファイル名は照会時に読む。
CUDAを無効化し、標準ノードと生成runnerが使うGGUF拡張だけを読み込む。ほかのcustom nodeや外部APIノードは読み込まない。
`qwen.gguf_dir` を省略すると `qwen.root/ComfyUI-GGUF` を使う。
一覧にあるノードが現在の生成runnerで使えることや、モデルとの互換性・RAM容量までは保証しない。

公式 `comfy-mcp` と `comfy-cli` は別環境へ導入し、CLIの `COMFY_LOCAL_URL` をこの調査APIに向ける。
MCPの導入・pi登録・管理サービスの起動はsite側で担当する。部品からsiteは参照しない。
`/catalog_info` が `catalog_only` を返す。書き込みHTTPは403となり、`/prompt`・`/free`・`/interrupt` も実行できない。
`system_stats` はCPU専用プロセスの情報なので、GPUメモリの空きを判断する根拠にしない。

生成は引き続き `gen-image-qwen21.ps1` → Strata画像API → FIFO内の休眠・生成・復帰。
登録済みAPI workflowは新しいprofile入口から実行できる。LoRA等は対応ノードを含むworkflowとローカル重みを登録する方式で、MCPからの直接実行は引き続き禁止。

## ライセンス

GPL-3.0（[LICENSE](LICENSE)）。ComfyUI（GPL-3.0）を読み込んで動くため、このフォルダだけリポジトリ全体の MIT と分けている。

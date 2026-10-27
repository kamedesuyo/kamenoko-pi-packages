# imagegen

ComfyUI のノードを、サーバーを立てずに直接呼んで画像を描くスクリプト一式。pi からは [pi-imagegen](../pi-imagegen) が呼ぶ。

描き方は2通りある。

- **登録した profile で描く（本流）**: 使うモデルや ComfyUI の workflow を設定ファイルに profile として登録し、Strata の画像 API を通して描く。
  Strata が LLM の VRAM を一時的に空けて描き、終わったら戻す。設定は [PROFILES.md](PROFILES.md)。
- **旧入口**: Strata を通さずに描く、SDXL と Qwen-Image 2.1 用のスクリプト。作者の環境に合わせた前提が残っている（下の「作者の環境に合わせた前提」）。

## 入口

| 入口 | 中身 |
|---|---|
| `gen-image-profile.ps1` | 登録した profile で描く。`-ListProfiles` で一覧、`-Profile <ID> -Prompt <文章>` で生成。Strata の `/health` が `image_profiles: true` を返す必要がある |
| `gen-image.ps1` / `.bat` | 旧入口。SDXL。Danbooru タグで書く |
| `gen-image-qwen21.ps1` / `.bat` | 旧入口。Qwen-Image 2.1。文章で書く。Strata が動いていれば Strata の画像 API へ、なければ自分で描く |
| `gen-image-strata.ps1` | Strata の画像 API（`/v1/images/generations`、SSE）へ頼む |
| `gen-image-strata-edit.py` | 参照画像つきの編集を Strata の画像 API へ頼む |
| `comfyui-qwen21.ps1` / `.bat` | Qwen 用の ComfyUI を画面つきで開く |
| `comfy-catalog-server.py --port <port>` | Comfy MCP からノードとモデルを調べるための、CPU だけで動く読み取り専用の ComfyUI（下の「Comfy MCP で調べる」） |

内部で使うもの: `gen-image-profile.py`・`imagegen_profiles.py`・`gen-image-profile-runner.py`（profile の解決と生成役）、
`gen-image-runner.py`（SDXL の生成役）、`gen-image-qwen21-runner.py`（Qwen の生成役）、`gen-image-strata-client.py`（SSE の受け手）、`comfyui-qwen21-server.py`。

## 出力の形

- 完成画像: `画像: <絶対パス>（seed <数>）` の行。pi-imagegen・pi-web-inline-images・imgpane はこの行を読む。
- 途中経過: 環境変数 `GEN_IMAGE_PROGRESS_EVENTS=1` の時、`QWEN_EVENT {...}` / `IMAGE_EVENT {...}` の行（JSON）。

## 設定

場所は `-Config <パス>` > 環境変数 `IMAGEGEN_CONFIG` > `%LOCALAPPDATA%\imagegen\config.json`。
[config.example.json](config.example.json) を写して直す。profile まわりのキー（`comfy`・`profiles`・`defaultProfile`・`runtime` など）は [PROFILES.md](PROFILES.md)。

| キー | 意味 |
|---|---|
| `outputDir` | 画像の保存先（無ければ ピクチャ\imagegen） |
| `comfyPython` | ComfyUI portable の `python_embeded\python.exe` |
| `strata.url` | Strata の URL。profile で描く時は `--base` > 環境変数 `IMAGEGEN_STRATA_URL` > この設定の順で、既定のポートは無い |
| `comfyMcp.modelPaths` | 調べる用の ComfyUI に足すモデルフォルダ。`{"loras": ["絶対パス"]}` のように ComfyUI の分類名からパスの配列へ。生成には使わない |

旧入口だけが使うキー:

| キー | 意味 |
|---|---|
| `sdxl.checkpoint` | SDXL の checkpoint |
| `qwen.root` / `unet` / `clip` / `vae` / `comfyPort` | Qwen 用 ComfyUI（`ComfyUI`・`site`・`ComfyUI-GGUF` を含むフォルダ）、モデル3つ、画面つき ComfyUI のポート |
| `qwen.min_free_ram_gib` | Strata 経由の Qwen 生成中に残す空き RAM（GiB、既定3）。job の `min_free_ram_gib` > 環境変数 `IMAGEGEN_MIN_FREE_RAM_GIB` > この設定の順。空き commit の下限 3GiB は変わらず、どちらかを2回続けて下回ると生成を止める。約1秒ごとの監視なので、一時的に下限を割ることはある |
| `strata.python` | SSE クライアントを動かす Python |
| `legacyLlm.url` / `pauseScript` / `stateFile` | 任意。VRAM を空けるために止めて戻す LLM（llama-server）と、その止め戻しスクリプト |

## 作者の環境に合わせた前提

- profile で描くには、画像の機能を足した Strata が要る（[strata-image-bridge](../strata-image-bridge)）。公開されている Strata にはそのまま当たらない。
- 旧入口の生成役は GPU を製品名で確かめる（SDXL の専用 GPU は RTX 4060、Qwen は RTX 5060 Ti + RTX 4060）。
  別の構成で使うには、GPU の割り当てを設定から渡す変更が要る。profile で描く時は設定の GPU UUID で選ぶので、この前提は無い。
- SDXL の生成役（`gen-image-runner.py`）は、LLM が止まっているかを `127.0.0.1` のポートが閉じているかで確かめる。
  8080（llama-server）は毎回、8090（Strata）は共有 GPU で描く時に見る。設定の `legacyLlm.url` / `strata.url` は見ていない。
  LLM を別のポートで動かしていると確認が素通りし、8080 / 8090 を別のものが使っていると生成が止まる。
- 旧入口は、設定に `strata.url` が無い時は `http://127.0.0.1:8090`、`qwen.comfyPort` が無い時は 8188 を使う。

## Comfy MCP で調べる

`comfy-catalog-server.py` は、手元の ComfyUI にあるノードとモデルの一覧を、CPU だけで HTTP に出す。
[公式 Comfy MCP](https://github.com/Comfy-Org/comfy-mcp) の `COMFY_LOCAL_URL` をここへ向けると、エージェントがノードの入出力や手元のモデルを調べられる。
pi でのつなぎ方は [pi-imagegen の README](../pi-imagegen/README.md)。

- どの ComfyUI を使うかは `--config` > `IMAGEGEN_CONFIG` > 通常の imagegen 設定で決まる。旧形式の設定で `qwen.gguf_dir` が無ければ `qwen.root/ComfyUI-GGUF` を使う。
- 標準ノードと、設定した custom node（GGUF ローダなど）だけを読み込む。ほかの custom node や外部 API ノードは読み込まない。
- 読み取り専用。`/catalog_info` は `catalog_only` を返し、書き込みの HTTP は 403 になる。`/prompt`・`/free`・`/interrupt` も動かない。
- CPU だけで動くので、`system_stats` の値は GPU の空きを表さない。一覧にあるノードが今の生成で使えるか、モデルとの相性や必要なメモリまでは保証しない。
- 見つけたノードやモデルで描くには、それを使う workflow とモデルを profile に登録する（[PROFILES.md](PROFILES.md)）。

## テスト

```bash
python -m pytest test/
```

## ライセンス

GPL-3.0（[LICENSE](LICENSE)）。ComfyUI（GPL-3.0）を読み込んで動くため、このフォルダだけリポジトリ全体の MIT と分けている。

# pi-imagegen

pi から [imagegen](../imagegen) を呼んで画像を描く pi 拡張。

| ツール | 中身 |
|---|---|
| `list_image_profiles` | 登録した profile（モデル・workflow）の ID・説明・既定値を一覧する。GPU は使わない |
| `generate_image` | `prompt` と、任意で `profile` を渡して描く。Strata が LLM の VRAM を空けて描き、終わったら戻す。`tags` だけを渡すと旧入口の SDXL で描く |
| `generate_image_qwen` | 旧入口。Qwen-Image 2.1 で文章から描く（imagegen の `gen-image-qwen21.ps1`） |

- 生成中の進み具合と途中画像を、ツール欄の中に描く（画像を描ける端末で）。
- 結果は「画像: パス（seed N）」の行で返す。`review` を付けた時だけ、画像に対応したモデルに完成画像を見せる。
- `generate_image` も `generate_image_qwen` も、生成後はターンを続ける。`follow_up` は互換のために受け取るだけで効果はない。
- 参照画像を使った編集は、このパッケージには入っていない。

## 入れ方

```bash
pi install <このフォルダの絶対パス>
```

起動中の pi には `/reload` で読み直させる。

imagegen の置き場所は、環境変数 `IMAGEGEN_DIR` > `~/.pi/agent/settings.json` の `{"imagegen": {"dir": "..."}}` > このリポジトリで隣にある `../imagegen` の順に探す。
imagegen 自体の設定（ComfyUI・モデル・profile・出力先）は [imagegen の README](../imagegen/README.md) と [PROFILES.md](../imagegen/PROFILES.md)。
設定例は Qwen の1件だけで、ほかのモデルも ComfyUI の API 形式 workflow として登録できる。

## Comfy MCP で調べる（任意）

pi の MCP 機能で [公式 Comfy MCP](https://github.com/Comfy-Org/comfy-mcp) をつなぐと、エージェントが ComfyUI のノードの入出力や手元のモデルを調べられる。
描くのは今までどおり `generate_image`。

- Comfy MCP の `COMFY_LOCAL_URL` を、imagegen の `comfy-catalog-server.py`（CPU だけで動く読み取り専用の ComfyUI）に向ける。Comfy MCP の起動方法はその README に従う。
- pi 側は `~/.pi/agent/mcp.json` にサーバー名 `comfy` で登録し、実行系のツール（`run_workflow` など）は出さず、調べるツールだけを出す。

```json
{
  "mcpServers": {
    "comfy": {
      "command": "<Comfy MCP を起動するコマンド>",
      "exposure": "hidden",
      "toolExposure": {
        "nodes": "deferred",
        "search_models": "deferred",
        "validate_workflow": "deferred"
      }
    }
  }
}
```

`hidden` のサーバーでは、`toolExposure` に書いたツールだけが使える。`deferred` のツールは、エージェントが `tool_search` で必要な時だけ読み込む。
設定したら pi で `/reload` し、つながったかは `/mcp` か `pi mcp list` で見る。

見つけたノードやモデルで描くには、それを使う workflow とモデルを profile に登録してから `generate_image` で描く。

## 作者の環境に合わせた前提

- profile で描くには、画像の機能を足した Strata が要る（[strata-image-bridge](../strata-image-bridge)）。
- `tags` だけを渡す旧入口は、provider が `localllm-strata`（作者が使っている provider 名）の時に、専用 GPU（`-Gpu rtx4060`）で描かせる。
- `generate_image_qwen` の `watch` の説明（LLM が読む文）に、ComfyUI のポート 8188 を書いている。imagegen の `qwen.comfyPort` を変えても、この文は変わらない。

## テスト

```bash
npm test
```

画像はテストの中で合成する。`imgpane`・`strata-integration` との併用テストは隣のパッケージか環境変数
（`IMAGE_PANE_EXTENSION`・`STRATA_INTEGRATION_EXTENSION`）の拡張を使い、見つからなければ飛ばす。

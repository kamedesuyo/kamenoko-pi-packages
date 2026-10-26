# pi-imagegen

pi から [imagegen](../imagegen) を呼んで画像を描く pi 拡張。

| ツール | 中身 |
|---|---|
| `list_image_profiles` | 登録済みローカルモデル／workflowのID・説明・既定値を調べる（GPU未使用） |
| `generate_image` | `prompt`と任意の`profile`を渡し、Strata休眠・生成・復帰。旧tagsのみの呼出は従来SDXL経路 |
| `generate_image_qwen` | Qwen-Image 2.1（文章で書く）。imagegen の `gen-image-qwen21.ps1` |

- 生成中の進み具合と途中画像を、ツール欄の中に描く（画像を描ける端末で）。
- 結果は「画像: パス（seed N）」の行で返す。`review` を付けた時だけ、画像対応モデルに完成画像を見せる。
- `generate_image` は生成後もターンを続ける。`generate_image_qwen` は既定でターンを終え、`follow_up` で続ける。

## 入れ方

配布用設定例はQwenのみ。ほかのローカルモデルもAPI workflowとして登録できる。
モデルの設定とworkflow bindingは[imagegen/PROFILES.md](../imagegen/PROFILES.md)を参照。
新規生成は`generate_image(profile="登録ID", prompt="文章")`、省略時は利用者のdefaultProfile。
ツール更新後、既存piでは`/reload`する。

```bash
pi install <このフォルダのパス>
```

imagegen の置き場所は、環境変数 `IMAGEGEN_DIR` > `~/.pi/agent/settings.json` の `{"imagegen": {"dir": "..."}}` > このリポジトリで隣にある `../imagegen` の順に探す。
imagegen 自体の設定（ComfyUI・モデル・出力先）は imagegen の README を参照。

## 必要な機能を調べる

pi本体のMCP機能から、[公式Comfy MCP](https://github.com/Comfy-Org/comfy-mcp)を利用できる。
ユーザー環境側で `~/.pi/agent/mcp.json` にサーバー名 `comfy` として登録する。
`nodes`・`search_models`・`validate_workflow` などを `deferred` で公開すると、エージェントが `tool_search` で必要なものだけ読み込める。
設定後はpiで `/reload`、接続状態は `/mcp` または `pi mcp list` で確認する。

例: 「Comfyで使えるLoRAノードの入力と、手元にあるLoRAを調べて」。
調査は作業に応じて自由に行い、ノード検索やworkflow読解のたびに確認を求めない。
既存のworkflow JSONはpiの通常の `read` でも読み、接続・入力値・必要なノードを確認できる。テンプレート取得や実行を伴わない検証も調査に含める。
ノード名だけでなく `nodes(action="get", name="LoraLoader")` で入力・出力型を確認し、モデルは `search_models(folder="loras")` で調べる。
Qwenも共通のprofile入口から生成できる。MCPで見つけたノードやLoRAは、利用するworkflowとローカル重みをprofileへ登録してから使う。
調査APIでGPU生成を直接始めず、Strata側が持つ休眠・復帰と待ち行列を利用する。
新規生成は `list_image_profiles` → `generate_image(profile, prompt)`、参照編集は既存の `local-image-edit` 入口を使う。
調べたworkflowに未対応の機能があれば、その不足を報告する。MCP・HTTP・独立スクリプトで直接生成して既存の資源管理を迂回しない。

## まだこのPC向けに残っている前提

- 旧tagsのみの互換呼出ではproviderが `localllm-strata` の時に専用GPUを指定する。新しいprofile入口のGPU配置はimagegen設定が持つ。
- `generate_image_qwen` の `watch` の説明（LLM が読む文）に、ComfyUI のポート 8188 を書いている。imagegen の `qwen.comfyPort` を変えても、この文は変わらない。

## テスト

```bash
npm test
```

画像はテストの中で合成する。`imgpane`・`strata-integration` との併用テストは隣のパッケージか環境変数
（`IMAGE_PANE_EXTENSION`・`STRATA_INTEGRATION_EXTENSION`）の拡張を使い、見つからなければ飛ばす。

# pi-imagegen

pi から [imagegen](../imagegen) を呼んで画像を描く pi 拡張。

| ツール | 中身 |
|---|---|
| `generate_image` | SDXL（Danbooru タグで書く）。imagegen の `gen-image.ps1` |
| `generate_image_qwen` | Qwen-Image 2.1（文章で書く）。imagegen の `gen-image-qwen21.ps1` |

- 生成中の進み具合と途中画像を、ツール欄の中に描く（画像を描ける端末で）。
- 結果は「画像: パス（seed N）」の行で返す。`review` を付けた時だけ、画像対応モデルに完成画像を見せる。
- `generate_image` は生成後もターンを続ける。`generate_image_qwen` は既定でターンを終え、`follow_up` で続ける。

## 入れ方

```bash
pi install <このフォルダのパス>
```

imagegen の置き場所は、環境変数 `IMAGEGEN_DIR` > `~/.pi/agent/settings.json` の `{"imagegen": {"dir": "..."}}` > このリポジトリで隣にある `../imagegen` の順に探す。
imagegen 自体の設定（ComfyUI・モデル・出力先）は imagegen の README を参照。

## まだこのPC向けに残っている前提

- provider が `localllm-strata` の時は、SDXL を専用 GPU（`-Gpu rtx4060`）で描かせる。
- `generate_image_qwen` の `watch` の説明（LLM が読む文）に、ComfyUI のポート 8188 を書いている。imagegen の `qwen.comfyPort` を変えても、この文は変わらない。

## テスト

```bash
npm test
```

画像はテストの中で合成する。`imgpane`・`strata-integration` との併用テストは隣のパッケージか環境変数
（`IMAGE_PANE_EXTENSION`・`STRATA_INTEGRATION_EXTENSION`）の拡張を使い、見つからなければ飛ばす。

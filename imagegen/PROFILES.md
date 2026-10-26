# ローカル生成プロファイル

配布する設定例は [config.example.json](config.example.json) のQwen一例のみ。
重みは同梱・自動取得せず、特定の量子化や配布者を要求しない。
新しい共通入口では旧`qwen`・`sdxl`設定セクションも不要。

```text
list_image_profiles()
generate_image(profile="qwen-local", prompt="窓辺の青いカップと木彫りの狐")
```

profile省略時は利用者の`defaultProfile`を使う。コード内に既定モデルを持たない。
生成はStrataのFIFO内で休眠→子プロセス→復帰し、完了通知は復帰後に返す。
MCPは調査用のままで、生成の迂回には使わない。

## 設定

設定ファイルは`--config` / `-Config` > `IMAGEGEN_CONFIG` > `%LOCALAPPDATA%/imagegen/config.json`。
相対パスは設定ファイルのフォルダが基準。

| キー | 内容 |
|---|---|
| `comfyPython` | ComfyUIと必要なノードを動かせるPython。PowerShell入口は`IMAGEGEN_PYTHON`で上書き可 |
| `comfy.dir / siteDir` | ComfyUI本体と、必要なPythonモジュールの追加先 |
| `comfy.customNodes` | 実行・調査時に読み込む拡張のディレクトリ配列 |
| `comfy.modelPaths` | ComfyUI分類名→モデル検索先ディレクトリ配列 |
| `profiles` | 利用者が管理するID→生成設定 |
| `defaultProfile` | profile省略時に選ぶID |
| `strata.url` | 接続先。CLIの`--base` > `IMAGEGEN_STRATA_URL` > 設定。ポートの既定値なし |
| `outputDir` | 保存先。省略時はホームの`Pictures/imagegen` |

`list_image_profiles`はID・説明・生成の既定値を返し、GPUを使わない。
HTTPリクエストから指定できるのは登録IDと生成引数。workflow・モデル・runnerのパスを上書きできない。
登録変更は次の生成から有効。piのツール更新を取り込む際は`/reload`が必要。

## qwen21 adapter

`adapter: qwen21`は既存のQwen Image 2.1用省メモリ処理。
`models.unet/clip/vae`にそれぞれ`path`とComfyUIの分類名`folder`を指定する。
`ggufDir`は対応GGUFローダ。テキストエンコーダを解放してからDiTを読み、既存の参照編集にも対応する。
`runtime.text_encoder_device`は`cpu`か、選択GPU列に対する`cuda:N`。
CPUエンコーダも設定できるが、実機検証した配置はエンコーダとDiTを別GPUに置いた構成。

## workflow adapter

別のモデル方式は`adapter: workflow`として、利用者のComfyUI **API形式JSON**を登録する。
画面編集用JSONとは異なる。モデル名の分岐を増やさず、ComfyUIのノードがモデルの読み込みと推論を担当する。

| profileのキー | 内容 |
|---|---|
| `workflow` | API形式JSONのローカルパス |
| `models.<任意名>.path / folder` | ローカル重みとComfyUI分類名 |
| `bindings.<値の名前>` | `[node ID, input名]`を並べた配列。複数入力への同時設定も可能 |
| `outputNode` | 完成画像を受け取るSaveImageのnode ID |
| `defaults` | size, steps, cfg_scale, sampler, scheduler, negative_prompt |

bindingの名前は`prompt`, `negative_prompt`, `width`, `height`, `seed`, `steps`, `cfg_scale`,
`sampler`, `scheduler`, `model.<任意名>`。
prompt/width/height/seedは必須。それ以外もdefaultsやリクエストで操作するなら対応bindingが必要。
model bindingには登録したファイル名が入り、親フォルダをモデル検索先へ追加する。
未配置モデル、不明なprofile、不正なbindingはGPUを休眠させる前に拒否する。

ComfyUI自身の検証・実行器を使い、選択したSaveImageの入力を管理された出力先へ保存する。
1回1枚のPNGが対象。複数枚はseedを1ずつ増やして順次生成する。出力寸法が要求と異なれば成功扱いにしない。
動画・任意batch出力・汎用workflowへの参照画像bindingは未対応。
ノードやモデルの互換性・所要メモリはprofileごとに実生成で確認する。
登録workflow/custom nodeは実行可能なローカル設定であり、サンドボックスではない。

## GPUとRAM

`runtime.gpu_uuids`で使用GPUをCUDAの順に指定する。空配列は起動環境の選択を引き継ぐ。製品名は判定しない。
`min_free_vram_mib`はGPUごとの開始時の空き条件。
`min_free_ram_gib`の既定は3GiB、空きcommitの下限も3GiB。
いずれかを2回連続で下回れば子プロセスを終了し、Strataが復帰する。
`comfy_args`は管理者が設定する起動オプションで、HTTP入力から変更できない。

## Strata側

profile対応の画像bridgeが必要。現在の休眠版向け差分は隣の`strata-image-bridge`に保管する。
`images.local_comfy.runner`を`gen-image-profile-runner.py`、`profiles_config`をimagegen設定の絶対パスへ向ける。
`images.exe`はComfyUI用Python。既存の`gpu_policy: sleep`と復帰設定を保つ。
profile対応時はStrata側のdiffusion_model/llm/vaeを必須とせず、imagegen設定がモデルを所有する。
新CLIは`/health.image_profiles: true`を確認して送信し、非対応サーバでは迂回せず止まる。

旧`generate_image_qwen`・`generate_image(tags=...)`・旧スクリプトは互換入口として残す。
旧入口には従来の機種やモデル方式への依存が残る。配布先・新規呼び出しは`generate_image(prompt=..., profile=...)`を使う。

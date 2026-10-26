# Strata image profile bridge

`profiles.patch`は、このプロジェクトの画像対応VRAM休眠版（native 0.1.49.2 / zapabob由来のPython runtime）へ、登録モデル／workflowプロファイルを追加する差分。
**上流の未改造Strataへ単独適用するものではない。** 既存の画像FIFO・local_comfy・sleep/wake統合を前提にする。
nativeバイナリは変更しない。適用元・適用後のファイルハッシュは`profile-files.json`で照合できる。

runtimeのバックアップを作り、`git apply --check --ignore-space-change profiles.patch`で一致を確認してから同じオプションで適用する。
Windows配布物のLF/CRLF混在を許容するため、このオプションを付ける。
上流更新で合わない場合は手動で差分を確認し、画像生成と失敗後の復帰を再検証する。
配布更新後に無条件で上書きする仕組みは設けない。
ローカル標準の`validated-build.json` / `local-master.json`は、検証後のファイルだけで更新する。

設定するのは`images.exe`（ComfyUIのPython）、`images.local_comfy.runner`（imagegenのprofile runner）、
`images.local_comfy.profiles_config`（利用者のimagegen設定）。既存のGPU policyとFIFO管理を維持する。
profile対応時、Strata側で特定モデルのdiffusion_model/llm/vaeを必須にしない。
モデルやworkflowの情報は[imagegen/PROFILES.md](../imagegen/PROFILES.md)を参照。

HTTPは従来の`POST /v1/images/generations`へ`profile`を追加する。
`/health.image_profiles`がtrueなら対応済み。未対応サーバはprofile指定を無視せずエラーにする。
profileはrunnerのGPU未使用CLIで解決し、未知のIDやモデル未配置を休眠前に拒否する。
生成リクエストからファイルパス・runner・workflowを上書きする入力は受け付けない。
モデルが必要とするノードの検証はComfyUIが行い、失敗しても既存FIFOのfinallyで復帰する。

検査は`STRATA_RUNTIME`に対象runtime-packageを指定し、このフォルダで`python -m unittest discover -s test`。
GPUを使う実生成と会話キャッシュ確認は別途必要。

## ライセンスと出典

`profiles.patch`は [Strata](https://github.com/Niko1221/Strata)（MIT、Copyright (c) 2026 Niko1221 and the Strata contributors）のファイルへの差分で、
差分の前後の行として Strata とその派生版のコードを含む。その部分は Strata のライセンスに従う（本文は [LICENSE-Strata](LICENSE-Strata)）。
このフォルダで足した部分（patchの追加行・検査・説明）は、リポジトリ全体と同じ MIT。

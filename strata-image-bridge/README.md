# strata-image-bridge

Strata（ローカル LLM サーバー）の画像 API に、[imagegen](../imagegen) の登録 profile で描く入口を足す差分（`profiles.patch`）。

**この patch は、作者が手元で画像の機能（ComfyUI を呼ぶ `local_comfy`、LLM の VRAM を空けて描いて戻す仕組みなど）を足した Strata 向け。
公開されている Strata にはそのまま当たらない。** 同じような画像の機能を持つ Strata に足す時の参考として置いている。
対象は native 0.1.49.2 と zapabob 版由来の Python runtime の組み合わせで、native バイナリは変えない。

## 何が変わるか

- `POST /v1/images/generations` に `profile` を指定できるようになる。`/health` が `image_profiles: true` を返す。
  対応していないサーバーは、profile の指定を無視せずエラーにする。
- profile は imagegen の runner が GPU を使わずに解決する。知らない ID やモデルの欠けは、LLM の VRAM を空ける前に断る。
- リクエストから変えられるのは profile ID と生成引数だけで、ファイルパス・runner・workflow は変えられない。
- モデルが必要とするノードの確認は ComfyUI が行う。生成に失敗しても、画像の順番待ち（FIFO）の後始末で LLM は戻る。

## 当て方

1. Strata の runtime（`serve/` のあるフォルダ）のバックアップを取る。
2. runtime のフォルダで `git apply --check --ignore-space-change profiles.patch` を流して当たるか確かめ、同じオプションで当てる。
   Windows の配布物は LF と CRLF が混ざっているので、このオプションを付ける。
3. 当てる前と後のファイルのハッシュは [profile-files.json](profile-files.json) と照合できる。
4. Strata の画像の設定で、`images.exe` に ComfyUI の Python、`images.local_comfy.runner` に imagegen の `gen-image-profile-runner.py`、
   `images.local_comfy.profiles_config` に imagegen の設定ファイルの絶対パスを指定する。GPU の扱い（`gpu_policy`）と順番待ちの設定は今のままにする。
   profile を使う時は、Strata 側でモデル（diffusion_model・llm・vae）を指定しなくてよい。
5. Strata を更新した後などで当たらない時は、差分を手で見比べ、画像の生成と、失敗した時に LLM が戻ることを確かめ直す。

## テスト

`STRATA_RUNTIME` に対象の runtime のフォルダを指定して、このフォルダで流す。指定が無ければ飛ばす。

```bash
python -m unittest discover -s test
```

GPU を使う実際の生成と、会話のキャッシュが戻るかの確認は、別に要る。

## ライセンスと出典

`profiles.patch` は [Strata](https://github.com/Niko1221/Strata)（MIT、Copyright (c) 2026 Niko1221 and the Strata contributors）のファイルへの差分で、
差分の前後の行として Strata とその派生版のコードを含む。その部分は Strata のライセンスに従う（本文は [LICENSE-Strata](LICENSE-Strata)）。
このフォルダで足した部分（patch の追加行・検査・説明）は、リポジトリ全体と同じ MIT。

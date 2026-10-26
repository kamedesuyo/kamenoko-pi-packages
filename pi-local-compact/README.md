# pi-local-compact

llama.cpp（llama-server）で動かすローカルモデル向けの、pi の compact 拡張。

- 直前に送った履歴をそのまま先頭に使って要約させるので、llama.cpp のプロンプトキャッシュが効き、長い会話でも compact が速い。
- 要約のときだけ思考を止める（`chat_template_kwargs.enable_thinking: false`）。
- 途中で切れた・空・ツール呼び出しになった要約は保存せず、元の会話を残す。
- `local-compact-health` が、pi の更新後に互換性をモデルを使わず自動で検査する（`/compact-check` で手動検査）。

## 入れ方

```bash
pi install <このフォルダのパス>
```

## 設定

対象にする provider 名を指定する。指定がなければ何もしない。

`~/.pi/agent/settings.json`:

```json
{
  "localCompact": { "providers": ["localllm-llamacpp-local"] }
}
```

環境変数 `PI_LOCAL_COMPACT_PROVIDERS`（カンマ区切り）があれば、そちらを優先する。

検査結果は `~/.pi/agent/local-compact/`（`PI_CODING_AGENT_DIR` があればその下）に保存する。

## テスト

```bash
npm test
```

pi 本体（`@earendil-works/pi-coding-agent`）はグローバルに入っているものを使う。場所は `LOCAL_COMPACT_PI_ROOT` で指定できる。

"""imagegen の設定を読む。場所は 環境変数 IMAGEGEN_CONFIG > %LOCALAPPDATA%\\imagegen\\config.json。

このPC固有の値（フォルダ・モデル・ポート）はすべて設定から受け取り、スクリプトには書かない。
"""
import json
import os
from pathlib import Path


def config_path():
    explicit = os.environ.get('IMAGEGEN_CONFIG')
    if explicit:
        return Path(explicit)
    base = os.environ.get('LOCALAPPDATA') or str(Path.home() / '.config')
    return Path(base) / 'imagegen' / 'config.json'


def load_config(path=None):
    path = Path(path) if path else config_path()
    if not path.exists():
        raise FileNotFoundError(f'imagegen の設定ファイルが無い: {path}（config.example.json を写して直す）')
    return json.loads(path.read_text(encoding='utf-8-sig'))

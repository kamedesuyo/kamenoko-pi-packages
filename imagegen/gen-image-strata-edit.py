"""local-image-editのjobをStrataの画像FIFOへ渡す。"""
import base64
import importlib.util
import json
from pathlib import Path
import sys
import urllib.error
import urllib.request

def load_sibling(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def strata_base():
    url = load_sibling('imagegen_config', 'imagegen_config.py').load_config().get('strata', {}).get('url')
    return (url or 'http://127.0.0.1:8090').rstrip('/')


def edit_request(job):
    # Strataの画像APIは設定済みのQwenモデルでしか動かないので、jobのモデルが設定と同じかを確かめる。
    qwen = load_sibling('imagegen_config', 'imagegen_config.py').load_config()['qwen']
    expected = {key: Path(qwen[key]).name for key in ('unet', 'clip', 'vae')}
    if any(job.get(key) != value for key, value in expected.items()):
        raise ValueError('このStrata編集経路は設定済みのQwen 2.1モデル専用です。jobのモデル指定を確認してください。')
    seeds, outs = job['seeds'], job['outs']
    if not isinstance(seeds, list) or not 1 <= len(seeds) <= 4 or not isinstance(outs, list) or len(outs) != len(seeds):
        raise ValueError('seedsとoutsは同じ長さ（1..4）の配列にしてください。')
    if any(isinstance(s, bool) or not isinstance(s, int) for s in seeds) or seeds != list(range(seeds[0], seeds[0] + len(seeds))):
        raise ValueError('Strata経路のseedsは連番にしてください。')
    refs = job.get('references')
    if not isinstance(refs, list) or not 1 <= len(refs) <= 2:
        raise ValueError('referencesは1枚か2枚にしてください。')
    references = []
    for ref in refs:
        path = Path(ref['path'])
        if path.stat().st_size > 8 * 1024**2:
            raise ValueError(f'参照画像は1枚8MiBまでです: {path}')
        item = {'b64_json': base64.b64encode(path.read_bytes()).decode('ascii')}
        if 'size' in ref:
            item['size'] = ref['size']
        references.append(item)
    return dict(prompt=job['prompt'], negative_prompt=job['negative'],
                size=f"{job['width']}x{job['height']}", n=len(seeds), seed=seeds[0],
                steps=job['steps'], cfg_scale=job['cfg'], sampler=job['sampler'], scheduler=job['scheduler'],
                response_format='b64_json', references=references)


def main():
    job = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
    result_path = Path(job['result'])
    if result_path.exists():
        raise FileExistsError(f'結果JSONが既に存在します: {result_path}')
    try:
        base = strata_base()
        with urllib.request.urlopen(base + '/health', timeout=5) as response:
            health = json.load(response)
        # 古いサーバは未知のreferencesを無視するため、画像生成能力だけでは編集を許可しない。
        if health.get('service') != 'strata' or not health.get('image_editing'):
            raise RuntimeError('稼働中のStrataは参照画像編集に未対応です。画像APIの更新を反映してください。')
        body = edit_request(job)
        client = load_sibling('strata_image_client', 'gen-image-strata-client.py')
        client.generate(body, Path(job['outs'][0]).parent, base=base, emit_events=False,
                        output_paths=job['outs'], result_path=result_path)
        return 0
    except Exception as error:
        message = error.read().decode('utf-8', errors='replace') if isinstance(error, urllib.error.HTTPError) else str(error)
        result_path.write_text(json.dumps({'ok': False, 'backend': 'strata', 'error': message}, ensure_ascii=False, indent=2), encoding='utf-8')
        print(message, file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())

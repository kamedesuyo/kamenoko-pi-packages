import argparse
import datetime
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
import base64
import os


def read_events(response):
    data = []
    for raw in response:
        line = raw.decode('utf-8').rstrip('\r\n')
        if not line:
            if data:
                yield json.loads('\n'.join(data))
                data = []
        elif line.startswith('data:'):
            data.append(line[5:].lstrip(' '))
    if data:
        yield json.loads('\n'.join(data))


def generate(body, out_dir, base='http://127.0.0.1:8090', emit_events=True, output_paths=None, result_path=None):
    started = time.monotonic()
    if output_paths is not None:
        if len(output_paths) != body.get('n', 1) or len({os.path.normcase(str(Path(p).resolve())) for p in output_paths}) != len(output_paths):
            raise ValueError('出力先の数または重複が不正です。')
        if any(Path(path).exists() for path in output_paths):
            raise FileExistsError('出力画像が既に存在します。')
    if result_path and Path(result_path).exists():
        raise FileExistsError('結果JSONが既に存在します。')
    body = {**body, 'stream': True}
    request = urllib.request.Request(base + '/v1/images/generations',
                                     data=json.dumps(body).encode('utf-8'),
                                     headers={'Content-Type': 'application/json', 'Accept': 'text/event-stream'})
    result = None
    with urllib.request.urlopen(request, timeout=1300) as response:
        if response.headers.get_content_type() == 'text/event-stream':
            for event in read_events(response):
                if event.get('type') == 'error':
                    raise RuntimeError(event.get('message', '画像生成に失敗しました'))
                if event.get('type') == 'completed':
                    result = event['response']
                    break
                if event.get('type') == 'progress':
                    if emit_events:
                        print('QWEN_EVENT ' + json.dumps(event, ensure_ascii=True), flush=True)
                    else:
                        labels = {'queued': '順番待ち・GPU準備', 'loading': 'モデル読込', 'encoding': '文章処理',
                                  'sampling': '描画', 'decoding': '画像展開', 'saving': '保存', 'restoring': 'LLM・会話の復帰'}
                        label = labels.get(event.get('phase'), '画像生成')
                        step = f" {event['step']}/{event['steps']} step" if 'step' in event else ''
                        print(f'{label}{step} ({time.monotonic() - started:.0f}秒)', flush=True)
            if result is None:
                raise RuntimeError('完了通知の前に画像ストリームが切断されました。自動再生成は行いません。')
        else:
            # 再起動前のStrataでも一度の要求で従来の完成画像を受け取れる。
            print('途中表示: Strataの更新反映後に有効になります。今回は完成画像を待ちます。', flush=True)
            result = json.load(response)
    items = result.get('data', [])
    if len(items) != body.get('n', 1):
        raise RuntimeError('画像APIから返った枚数が要求と異なります。')
    pngs = [base64.b64decode(item['b64_json'], validate=True) for item in items]
    if any(not png.startswith(b'\x89PNG\r\n\x1a\n') for png in pngs):
        raise RuntimeError('画像APIの応答がPNGではありません。')
    folder = Path(out_dir)
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    paths = []
    for index, (png, item) in enumerate(zip(pngs, items), 1):
        import re
        label = re.sub(r'[^\w.-]', '_', str(body.get('profile') or 'qwen21'))[:80]
        path = Path(output_paths[index - 1]) if output_paths is not None else folder / f'{stamp}-{label}-{index}.png'
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as output:
            output.write(png)
        paths.append(path)
        print(f"画像: {path}（seed {item['seed']}）", flush=True)
    print(f'[2/2] Strataの会話復帰まで完了。全体 {time.monotonic() - started:.1f} 秒', flush=True)
    if result_path:
        with Path(result_path).open('x', encoding='utf-8') as output:
            json.dump({'ok': True, 'backend': 'strata', 'gpu_released': True,
                       'files': [{'path': str(p), 'seed': item['seed']} for p, item in zip(paths, items)],
                       'timings': result.get('strata', {}).get('timings', {}),
                       'strata': result.get('strata', {}), 'total_seconds': time.monotonic() - started},
                      output, ensure_ascii=False, indent=2)
    return paths


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--out-dir', required=True)
    parser.add_argument('--events', action='store_true')
    parser.add_argument('--base', default='http://127.0.0.1:8090', help='Strata の URL')
    args = parser.parse_args()
    try:
        generate(json.loads(Path(args.request).read_text(encoding='utf-8-sig')), args.out_dir,
                 base=args.base.rstrip('/'), emit_events=args.events)
    except urllib.error.HTTPError as error:
        print(error.read().decode('utf-8', errors='replace'), file=sys.stderr, flush=True)
        return 1
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

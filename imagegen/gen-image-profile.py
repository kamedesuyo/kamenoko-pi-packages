"""登録profileを選び、Strata画像APIの管理下で生成するCLI。"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from imagegen_profiles import read_registry, list_profiles, prepare


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config')
    parser.add_argument('--profile')
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--prompt')
    parser.add_argument('--size')
    parser.add_argument('--count', type=int)
    parser.add_argument('--seed', type=int)
    parser.add_argument('--steps', type=int)
    parser.add_argument('--negative-prompt')
    parser.add_argument('--base')
    parser.add_argument('--result')
    args = parser.parse_args()
    config, base_dir = read_registry(args.config)
    if args.list:
        print(json.dumps(list_profiles(config), ensure_ascii=False, indent=2))
        return
    req = {'prompt': args.prompt if args.prompt is not None else os.environ.get('GEN_IMAGE_PROMPT'), 'response_format': 'b64_json'}
    for key, value in {'profile': args.profile, 'size': args.size, 'n': args.count,
                       'seed': args.seed, 'steps': args.steps, 'negative_prompt': args.negative_prompt if args.negative_prompt is not None else os.environ.get('GEN_IMAGE_NEGATIVE')}.items():
        if value is not None:
            req[key] = value
    selected = prepare(req, args.config)
    req['profile'] = selected['request']['profile']
    base = args.base or os.environ.get('IMAGEGEN_STRATA_URL') or config.get('strata', {}).get('url')
    if not base:
        raise ValueError('Strata URLを--base / IMAGEGEN_STRATA_URL / strata.urlに設定してください')
    with urllib.request.urlopen(base.rstrip('/') + '/health', timeout=10) as response:
        health = json.load(response)
    if not health.get('image_profiles'):
        raise ValueError('稼働中のStrataはprofile画像APIに未対応です。設定とbridgeを確認してください')
    source = Path(__file__).with_name('gen-image-strata-client.py')
    spec = importlib.util.spec_from_file_location('strata_client', source)
    client = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(client)
    output = Path(config.get('outputDir', str(Path.home() / 'Pictures' / 'imagegen')))
    if not output.is_absolute():
        output = base_dir / output
    client.generate(req, str(output), base.rstrip('/'), result_path=args.result)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        sys.exit(1)

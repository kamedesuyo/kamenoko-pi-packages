"""Strata FIFO内で登録済みprofileを実行する。--prepareはGPUに触れない。"""
import argparse
import asyncio
import copy
import importlib.util
import json
import os
from pathlib import Path
import runpy
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from imagegen_profiles import bind, prepare, read_registry, list_profiles


def event(phase, **fields):
    print('\nQWEN_EVENT ' + json.dumps({'type': 'progress', 'phase': phase, **fields}), flush=True)


def shared_runtime():
    source = Path(__file__).with_name('gen-image-qwen21-runner.py')
    spec = importlib.util.spec_from_file_location('imagegen_runtime', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def workflow_job(job):
    started = time.monotonic()
    runtime = shared_runtime()
    runtime.no_power_throttling()
    runtime.acquire_image_mutex(job)
    runtime.configure_gpu(job)
    runtime.start_memory_guard(job)
    bundled = (Path(sys.executable).parent / '..' / 'ComfyUI').resolve()
    sys.path = [p for p in sys.path if Path(p or '.').resolve() != bundled]
    sys.path[:0] = [job['site_dir'], job['comfy_dir']]
    os.chdir(job['comfy_dir'])
    import shlex
    sys.argv = [sys.argv[0], '--disable-all-custom-nodes', '--disable-assets'] + shlex.split(job['comfy_args'])
    import comfy.options
    comfy.options.enable_args_parsing()
    import folder_paths
    for folder, paths in job['model_paths'].items():
        for path in paths:
            folder_paths.add_model_folder_path(folder, path)
    import nodes
    import execution
    import torch
    import comfy.utils
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo
    import numpy as np

    async def init():
        await nodes.init_extra_nodes(init_custom_nodes=False, init_api_nodes=False)
        for path in job['custom_nodes']:
            if not await nodes.load_custom_node(path):
                raise RuntimeError(f'custom nodeを読み込めません: {path}')
    event('loading')
    asyncio.run(init())
    destination = None
    current_seed = None

    class Output:
        @classmethod
        def INPUT_TYPES(cls):
            return {'required': {'images': ('IMAGE',)}}
        RETURN_TYPES = ()
        OUTPUT_NODE = True
        FUNCTION = 'save'
        CATEGORY = 'imagegen'

        def save(self, images):
            if len(images) != 1:
                raise ValueError('1回のworkflow実行の出力は1枚にしてください')
            picture = Image.fromarray(np.clip(images[0].cpu().numpy() * 255, 0, 255).astype(np.uint8))
            if picture.size != (job['width'], job['height']):
                raise ValueError(f'workflowの出力寸法が要求と異なります: {picture.size}')
            info = PngInfo()
            info.add_text('imagegen', json.dumps({'profile': job['profile'], 'seed': current_seed, 'prompt': job['prompt']}, ensure_ascii=False))
            picture.save(destination, pnginfo=info, compress_level=4)
            return {}

    class Server:
        client_id = None
        last_node_id = None
        def send_sync(self, name, data, *args):
            if name == 'execution_error':
                print(json.dumps(data, default=str), file=sys.stderr, flush=True)

    nodes.NODE_CLASS_MAPPINGS['ImagegenOutput'] = Output
    files = []
    for index, (seed, path) in enumerate(zip(job['seeds'], job['outs']), 1):
        destination, current_seed = path, seed
        values = {**job, 'seed': seed, 'negative_prompt': job['negative'], 'cfg_scale': job['cfg'], **job['model_values']}
        graph = bind(copy.deepcopy(job['workflow']), job['bindings'], values)
        output = job['output_node']
        graph[output] = {'class_type': 'ImagegenOutput', 'inputs': {'images': graph[output]['inputs']['images']}}
        valid = asyncio.run(execution.validate_prompt(str(seed), graph, [output]))
        if not valid[0]:
            raise ValueError(f'workflowの検証に失敗: {valid[1:]}')
        def progress(value, total, preview=None, **kwargs):
            fields = dict(index=index, count=len(job['seeds']), step=value, steps=total)
            if preview:
                import io
                import base64
                picture = preview[1].copy()
                picture.thumbnail((384, 384))
                buffer = io.BytesIO()
                picture.save(buffer, format='PNG')
                fields['preview'] = base64.b64encode(buffer.getvalue()).decode('ascii')
            event('sampling', **fields)
        comfy.utils.set_progress_bar_global_hook(progress)
        executor = execution.PromptExecutor(Server(), cache_type=execution.CacheType.NONE,
                                           cache_args={'ram': 0, 'ram_inactive': 0})
        with torch.inference_mode():
            executor.execute(graph, str(seed), {'preview_method': 'latent2rgb'}, [output])
        if not executor.success or not Path(path).is_file():
            raise RuntimeError(f'workflow実行に失敗: {executor.status_messages}')
        files.append({'path': path, 'seed': seed})
        del executor
    result = {'ok': True, 'files': files, 'profile': job['profile'], 'timings': {'total': round(time.monotonic()-started, 3)}}
    Path(job['result']).write_text(json.dumps(result), encoding='utf-8')
    print(json.dumps(result), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('job', nargs='?')
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--config')
    args = parser.parse_args()
    if args.prepare:
        print(json.dumps(prepare(json.load(sys.stdin), args.config), ensure_ascii=False))
        return
    if args.list:
        print(json.dumps(list_profiles(read_registry(args.config)[0]), ensure_ascii=False, indent=2))
        return
    job = json.loads(Path(args.job).read_text(encoding='utf-8-sig'))
    if not job.get('strata_managed'):
        raise ValueError('profile runnerはStrata画像FIFOから起動してください')
    if job['adapter'] == 'qwen21':
        sys.argv = [str(Path(__file__).with_name('gen-image-qwen21-runner.py')), args.job]
        runpy.run_path(sys.argv[0], run_name='__main__')
    else:
        workflow_job(job)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        import traceback
        traceback.print_exc()
        sys.exit(1)

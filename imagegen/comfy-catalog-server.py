"""既存ComfyUIのノード・モデルを、CUDAを使わず公式HTTP APIで公開する。"""
import argparse
import os
from pathlib import Path
import runpy
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from imagegen_config import load_config


def catalog_path_allowed(method, path):
    if method not in ('GET', 'HEAD'):
        return False
    return path in ('/', '/catalog_info', '/system_stats', '/features', '/prompt', '/queue', '/history', '/models', '/object_info') or path.startswith(('/object_info/', '/models/', '/history/'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config')
    parser.add_argument('--port', type=int, required=True)
    opts = parser.parse_args()
    config = load_config(opts.config)
    from imagegen_config import config_path
    base = Path(opts.config or config_path()).resolve().parent
    def configured_path(path):
        result = Path(path)
        return str((base / result).resolve() if not result.is_absolute() else result)
    comfy_config = config.get('comfy', {})
    if comfy_config:
        comfy_root = Path(configured_path(comfy_config['dir']))
        site_dir = configured_path(comfy_config.get('siteDir', str(comfy_root)))
        custom_nodes = [configured_path(p) for p in comfy_config.get('customNodes', [])]
    else:
        root = Path(config['qwen']['root'])
        comfy_root, site_dir = root / 'ComfyUI', str(root / 'site')
        custom_nodes = [str(config['qwen'].get('gguf_dir', root / 'ComfyUI-GGUF'))]
    os.environ['CUDA_VISIBLE_DEVICES'] = ''
    os.environ['DO_NOT_TRACK'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    bundled = (Path(sys.executable).parent / '..' / 'ComfyUI').resolve()
    here = Path(__file__).parent.resolve()
    sys.path = [p for p in sys.path if Path(p or '.').resolve() not in (bundled, here)]
    sys.path[:0] = [site_dir, str(comfy_root)]
    os.chdir(comfy_root)
    sys.argv = [str(comfy_root / 'main.py'), '--cpu', '--listen', '127.0.0.1', '--port', str(opts.port),
                '--offline', '--disable-assets', '--disable-all-custom-nodes', '--disable-auto-launch']
    import comfy.options
    comfy.options.enable_args_parsing()
    import folder_paths
    for key, folder in (('unet', 'diffusion_models'), ('clip', 'text_encoders'), ('vae', 'vae')):
        if config.get('qwen', {}).get(key):
            folder_paths.add_model_folder_path(folder, str(Path(config['qwen'][key]).parent))
    for folder, paths in comfy_config.get('modelPaths', {}).items():
        for path in paths:
            folder_paths.add_model_folder_path(folder, configured_path(path))
    for profile in config.get('profiles', {}).values():
        for model in profile.get('models', {}).values():
            folder_paths.add_model_folder_path(model['folder'], str(Path(configured_path(model['path'])).parent))
    if config.get('sdxl', {}).get('checkpoint'):
        folder_paths.add_model_folder_path('checkpoints', str(Path(config['sdxl']['checkpoint']).parent))
    for folder, paths in config.get('comfyMcp', {}).get('modelPaths', {}).items():
        for path in paths:
            folder_paths.add_model_folder_path(folder, path)

    import nodes
    original_init_nodes = nodes.init_extra_nodes

    async def init_nodes(*args, **kwargs):
        # 実行runnerが使うGGUF以外の拡張を調査だけで起動しない。
        kwargs['init_custom_nodes'] = False
        kwargs['init_api_nodes'] = False
        result = await original_init_nodes(*args, **kwargs)
        for custom in custom_nodes:
            if not await nodes.load_custom_node(custom):
                raise RuntimeError(f'Custom node import failed: {custom}')
        return result

    nodes.init_extra_nodes = init_nodes
    import server
    from aiohttp import web
    original_server_init = server.PromptServer.__init__

    @web.middleware
    async def catalog_only(request, handler):
        if not catalog_path_allowed(request.method, request.path):
            return web.json_response({'error': 'catalog_only', 'message':
                'Use pi generate_image_qwen for Strata-managed sleep/generate/wake. Workflow execution is not enabled on this discovery server.'}, status=403)
        if request.path in ('/', '/catalog_info'):
            return web.json_response({'mode': 'catalog_only', 'cuda_enabled': False,
                'execution': 'pi.generate_image -> Strata images FIFO',
                'custom_nodes': custom_nodes, 'comfy_root': str(comfy_root)})
        return await handler(request)

    def init_server(self, *args, **kwargs):
        original_server_init(self, *args, **kwargs)
        self.app.middlewares.insert(0, catalog_only)

    server.PromptServer.__init__ = init_server
    runpy.run_path(str(comfy_root / 'main.py'), run_name='__main__')


if __name__ == '__main__':
    main()

"""利用者が登録した生成プロファイルを、実行前に固定したjobへ解決する。"""
import copy
import json
import math
from pathlib import Path
import re

from imagegen_config import config_path, load_config

FIELDS = {'prompt', 'negative_prompt', 'size', 'steps', 'cfg_scale', 'sampler', 'scheduler', 'seed',
          'n', 'stream', 'response_format', 'references', 'profile', 'output_format'}
DEFAULTS = {'size': '1024x1024', 'steps': 20, 'cfg_scale': 1.0, 'sampler': 'euler',
            'scheduler': 'normal', 'negative_prompt': ''}


def read_registry(path=None):
    path = Path(path or config_path()).resolve()
    return load_config(path), path.parent


def local_path(value, base, directory=False):
    if not isinstance(value, str) or not value:
        raise ValueError('設定にローカルパスが必要です')
    p = Path(value).expanduser()
    p = (base / p).resolve() if not p.is_absolute() else p.resolve()
    if not (p.is_dir() if directory else p.is_file()):
        raise ValueError(f'ローカルファイルまたはフォルダがありません: {p}')
    return str(p)


def list_profiles(config):
    profiles = config.get('profiles', {})
    return {'default': config.get('defaultProfile'), 'profiles': [
        {'id': key, 'label': p.get('label', key), 'description': p.get('description', ''),
         'adapter': p.get('adapter'), 'defaults': p.get('defaults', {})}
        for key, p in profiles.items()]}


def bind(graph, bindings, values):
    for name, targets in bindings.items():
        if name not in values:
            raise ValueError(f'未対応のbinding: {name}')
        if not isinstance(targets, list) or not targets:
            raise ValueError(f'bindingは[node ID, input名]の配列です: {name}')
        for target in targets:
            if not isinstance(target, list) or len(target) != 2:
                raise ValueError(f'不正なbinding: {name}')
            node, field = map(str, target)
            if node not in graph or field not in graph[node].get('inputs', {}):
                raise ValueError(f'binding先がありません: {name} -> {node}.{field}')
            graph[node]['inputs'][field] = values[name]
    return graph


def prepare(req, path=None):
    config, base = read_registry(path)
    identifier = req.get('profile') or config.get('defaultProfile')
    if not isinstance(identifier, str) or not re.fullmatch(r'[\w.-]{1,80}', identifier):
        raise ValueError('登録済みのprofile IDを指定してください')
    profiles = config.get('profiles', {})
    if identifier not in profiles:
        raise ValueError(f'未登録のprofile: {identifier}（list_image_profilesで確認）')
    profile = copy.deepcopy(profiles[identifier])
    adapter = profile.get('adapter')
    if adapter not in ('qwen21', 'workflow'):
        raise ValueError(f'未対応のadapter: {adapter}')
    unknown = set(req) - FIELDS
    if unknown:
        raise ValueError(f'未対応の引数: {sorted(unknown)}')
    defaults = profile.get('defaults', {})
    if set(defaults) - set(DEFAULTS):
        raise ValueError('defaultsにはsize/steps/cfg_scale/sampler/scheduler/negative_promptのみ指定できます')
    request = {**DEFAULTS, **defaults, **req, 'profile': identifier}
    runtime = profile.get('runtime', {})
    comfy = config.get('comfy', {})
    payload = {'adapter': adapter, 'profile': identifier,
               'comfy_dir': local_path(comfy.get('dir'), base, True),
               'site_dir': local_path(comfy.get('siteDir', comfy.get('dir')), base, True),
               'custom_nodes': [local_path(p, base, True) for p in comfy.get('customNodes', [])],
               'model_paths': {k: [local_path(p, base, True) for p in paths]
                               for k, paths in comfy.get('modelPaths', {}).items()},
               'comfy_args': runtime.get('comfy_args', ''),
               'gpu_uuids': runtime.get('gpu_uuids', []),
               'min_free_vram_mib': runtime.get('min_free_vram_mib', []),
               'min_free_ram_gib': runtime.get('min_free_ram_gib', 3),
               'profile_managed': True}
    value = payload['min_free_ram_gib']
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError('min_free_ram_gibは正の有限数です')
    devices = payload['gpu_uuids']
    if not isinstance(devices, list) or any(not isinstance(v, str) or not v.startswith('GPU-') for v in devices) or len(devices) != len(set(devices)):
        raise ValueError('gpu_uuidsは重複しないGPU UUIDの配列です')
    models = {}
    for key, model in profile.get('models', {}).items():
        location = Path(local_path(model.get('path'), base))
        folder = model.get('folder')
        if not isinstance(folder, str) or not folder:
            raise ValueError(f'models.{key}.folderにComfyUIの分類名が必要です')
        payload['model_paths'].setdefault(folder, []).append(str(location.parent))
        models[key] = location
    if adapter == 'qwen21':
        if not {'unet', 'clip', 'vae'} <= models.keys():
            raise ValueError('qwen21 adapterはunet/clip/vaeを必要とします')
        payload['gguf_dir'] = local_path(profile.get('ggufDir'), base, True)
        payload['defer_unet_load'] = True
        payload['text_encoder_device'] = runtime.get('text_encoder_device', 'cpu')
        if not re.fullmatch(r'cpu|cuda:\d+', payload['text_encoder_device']):
            raise ValueError('text_encoder_deviceはcpuまたはcuda:Nです')
        for key in ('unet', 'clip', 'vae'):
            payload[key], payload[key + '_dir'] = models[key].name, str(models[key].parent)
    else:
        if req.get('references'):
            raise ValueError('workflow adapterの参照画像bindingは未対応です')
        workflow = local_path(profile.get('workflow'), base)
        graph = json.loads(Path(workflow).read_text(encoding='utf-8-sig'))
        if not isinstance(graph, dict) or not graph or any(not isinstance(n, dict) or 'class_type' not in n or not isinstance(n.get('inputs'), dict) for n in graph.values()):
            raise ValueError('ComfyUIのAPI形式workflow JSONを指定してください（画面用JSONは不可）')
        bindings = profile.get('bindings', {})
        if not {'prompt', 'width', 'height', 'seed'} <= bindings.keys():
            raise ValueError('workflowにはprompt/width/height/seedのbindingが必要です')
        for key in ('negative_prompt', 'steps', 'cfg_scale', 'sampler', 'scheduler'):
            if (key in req or key in defaults) and key not in bindings:
                raise ValueError(f'このworkflowには{key}のbindingがありません')
        output = str(profile.get('outputNode', ''))
        if graph.get(output, {}).get('class_type') != 'SaveImage':
            raise ValueError('outputNodeにはSaveImageノードのIDを指定してください')
        payload.update(workflow=graph, bindings=bindings, output_node=output,
                       model_values={'model.' + k: p.name for k, p in models.items()})
        # 不正なbindingはGPUの休眠より前に見つける。
        bind(copy.deepcopy(graph), bindings, {**request, 'width': 1024, 'height': 1024, 'seed': req.get('seed', 0), **payload['model_values']})
    return {'request': request, 'payload': payload}

"""gen-image-qwen21.ps1 から呼ぶ Qwen-Image 2.1 生成の本体。ComfyUI のノードを、サーバを立てずに直接呼ぶ（gen-image-runner.py と同じ作り）。

Qwen-Image 2.1 は ComfyUI 0.37 以降にしか無い（TextEncodeQwenImage21 とモデル定義）。SDXL 用の
ComfyUI portable（設定 comfyPython、0.31.1）を上げると動いている gen-image を巻き込むので、python_embeded だけ共有し、
コードは <qwen.root>\\ComfyUI（0.42.4）を使う。新しいコードが要求する comfy_kitchen 0.2.39 / comfy_aimdo 0.5.6 は
<qwen.root>\\site に入れてあり、python_embeded の site-packages より前に差す。
DiT は GGUF なので ComfyUI-GGUF の leejet 版（<qwen.root>\\ComfyUI-GGUF）で読む。city96 版は 2.1 の構造を知らない。

流れ: job を受け取る → go を待つ → ComfyUI を import → 3 つのモデルを組み立てる → テキストエンコード → 描く → 保存 → VRAM を返す → 結果。
go は呼び出し元が GPU の準備を終えた合図。Strata は VRAM のみ縮小し、旧経路は LLM を停止する。
結果は1行の JSON で job の result ファイルと標準出力へ出す。gen-image-runner.py の待機役は使わない（下の import_comfy）。

使い方: python -s gen-image-qwen21-runner.py <job.json>
job.json: comfy_dir, site_dir, gguf_dir, unet_dir, unet, clip_dir, clip, vae_dir, vae, prompt, negative, seeds[], outs[],
          steps, cfg, sampler, scheduler, width, height, go, abort, result, timeline, comfy_args
"""
import importlib.util
import json
import os
import sys
import time

# 表示上のGPU番号は変わるため、CUDA初期化前にconfigure_gpuでUUIDを指定する。
os.environ['CUDA_DEVICE_ORDER'] = 'PCI_BUS_ID'
job = None
T0 = time.time()
timings = {}


def emit_progress(phase, **fields):
    if job and job.get('stream'):
        # tqdmは改行せずstderrへ描くため、結合された出力でも通知を独立した行にする。
        print('\nQWEN_EVENT ' + json.dumps({'type': 'progress', 'phase': phase, **fields},
                                      ensure_ascii=True), flush=True)


def install_preview_hook(index):
    if not job.get('stream'):
        return
    import base64
    import io
    import latent_preview
    from comfy.cli_args import LatentPreviewMethod
    # 追加モデルや毎stepのVAE展開で待ち時間を増やさない。
    latent_preview.args.preview_method = LatentPreviewMethod.Latent2RGB

    def update(value, total, preview=None, **_):
        fields = dict(index=index, count=len(job['seeds']), step=value, steps=total)
        if preview is not None:
            try:
                picture = preview[1].copy()
                picture.thumbnail((384, 384))
                buffer = io.BytesIO()
                picture.save(buffer, format='PNG')
                fields['preview'] = base64.b64encode(buffer.getvalue()).decode('ascii')
            except Exception:
                # 表示の失敗で完成画像の生成を止めない。
                pass
        emit_progress('sampling', **fields)

    comfy.utils.set_progress_bar_global_hook(update)


def acquire_image_mutex(image_job):
    if not image_job.get('strata_managed'):
        return None
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateMutexW(None, False, 'Local\\gen-image-llm')
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    # APIを直接呼ぶ場合もSDXLと競合させない。保持はCUDAを破棄するプロセス終了まで。
    if kernel.WaitForSingleObject(handle, 0) not in (0, 0x80):
        kernel.CloseHandle(handle)
        raise RuntimeError('別の画像生成が動いています。終了後に実行してください。')
    return handle


def configure_gpu(image_job):
    import csv
    import io
    import subprocess
    rows = list(csv.reader(io.StringIO(subprocess.check_output(
        ['nvidia-smi', '--query-gpu=uuid,name,memory.free', '--format=csv,noheader,nounits'],
        text=True, timeout=10))))
    available = {row[0].strip(): (row[1].strip(), int(row[2])) for row in rows if len(row) == 3}
    wanted = image_job.get('gpu_uuids')
    if image_job.get('profile_managed'):
        if wanted:
            for index, uuid in enumerate(wanted):
                if uuid not in available:
                    raise RuntimeError(f'GPU UUIDがありません: {uuid}')
                minimums = image_job.get('min_free_vram_mib', [])
                if index < len(minimums) and available[uuid][1] < minimums[index]:
                    raise RuntimeError(f'画像生成に必要な空きVRAMがありません: {available[uuid]}')
            os.environ['CUDA_VISIBLE_DEVICES'] = ','.join(wanted)
        return wanted
    if not wanted:
        wanted = [u for u, (name, _) in available.items() if name == 'NVIDIA GeForce RTX 5060 Ti']
    expected = ['NVIDIA GeForce RTX 5060 Ti', 'NVIDIA GeForce RTX 4060'] if image_job.get('strata_managed') else ['NVIDIA GeForce RTX 5060 Ti']
    if len(wanted) != len(expected) or len(set(wanted)) != len(wanted):
        raise RuntimeError('Qwen生成用GPUの数またはUUIDが不正です')
    for uuid, name in zip(wanted, expected):
        if uuid not in available or available[uuid][0] != name:
            raise RuntimeError(f'GPU UUIDと機種が一致しません: {name}')
    if image_job.get('strata_managed'):
        for uuid, minimum in zip(wanted, (6144, 5120)):
            if available[uuid][1] < minimum:
                raise RuntimeError(f'画像生成に必要な空きVRAMがありません: {available[uuid]}')
    os.environ['CUDA_VISIBLE_DEVICES'] = ','.join(wanted)
    return wanted


def available_memory():
    import ctypes
    class Status(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(name, ctypes.c_ulonglong) for name in
                    ('total_phys', 'avail_phys', 'total_page', 'avail_page', 'total_virtual', 'avail_virtual', 'avail_extended')]
    status = Status()
    status.length = ctypes.sizeof(status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise OSError('メモリ使用量を取得できません')
    return status.avail_phys, status.avail_page


def memory_reserve_gib(image_job):
    import math
    from pathlib import Path
    value = image_job.get('min_free_ram_gib', os.environ.get('IMAGEGEN_MIN_FREE_RAM_GIB'))
    if value is None:
        spec = importlib.util.spec_from_file_location('imagegen_config', Path(__file__).with_name('imagegen_config.py'))
        config_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(config_module)
        config = config_module.load_config() if config_module.config_path().exists() else {}
        value = config.get('qwen', {}).get('min_free_ram_gib', 3)
    if isinstance(value, bool):
        raise ValueError('min_free_ram_gibには正の有限数を指定してください')
    value = float(value)
    if not math.isfinite(value) or value <= 0:
        raise ValueError('min_free_ram_gibには正の有限数を指定してください')
    return value


def start_memory_guard(image_job):
    if not image_job.get('strata_managed'):
        return
    import threading
    reserve_gib = memory_reserve_gib(image_job)
    print(f'Memory guard: free RAM >= {reserve_gib:g} GiB, free commit >= 3 GiB', flush=True)
    def watch():
        low = 0
        while True:
            time.sleep(1)
            free, commit = available_memory()
            low = low + 1 if free < reserve_gib * 1024**3 or commit < 3 * 1024**3 else 0
            if low >= 2:
                # 自分だけを終了し、親のStrata FIFOがVRAMを戻せるようにする。
                print(f'空きRAM {free / 1024**3:.2f}GiB（下限{reserve_gib:g}GiB）、'
                      f'空きcommit {commit / 1024**3:.2f}GiB（下限3GiB）：'
                      'メモリ下限を割ったため画像生成を中止します', file=sys.stderr, flush=True)
                os._exit(75)
    threading.Thread(target=watch, daemon=True).start()


def no_power_throttling():
    # Windows は窓の無いバックグラウンドのプロセスを省電力側（EcoQoS）へ絞ることがある（gen-image-runner.py と同じ）。
    try:
        import ctypes
        from ctypes import wintypes

        class PowerThrottlingState(ctypes.Structure):
            _fields_ = [('Version', wintypes.ULONG), ('ControlMask', wintypes.ULONG), ('StateMask', wintypes.ULONG)]

        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.SetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        state = PowerThrottlingState(1, 0x1, 0)
        k32.SetProcessInformation(k32.GetCurrentProcess(), 4, ctypes.byref(state), ctypes.sizeof(state))
        k32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k32.SetPriorityClass(k32.GetCurrentProcess(), 0x20)
    except Exception:
        pass


def mark(label):
    path = os.environ.get('LLM_TIMELINE')
    if path:
        t = time.time()
        stamp = time.strftime('%H:%M:%S', time.localtime(t)) + '.%03d' % int((t % 1) * 1000)
        try:
            with open(path, 'a', encoding='ascii') as f:
                f.write('%s\t%s\n' % (stamp, label))
        except OSError:
            pass


def finish(result, code):
    line = json.dumps(result, ensure_ascii=False)
    if job and job.get('result'):
        tmp = job['result'] + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(line + '\n')
        os.replace(tmp, job['result'])
    sys.stdout.write(line + '\n')
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


def fail(message, code=1):
    import traceback
    traceback.print_exc()
    finish({'ok': False, 'error': message, 'timings': timings, 'gpu_released': release_gpu()}, code)


def import_comfy(comfy_args, comfy_dir, site_dir):
    # 待機役（gen-image-runner.py --warm）に相乗りしないのは、あちらが ._pth の 0.31.1 を前提にしているのと、
    # 縮むのが import の 4 秒ほどで、このモデルの読み込み（D: の HDD から 14GB）に比べて小さいため。
    global torch, folder_paths, nodes, comfy, Image, PngInfo, np
    # ._pth が入れた 0.31.1 を外す。残すと、新しい側に無いモジュールだけ古い側から読まれて混ざる。
    # comfy_aimdo は __init__.py の無い名前空間パッケージなので、site_dir を先に置けば新しい版のファイルが勝つ。
    bundled = os.path.normcase(os.path.abspath(os.path.join(os.path.dirname(sys.executable), '..', 'ComfyUI')))
    sys.path = [p for p in sys.path if os.path.normcase(os.path.abspath(p)) != bundled]
    sys.path[0:0] = [site_dir, comfy_dir]
    import torch
    import comfy.options
    comfy.options.enable_args_parsing()
    sys.argv = [sys.argv[0]] + comfy_args.split()
    import folder_paths
    import comfy.model_management
    mark('runner.model_management')
    import nodes
    import comfy.sd
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo
    import numpy as np
    comfy.model_management.get_torch_device()
    if job.get('profile_managed'):
        print('Qwen GPU allocation: DiT/VAE=cuda:0; text encoder=' + job['text_encoder_device'], flush=True)
    elif job.get('strata_managed'):
        if torch.cuda.device_count() != 2 or '5060 Ti' not in torch.cuda.get_device_name(0) or torch.cuda.get_device_name(1) != 'NVIDIA GeForce RTX 4060':
            raise RuntimeError('CUDAのGPU割り当てが想定と異なります')
        print('Qwen GPU allocation: DiT/VAE=cuda:0 RTX 5060 Ti; text encoder=cuda:1 RTX 4060', flush=True)
    mark('runner.imported')


def load_diffusion(job):
    # custom node として登録はせず、ComfyUI-GGUF をパッケージとして読んでローダだけ使う。
    # テキストエンコーダと VAE は ComfyUI 標準のローダ。どれもまず CPU 側に置かれ、描く時に GPU へ移る。
    folder_paths.add_model_folder_path('diffusion_models', job['unet_dir'])
    folder_paths.add_model_folder_path('text_encoders', job['clip_dir'])
    folder_paths.add_model_folder_path('vae', job['vae_dir'])
    spec = importlib.util.spec_from_file_location('ComfyUI_GGUF', os.path.join(job['gguf_dir'], '__init__.py'),
                                                  submodule_search_locations=[job['gguf_dir']])
    gguf = importlib.util.module_from_spec(spec)
    sys.modules['ComfyUI_GGUF'] = gguf
    spec.loader.exec_module(gguf)
    t = time.time()
    with torch.inference_mode():
        model = gguf.NODE_CLASS_MAPPINGS['UnetLoaderGGUF']().load_unet(job['unet'])[0]
    timings['load_unet'] = round(time.time() - t, 2)
    mark('runner.unet_loaded')
    return model


def build(job):
    folder_paths.add_model_folder_path('text_encoders', job['clip_dir'])
    folder_paths.add_model_folder_path('vae', job['vae_dir'])
    # RAMにLLMを残す場合、TEとDiTの読み込みピークを重ねない。
    model = None if job.get('defer_unet_load') else load_diffusion(job)
    t = time.time()
    with torch.inference_mode():
        if job.get('strata_managed'):
            clip = comfy.sd.load_clip(
                ckpt_paths=[folder_paths.get_full_path_or_raise('text_encoders', job['clip'])],
                embedding_directory=folder_paths.get_folder_paths('embeddings'), clip_type=comfy.sd.CLIPType.QWEN_IMAGE,
                model_options={'load_device': torch.device(job.get('text_encoder_device', 'cuda:1')), 'offload_device': torch.device('cpu'),
                               'initial_device': torch.device('cpu')})
        else:
            clip = nodes.CLIPLoader().load_clip(job['clip'], 'qwen_image')[0]
        timings['load_te'] = round(time.time() - t, 2)
        mark('runner.te_loaded')
        t = time.time()
        vae = nodes.VAELoader().load_vae(job['vae'])[0]
        timings['load_vae'] = round(time.time() - t, 2)
    mark('runner.models_loaded')
    return model, clip, vae


def release_gpu():
    # gen-image-qwen21.ps1 がプロセスの終了を待たずに LLM を戻せるよう、結果を書く前に VRAM を返しておく。
    try:
        if 'comfy' not in globals():
            return True
        import gc
        for name in ('model', 'clip', 'vae', 'pos', 'neg', 'latent', 'samples', 'image', 'edit_latent', 'references', 'out'):
            globals().pop(name, None)
        comfy.model_management.current_loaded_models.clear()
        gc.collect()
        released = True
        for index in range(torch.cuda.device_count()):
            with torch.cuda.device(index):
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
                released = released and torch.cuda.memory_reserved() < (256 << 20)
        mark('runner.gpu_released' if released else 'runner.gpu_not_released')
        return released
    except Exception:
        return False


def main():
    global job, image_mutex, model, clip, vae, pos, neg, latent, samples, image, edit_latent, references, out
    no_power_throttling()
    job = json.load(open(sys.argv[1], encoding='utf-8-sig'))
    try:
        image_mutex = acquire_image_mutex(job)
        configure_gpu(job)
        start_memory_guard(job)
    except Exception as e:
        fail(str(e))
    if job.get('timeline'):
        os.environ['LLM_TIMELINE'] = job['timeline']
    mark('runner.job_received')
    seeds, outs = job['seeds'], job['outs']
    if len(seeds) != len(outs):
        finish({'ok': False, 'error': 'seeds と outs の数が違う'}, 2)

    t_wait = time.time()
    while not os.path.exists(job['go']):
        if os.path.exists(job['abort']):
            finish({'ok': False, 'error': 'aborted', 'gpu_released': release_gpu()}, 3)
        if time.time() - t_wait > 300:
            finish({'ok': False, 'error': 'go が 300 秒来なかった', 'gpu_released': release_gpu()}, 4)
        time.sleep(0.05)
    mark('runner.go')
    timings['wait_go'] = round(time.time() - t_wait, 2)

    try:
        emit_progress('loading')
        import_comfy(job.get('comfy_args', ''), job['comfy_dir'], job['site_dir'])
        timings['import'] = round(time.time() - T0, 2)
    except Exception as e:
        fail('import に失敗: %r' % e)

    try:
        model, clip, vae = build(job)
    except Exception as e:
        fail('モデルの読み込みに失敗: %r' % e)

    files = []
    try:
        with torch.inference_mode():
            from comfy_extras.nodes_qwen import TextEncodeQwenImage21
            t = time.time()
            emit_progress('encoding')
            edit_latent = None
            if job.get('references'):
                from PIL import ImageOps
                references = {}
                for index, ref in enumerate(job['references'], 1):
                    with Image.open(ref['path']) as source:
                        reference = ImageOps.exif_transpose(source).convert('RGB')
                        if ref.get('size'):
                            reference = reference.resize(tuple(ref['size']), Image.Resampling.LANCZOS)
                        if index == 1 and reference.size != (job['width'], job['height']):
                            raise ValueError('第1参照画像と出力の寸法が一致しません')
                        references[f'image_{index}'] = torch.from_numpy(np.asarray(reference).copy()).float().unsqueeze(0) / 255.0
                # 空latentへ置き換えると参照画像に対する編集位置がずれるため、ノードのlatentを保持する。
                out = TextEncodeQwenImage21.execute(clip, job['prompt'], job['negative'], vae=vae, resolution=0, images=references)
                edit_latent = out[2]
                references = None
            else:
                out = TextEncodeQwenImage21.execute(clip, job['prompt'], job['negative'], resolution=1024)
            pos, neg = out[0], out[1]
            # テキストエンコーダは一度使えば要らない。参照を外して ComfyUI の管理から落とせば、DiT を載せる時に
            # GPU から CPU へ書き戻すコピーが起きず、RAM も 8.7GB 空く。
            clip = out = None
            import gc
            gc.collect()
            comfy.model_management.cleanup_models()
            comfy.model_management.soft_empty_cache()
            timings['encode'] = round(time.time() - t, 2)
            mark('runner.encode_done')

            if model is None:
                emit_progress('loading')
                model = load_diffusion(job)

            for i, (seed, path) in enumerate(zip(seeds, outs)):
                t = time.time()
                emit_progress('sampling', index=i + 1, count=len(seeds), step=0, steps=job['steps'])
                install_preview_hook(i + 1)
                latent = edit_latent if edit_latent is not None else nodes.EmptyLatentImage().generate(job['width'], job['height'], 1)[0]
                samples = nodes.KSampler().sample(model, seed, job['steps'], job['cfg'], job['sampler'], job['scheduler'],
                                                  pos, neg, latent, denoise=1.0)[0]
                timings.setdefault('sample', []).append(round(time.time() - t, 2))
                timings['dit_loaded_mib'] = round(model.loaded_size() / 1024**2, 1)
                timings['dit_model_mib'] = round(model.model_size() / 1024**2, 1)
                mark('runner.sampled_%d' % (i + 1))
                comfy.utils.set_progress_bar_global_hook(None)

                t = time.time()
                emit_progress('decoding', index=i + 1, count=len(seeds))
                image = nodes.VAEDecode().decode(vae, samples)[0][0]
                timings.setdefault('decode', []).append(round(time.time() - t, 2))

                t = time.time()
                emit_progress('saving', index=i + 1, count=len(seeds))
                arr = np.clip(255.0 * image.cpu().numpy(), 0, 255).astype(np.uint8)
                info = PngInfo()
                info.add_text('parameters', '%s\nNegative prompt: %s\nSteps: %d, Sampler: %s, Schedule type: %s, CFG scale: %g, '
                                            'Seed: %d, Size: %dx%d, Model: %s' % (
                                  job['prompt'], job['negative'], job['steps'], job['sampler'], job['scheduler'], job['cfg'],
                                  seed, job['width'], job['height'], os.path.splitext(job['unet'])[0]))
                Image.fromarray(arr).save(path, pnginfo=info, compress_level=4)
                timings.setdefault('save', []).append(round(time.time() - t, 2))
                files.append({'path': path, 'seed': seed})
                mark('runner.saved_%d' % (i + 1))
    except Exception as e:
        import traceback
        traceback.print_exc()
        model = clip = vae = None
        finish({'ok': False, 'error': '生成に失敗: %r' % e, 'files': files, 'timings': timings, 'gpu_released': release_gpu()}, 1)

    timings['total'] = round(time.time() - T0, 2)
    model = vae = None
    finish({'ok': True, 'files': files, 'timings': timings, 'gpu_released': release_gpu()}, 0)


if __name__ == "__main__":
    main()

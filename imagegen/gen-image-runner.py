"""gen-image.ps1 から呼ぶ SDXL 生成の本体。ComfyUI のノードを、サーバを立てずに直接呼ぶ。

設定 comfyPython が指す ComfyUI portable の python_embeded で動かす（._pth で ComfyUI が sys.path に入る）。
サーバ版より速い（DB・Web 画面・API ノード・HTTP での完了待ちが無い）。ノードの処理は同じなので、同じ設定と seed なら同じ絵になる。

流れ: job を受け取る → go と LLM の停止を確認 → ComfyUI を import → checkpoint を組み立てる → CLIP → 描く → 保存 → VRAM を返す → 結果。
go は gen-image.ps1 の開始合図。共有GPUではLLM停止、専用4060ではGPUのUUIDを確認してからimportする。
abort ファイルが現れたら何もせずに終わる。結果は1行の JSON で job の result ファイルと標準出力へ出す。

待機モード（--warm）: gen-image.ps1 が生成の終わりに pythonw で起動しておき、次の生成で使う。
  外部ライブラリ（torch・transformers など）だけを読んで、作業フォルダに warm.job が置かれるのを待つ（import 5 秒のうち 3.6 秒ぶん）。
  CUDA にはまだ触らないので VRAM を使わない（初期化だけで 141MiB 取り、LLM の余裕 約 1GB を削るため）。3 時間何も来なければ自分で終わる。
  LLM が generate_image を書き始めた時点で ComfyUI の import と checkpoint の組み立てまで先に済ませる手も試したが、
  LLM の生成中に CUDA の初期化と 6.5GB の組み立てを重ねると、LLM の生成・停止、CLIP（0.2→3.1 秒）、描画がそろって
  遅くなり、全体では悪化した（2026-10-22）。LLM が動いている間は何も重ねない。

使い方: python -s gen-image-runner.py <job.json>
        pythonw -s -X utf8 gen-image-runner.py --warm <作業フォルダ>
job.json: ckpt_dir, ckpt, prompt, negative, seeds[], outs[], steps, cfg, sampler, scheduler, width, height,
          go, abort, result, timeline, comfy_args（ComfyUI の起動引数。例 "--fast fp16_accumulation --use-sage-attention"）
"""
import json
import os
import struct
import sys
import time

# 専用4060のjobだけ、検証後・ComfyUIのimport前にUUIDへ切り替える。
os.environ['CUDA_DEVICE_ORDER'] = 'PCI_BUS_ID'
os.environ['CUDA_VISIBLE_DEVICES'] = '0'
WARM_IDLE_SECONDS = 3 * 3600
job = None
T0 = time.time()
timings = {}
GPU_INFO = {}


def emit_progress(phase, **fields):
    if not job or not job.get('progress_file'):
        return
    # 待機役のstdoutはwarm.logへ向いているため、専用の通信ファイルへ流す。
    try:
        with open(job['progress_file'], 'a', encoding='ascii') as stream:
            stream.write(json.dumps({'type': 'progress', 'phase': phase, **fields}, ensure_ascii=True) + '\n')
    except OSError:
        pass  # 表示の失敗で完成画像の生成を止めない。


def install_preview_hook(index):
    if not job.get('progress_file'):
        return
    import base64
    import io
    import latent_preview
    from comfy.cli_args import LatentPreviewMethod
    # 毎stepのVAE展開や追加モデルで生成を重くしない。
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
                pass
        emit_progress('sampling', **fields)

    comfy.utils.set_progress_bar_global_hook(update)


def no_power_throttling():
    # Windows は窓の無いバックグラウンドのプロセスを省電力側（EcoQoS）へ絞ることがある。pythonw で WMI から起動した
    # 待機役では、job を受けてからの import が起動し直すより遅かった（6.3 秒 / 5.2 秒）。自分で外しておく。
    try:
        import ctypes
        from ctypes import wintypes

        class PowerThrottlingState(ctypes.Structure):
            _fields_ = [('Version', wintypes.ULONG), ('ControlMask', wintypes.ULONG), ('StateMask', wintypes.ULONG)]

        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.SetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        state = PowerThrottlingState(1, 0x1, 0)  # EXECUTION_SPEED を制御対象にして、絞らない（StateMask=0）
        k32.SetProcessInformation(k32.GetCurrentProcess(), 4, ctypes.byref(state), ctypes.sizeof(state))  # 4 = ProcessPowerThrottling
        k32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k32.SetPriorityClass(k32.GetCurrentProcess(), 0x20)  # NORMAL_PRIORITY_CLASS
    except Exception:
        pass


def mark(label):
    # gen-image.ps1 と同じ時刻記録（どこが遅いかを測るため）
    path = os.environ.get('LLM_TIMELINE')
    if path:
        t = time.time()
        stamp = time.strftime('%H:%M:%S', time.localtime(t)) + '.%03d' % int((t % 1) * 1000)
        try:
            with open(path, 'a', encoding='ascii') as f:
                f.write('%s\t%s\n' % (stamp, label))
        except OSError:
            pass  # PowerShell 側と同時に開いた時。記録のために生成を止めない


def finish(result, code):
    result['gpu'] = GPU_INFO
    if 'torch' in globals() and torch.cuda.is_initialized():
        result['peak_cuda_reserved_mib'] = round(torch.cuda.max_memory_reserved() / (1 << 20), 1)
    line = json.dumps(result, ensure_ascii=False)
    if job and job.get('result'):
        tmp = job['result'] + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(line + '\n')
        os.replace(tmp, job['result'])
    sys.stdout.write(line + '\n')
    sys.stdout.flush()
    sys.stderr.flush()
    # torch と CUDA の後始末で通常終了は 1 秒近くかかる。VRAM は先に返してあるので、待たずに抜ける。
    os._exit(code)


def fail(message, code=1):
    import traceback
    traceback.print_exc()
    finish({'ok': False, 'error': message, 'timings': timings, 'gpu_released': release_gpu()}, code)


def import_comfy(comfy_args):
    # import は約 5 秒（待機役は外部ライブラリを読み終えているので約 1 秒）。comfy_kitchen（量子化用）や torchvision
    # （Stable Cascade 用）を読ませない手も試したが、torchvision は他の部品が `from torchvision import transforms` で
    # 中まで読むので偽物に差し替えるしかなく、comfy_kitchen だけ外しても 0.2 秒しか縮まなかった（2026-10-22）。
    global torch, folder_paths, nodes, comfy, Image, PngInfo, np
    import torch
    # ComfyUI の起動引数として渡す（comfy.cli_args は import 時に sys.argv を読む）
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
    GPU_INFO['name'] = torch.cuda.get_device_name(0)
    if job.get('gpu_mode') == 'rtx4060' and (torch.cuda.device_count() != 1 or GPU_INFO['name'] != 'NVIDIA GeForce RTX 4060'):
        raise RuntimeError('専用RTX 4060へのCUDA割り当てを確認できませんでした。')
    mark('runner.imported')


# マップの上に作ったテンソルが生きている間は、マップを閉じない
KEEP_ALIVE = []


def build_checkpoint(ckpt_dir, name):
    # ComfyUI の CheckpointLoaderSimple（aimdo を使わない時）は、safetensors のメモリマップから一度テンソルへ写し、
    # それをモデルの重みへもう一度 copy_ する（6.5GB を 2 回、3.2 秒）。ComfyUI 自身の aimdo 版（comfy.utils.load_safetensors）と
    # 同じく、マップの上にそのままテンソルを作って渡せば 1 回で済む（2.4 秒）。読むだけなので書き込み不可のテンソルでよい。
    # GPU が空いた後に safetensors から直接 GPU へ読んで組み立てる手も試したが、読み込み・サンプリングとも 5.9 秒に
    # 遅くなり、絵も変わった（画素の 29% が別物。2026-10-22）。
    import mmap
    import warnings
    folder_paths.add_model_folder_path('checkpoints', ckpt_dir)
    t = time.time()
    with torch.inference_mode():
        try:
            path = folder_paths.get_full_path_or_raise('checkpoints', name)
            fh = open(path, 'rb')
            mm = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
            KEEP_ALIVE.append((fh, mm))
            mv = memoryview(mm)
            header_size = struct.unpack('<Q', mv[:8])[0]
            header = json.loads(mv[8:8 + header_size].tobytes().decode('utf-8'))
            data = mv[8 + header_size:]
            dtypes = {'F64': torch.float64, 'F32': torch.float32, 'F16': torch.float16, 'BF16': torch.bfloat16,
                      'I64': torch.int64, 'I32': torch.int32, 'I16': torch.int16, 'I8': torch.int8, 'U8': torch.uint8,
                      'BOOL': torch.bool}
            sd = {}
            with warnings.catch_warnings():
                warnings.filterwarnings('ignore', message='The given buffer is not writable')
                for key, info in header.items():
                    if key == '__metadata__':
                        continue
                    start, end = info['data_offsets']
                    if start == end:
                        sd[key] = torch.empty(info['shape'], dtype=dtypes[info['dtype']])
                    else:
                        sd[key] = torch.frombuffer(data[start:end], dtype=dtypes[info['dtype']]).view(info['shape'])
            out = comfy.sd.load_state_dict_guess_config(sd, output_vae=True, output_clip=True,
                                                        embedding_directory=folder_paths.get_folder_paths('embeddings'),
                                                        metadata=header.get('__metadata__'))
            if out is None:
                raise RuntimeError('model type not detected: %s' % path)
            built = out[:3]
            timings['load_mode'] = 'mapped'
        except Exception as e:
            print('マップからの組み立てに失敗、ComfyUI の通常の読み込みに戻す: %r' % e, file=sys.stderr)
            built = nodes.CheckpointLoaderSimple().load_checkpoint(name)[:3]
            timings['load_mode'] = 'comfy'
    timings['load_ckpt'] = round(time.time() - t, 2)
    mark('runner.ckpt_loaded')
    return built


def release_gpu():
    # プロセスの終了は 0.9 秒かかる（6.5GB のマップの後始末と CUDA の片付け）。gen-image.ps1 がそれを待たずに LLM を
    # 戻せるよう、結果を書く前に VRAM を返しておく。モデルを CPU へ戻すと 6.5GB のコピーになるので、参照を外して捨てる。
    # 返せたかを結果に書き、返せなかった時は gen-image.ps1 が終了を待つ。
    try:
        if 'comfy' not in globals():
            return True  # ComfyUI を読む前（CUDA に触っていない）
        import gc
        for name in ('MODEL', 'pos', 'neg', 'latent', 'samples', 'image'):
            globals().pop(name, None)
        comfy.model_management.current_loaded_models.clear()
        gc.collect()
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
        released = torch.cuda.memory_reserved() < (256 << 20)
        mark('runner.gpu_released' if released else 'runner.gpu_not_released')
        return released
    except Exception:
        return False


def claim_warm_job(work_dir, idle_seconds):
    ready = os.path.join(work_dir, 'warm.ready')
    job_path = os.path.join(work_dir, 'warm.job')
    claimed = os.path.join(work_dir, 'warm.claimed.%d.json' % os.getpid())
    with open(ready, 'w', encoding='ascii') as f:
        f.write(str(os.getpid()))
    deadline = time.monotonic() + idle_seconds
    try:
        while time.monotonic() < deadline:
            try:
                os.replace(job_path, claimed)
                return claimed
            except FileNotFoundError:
                time.sleep(0.1)
        # 古いclaimedの存在を成功判定にすると、3時間後に前回の画像を再生成してしまう。
        return None
    finally:
        try:
            os.remove(ready)
        except OSError:
            pass


def wait_warm(work_dir):
    # ComfyUI 本体は import 時に CUDA を初期化するので、外部ライブラリだけを先に読む。
    import torch, torchvision, transformers, numpy, PIL.Image, safetensors.torch  # noqa: F401
    import transformers.models.clip  # noqa: F401
    return claim_warm_job(work_dir, WARM_IDLE_SECONDS)


def assert_llm_stopped(host='127.0.0.1', port=8080):
    import socket
    # 古いgoやrunnerの直接起動でも、LLMとGPUを奪い合わないよう最後に実体を確認する。
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        connection.settimeout(2)
        if connection.connect_ex((host, port)) == 0:
            raise RuntimeError('LLMのポートがまだ開いているため画像生成を中止。gen-image.ps1から実行してください。')


def configure_gpu(image_job, warm=False):
    mode = image_job.get('gpu_mode', 'shared')
    assert_llm_stopped()
    if mode == 'shared':
        assert_llm_stopped(port=8090)
        return {'mode': mode, 'visible_devices': '0'}
    if mode != 'rtx4060' or warm:
        raise RuntimeError('未対応のGPU割り当てです。専用4060は新しいプロセスで起動してください。')
    import csv
    import io
    import subprocess
    listing = subprocess.check_output(
        ['nvidia-smi', '--query-gpu=uuid,name', '--format=csv,noheader'], text=True, timeout=10)
    uuid = image_job.get('gpu_uuid', '')
    matches = [(row[0].strip(), row[1].strip()) for row in csv.reader(io.StringIO(listing))
               if len(row) == 2 and row[0].strip() == uuid and row[1].strip() == 'NVIDIA GeForce RTX 4060']
    if len(matches) != 1:
        raise RuntimeError('jobのGPU UUIDが専用RTX 4060と一致しません。')
    os.environ['CUDA_VISIBLE_DEVICES'] = uuid
    return {'mode': mode, 'visible_devices': uuid}


no_power_throttling()
is_warm = len(sys.argv) >= 3 and sys.argv[1] == '--warm'
if is_warm:
    # pythonw には標準出力が無い。tqdm と logging が書けるようにログファイルへ向ける。
    sys.stdout = sys.stderr = open(os.path.join(sys.argv[2], 'warm.log'), 'w', encoding='utf-8', buffering=1)
    job_file = wait_warm(sys.argv[2])
    if job_file is None:
        sys.exit(0)
else:
    job_file = sys.argv[1]
T0 = time.time()
with open(job_file, encoding='utf-8-sig') as job_input:
    job = json.load(job_input)
if is_warm:
    os.remove(job_file)
if job.get('timeline'):
    os.environ['LLM_TIMELINE'] = job['timeline']
mark('runner.job_received')
seeds, outs = job['seeds'], job['outs']
if len(seeds) != len(outs):
    finish({'ok': False, 'error': 'seeds と outs の数が違う'}, 2)

# abortが残っているときは、goの有無にかかわらず開始しない。
t_wait = time.time()
while True:
    if os.path.exists(job['abort']):
        finish({'ok': False, 'error': 'aborted', 'gpu_released': True}, 3)
    if os.path.exists(job['go']):
        break
    if time.time() - t_wait > 300:
        finish({'ok': False, 'error': 'go が 300 秒来なかった', 'gpu_released': True}, 4)
    time.sleep(0.05)
try:
    GPU_INFO = configure_gpu(job, is_warm)
except Exception as e:
    finish({'ok': False, 'error': str(e), 'gpu_released': True}, 5)
mark('runner.go')
timings['wait_go'] = round(time.time() - t_wait, 2)

try:
    emit_progress('loading', index=1, count=len(seeds))
    if 'comfy' not in globals():
        import_comfy(job.get('comfy_args', ''))
    timings['import'] = round(time.time() - T0, 2)
except Exception as e:
    fail('import に失敗: %r' % e)

try:
    MODEL = build_checkpoint(job['ckpt_dir'], job['ckpt'])
    model, clip, vae = MODEL
except Exception as e:
    fail('checkpoint の読み込みに失敗: %r' % e)

files = []
try:
    with torch.inference_mode():
        emit_progress('encoding', index=1, count=len(seeds))
        t = time.time()
        pos = nodes.CLIPTextEncode().encode(clip, job['prompt'])[0]
        neg = nodes.CLIPTextEncode().encode(clip, job['negative'])[0]
        timings['clip'] = round(time.time() - t, 2)
        mark('runner.clip_done')

        for i, (seed, out) in enumerate(zip(seeds, outs)):
            emit_progress('sampling', index=i + 1, count=len(seeds), step=0, steps=job['steps'])
            install_preview_hook(i + 1)
            t = time.time()
            latent = nodes.EmptyLatentImage().generate(job['width'], job['height'], 1)[0]
            samples = nodes.KSampler().sample(model, seed, job['steps'], job['cfg'], job['sampler'], job['scheduler'],
                                              pos, neg, latent, denoise=1.0)[0]
            timings.setdefault('sample', []).append(round(time.time() - t, 2))
            mark('runner.sampled_%d' % (i + 1))
            if job.get('progress_file'):
                comfy.utils.set_progress_bar_global_hook(None)

            emit_progress('decoding', index=i + 1, count=len(seeds))
            t = time.time()
            image = nodes.VAEDecode().decode(vae, samples)[0][0]
            timings.setdefault('decode', []).append(round(time.time() - t, 2))

            emit_progress('saving', index=i + 1, count=len(seeds))
            t = time.time()
            arr = np.clip(255.0 * image.cpu().numpy(), 0, 255).astype(np.uint8)
            info = PngInfo()
            # A1111 形式。画像を読むツールや、後で seed を確かめる時に使える。
            info.add_text('parameters', '%s\nNegative prompt: %s\nSteps: %d, Sampler: %s, Schedule type: %s, CFG scale: %g, '
                                        'Seed: %d, Size: %dx%d, Model: %s' % (
                              job['prompt'], job['negative'], job['steps'], job['sampler'], job['scheduler'], job['cfg'],
                              seed, job['width'], job['height'], os.path.splitext(job['ckpt'])[0]))
            Image.fromarray(arr).save(out, pnginfo=info, compress_level=4)
            timings.setdefault('save', []).append(round(time.time() - t, 2))
            files.append({'path': out, 'seed': seed})
            mark('runner.saved_%d' % (i + 1))
except Exception as e:
    import traceback
    traceback.print_exc()
    del model, clip, vae
    finish({'ok': False, 'error': '生成に失敗: %r' % e, 'files': files, 'timings': timings, 'gpu_released': release_gpu()}, 1)

timings['total'] = round(time.time() - T0, 2)
emit_progress('releasing')
del model, clip, vae
finish({'ok': True, 'files': files, 'timings': timings, 'gpu_released': release_gpu()}, 0)

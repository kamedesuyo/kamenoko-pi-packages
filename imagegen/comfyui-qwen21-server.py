"""comfyui-qwen21.ps1 から呼ぶ。設定の qwen.root にある ComfyUI 0.42.4 を画面つきのサーバとして起動する。

python_embeded の ._pth は SDXL 用の 0.31.1（..\\ComfyUI）を sys.path に入れ、PYTHONPATH も読まないので、main.py をそのまま
叩くと古い側のモジュールや、共有の site-packages にある古い comfy_kitchen / frontend が混ざる。gen-image-qwen21-runner.py と
同じ並べ替え（0.31.1 を外し、<qwen.root>\\site と 0.42.4 を前に差す）をしてから main.py を走らせる。

qwen.root は呼び出し元が環境変数 IMAGEGEN_QWEN_ROOT で渡す。無ければ作業フォルダ（<qwen.root>\\ComfyUI）の1つ上とみなす。

使い方: python -s comfyui-qwen21-server.py [ComfyUI の起動引数...]
"""
import os
import runpy
import sys

# torch を読む前に決める。生成役と同じく 5060 Ti だけを使う。
os.environ['CUDA_DEVICE_ORDER'] = 'PCI_BUS_ID'
os.environ['CUDA_VISIBLE_DEVICES'] = '0'
ROOT = os.environ.get('IMAGEGEN_QWEN_ROOT') or os.path.dirname(os.path.abspath(os.getcwd()))
COMFY = os.path.join(ROOT, 'ComfyUI')


def same(a, b):
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


bundled = os.path.join(os.path.dirname(sys.executable), '..', 'ComfyUI')
here = os.path.dirname(os.path.abspath(__file__))
# このスクリプトの置き場所も外す。そこにある .py が ComfyUI のモジュール名と重なると、そちらが読まれるため。
sys.path = [p for p in sys.path if not same(p, bundled) and not same(p, here)]
sys.path[0:0] = [os.path.join(ROOT, 'site'), COMFY]
os.chdir(COMFY)
sys.argv = [os.path.join(COMFY, 'main.py')] + sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')

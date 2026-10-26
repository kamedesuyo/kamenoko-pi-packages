"""imgpane: エージェント（pi・Claude Code・Codex）が作った・読んだ画像を、Windows Terminal の分割ペインに Sixel で描くビューア。

CLI のエージェントは会話の中に画像を描けない（2026-10 時点。Claude Code は kitty/Ghostty だけ、pi は kitty/iTerm2 だけ、
Codex は未対応）。Windows Terminal は Sixel にしか対応していないので、会話の外に横の枠を置いてそこへ描く。
既製品（viewfinder・ccdesk・claude-image-preview）は入れずに、README から機能を読み取って自分で書いた。
外部との通信は無く、Pillow と numpy だけを使う。

使い方:
  imgpane.bat              Windows Terminal の今のタブを左右に割って、右にビューアを開く
  imgpane.bat show A.png   ビューアへ画像を送る（ビューアが動いていなくても失敗しない。開いた時に履歴に入っている）
  imgpane.bat view         今のコンソールでビューアを動かす
  imgpane.bat hook         Claude Code・Codex のフック用。標準入力の JSON のツールの入力から画像のパスを拾って送る

ビューアの操作: ← → 前後 / Home End 最初と最新 / o 既定のアプリで開く / c パスをコピー / r 描き直す / q 終了
送られた画像は %LOCALAPPDATA%\\imgpane\\queue.txt に1行ずつ追記される（gen-image・pi の拡張・フックも同じ形式で直接書く）。
ビューアは起動時にその末尾を履歴として読み、以後は追記を見張る。
%LOCALAPPDATA%\\imgpane\\config.json の watch に書いたフォルダに増えた画像も拾う。
"""
import ctypes
import json
import os
import sys
import time
from ctypes import wintypes

IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'}
DATA_DIR = os.path.join(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'), 'imgpane')
QUEUE = os.path.join(DATA_DIR, 'queue.txt')
# 設定は利用者ごとのデータ側に置く。スクリプトの横に置くと、配布物の更新で上書きされる。
CONFIG = os.path.join(DATA_DIR, 'config.json')
HISTORY_MAX = 300
QUEUE_TRIM_BYTES = 256 << 10
MAX_FILE_BYTES = 200 << 20
# 長辺の上限。Sixel の生成（numpy で 1 枚 0.3 秒前後）と端末の描画を軽く保つ。
MAX_DRAW_SIDE = 1600


def clean(text):
    # ファイル名などに紛れた制御文字（ESC など）で端末を操作されないよう、画面に出す文字列からは取り除く。
    return ''.join(ch for ch in str(text) if ch.isprintable())


def is_image(path):
    try:
        return (os.path.splitext(path)[1].lower() in IMAGE_EXTS and os.path.isfile(path)
                and os.path.getsize(path) <= MAX_FILE_BYTES)
    except OSError:
        return False


def cmd_show(paths):
    os.makedirs(DATA_DIR, exist_ok=True)
    good = [os.path.abspath(p) for p in paths if is_image(os.path.abspath(p))]
    if good:
        with open(QUEUE, 'a', encoding='utf-8') as f:
            f.write(''.join(p + '\n' for p in good))
    # 追記だけだと際限なく伸びるので、ときどき末尾だけ残す（ビューアは縮んだことに気づいて読み直す）。
    try:
        if os.path.getsize(QUEUE) > QUEUE_TRIM_BYTES:
            with open(QUEUE, encoding='utf-8', errors='ignore') as f:
                lines = f.read().splitlines()[-HISTORY_MAX:]
            tmp = QUEUE + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                f.write(''.join(l + '\n' for l in lines))
            os.replace(tmp, QUEUE)
    except OSError:
        pass
    return 0 if good else 1


# ---------------------------------------------------------------- 画像 → Sixel

def to_sixel(img, colors=255):
    """RGB の PIL 画像を Sixel の文字列にする。

    色は Pillow の median cut で 255 色に減らし、Floyd-Steinberg でディザをかける（アニメ塗りのグラデーションの段差を目立たせない）。
    6 行ずつの帯ごとに、帯に出てくる色だけについて「その色の画素が 6 行のどこにあるか」を 6 ビットにして 1 文字にし、
    同じ文字の連続は !n で詰める。帯の中の色の切り替えは $（行頭へ戻る）、帯の終わりは -。
    """
    import numpy as np
    from PIL import Image
    q = img.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    idx = np.asarray(q, dtype=np.uint8)
    h, w = idx.shape
    used = int(idx.max()) + 1
    pal = q.getpalette()[:used * 3]
    # P1=9 は画素の縦横比 1:1、P2=1 は色を塗らなかった画素を透明にする。"1;1;幅;高さ はラスタ属性（同じく 1:1）。
    out = ['\x1bP9;1;0q"1;1;%d;%d' % (w, h)]
    out.extend('#%d;2;%d;%d;%d' % (c, pal[3 * c] * 100 // 255, pal[3 * c + 1] * 100 // 255, pal[3 * c + 2] * 100 // 255)
               for c in range(used))
    weights = np.array([1, 2, 4, 8, 16, 32], dtype=np.uint8)[:, None]
    for y in range(0, h, 6):
        band = idx[y:y + 6]
        bh = band.shape[0]
        parts = []
        for c in np.unique(band):
            bits = ((band == c) * weights[:bh]).sum(axis=0, dtype=np.uint8)
            nz = np.flatnonzero(bits)
            bits = bits[:nz[-1] + 1]  # 帯の右端の空白は書かない
            cut = np.flatnonzero(np.diff(bits)) + 1
            starts = np.concatenate(([0], cut))
            lens = np.diff(np.concatenate((starts, [bits.size])))
            chars = (bits[starts] + 63).tolist()
            run = ['!%d%s' % (n, chr(ch)) if n > 3 else chr(ch) * n for n, ch in zip(lens.tolist(), chars)]
            parts.append('#%d%s' % (c, ''.join(run)))
        out.append('$'.join(parts))
        out.append('-')
    out.append('\x1b\\')
    return ''.join(out)


def to_halfblocks(img):
    """Sixel が使えない端末用。上下 2 画素を ▀ の文字色と背景色にした 24bit カラーの文字で描く。"""
    import numpy as np
    a = np.asarray(img.convert('RGB'), dtype=np.uint8)
    if a.shape[0] % 2:
        a = np.vstack([a, a[-1:]])
    lines = []
    for y in range(0, a.shape[0], 2):
        top, bot = a[y], a[y + 1]
        lines.append(''.join('\x1b[38;2;%d;%d;%dm\x1b[48;2;%d;%d;%dm\u2580' % (*t, *b) for t, b in zip(top.tolist(), bot.tolist()))
                     + '\x1b[0m')
    return '\r\n'.join(lines)


def load_rgb(path):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 60_000_000  # 展開すると巨大になる画像（解凍爆弾）は読まない
    img = Image.open(path)
    img.draft('RGB', (MAX_DRAW_SIDE, MAX_DRAW_SIDE))  # JPEG は縮小しながら読む
    if getattr(img, 'is_animated', False):
        img.seek(0)
    if img.mode in ('RGBA', 'LA', 'P'):
        img = img.convert('RGBA')
        bg = Image.new('RGBA', img.size, (24, 24, 24, 255))
        img = Image.alpha_composite(bg, img)
    return img.convert('RGB')


# ---------------------------------------------------------------- コンソール

ENABLE_PROCESSED_OUTPUT = 0x0001
ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
DISABLE_NEWLINE_AUTO_RETURN = 0x0008
ENABLE_LINE_INPUT = 0x0002
ENABLE_ECHO_INPUT = 0x0004
ENABLE_MOUSE_INPUT = 0x0010
ENABLE_QUICK_EDIT_MODE = 0x0040
ENABLE_EXTENDED_FLAGS = 0x0080
ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200


class Console:
    """Windows のコンソールを、VT の入出力（矢印キーや端末への問い合わせの返事を文字列で受け取る）にして使う。"""

    def __init__(self):
        import msvcrt
        self.msvcrt = msvcrt
        k32 = ctypes.windll.kernel32
        k32.GetStdHandle.restype = wintypes.HANDLE
        self.k32 = k32
        self.hin = k32.GetStdHandle(-10)
        self.hout = k32.GetStdHandle(-11)
        self.mode_in = wintypes.DWORD()
        self.mode_out = wintypes.DWORD()
        k32.GetConsoleMode(self.hin, ctypes.byref(self.mode_in))
        k32.GetConsoleMode(self.hout, ctypes.byref(self.mode_out))
        k32.SetConsoleMode(self.hout, self.mode_out.value | ENABLE_PROCESSED_OUTPUT
                           | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN)
        k32.SetConsoleMode(self.hin, (self.mode_in.value | ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_EXTENDED_FLAGS)
                           & ~(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_QUICK_EDIT_MODE | ENABLE_MOUSE_INPUT))
        self.pending = ''

    def restore(self):
        self.k32.SetConsoleMode(self.hin, self.mode_in.value)
        self.k32.SetConsoleMode(self.hout, self.mode_out.value)

    def write(self, s):
        sys.stdout.write(s)
        sys.stdout.flush()

    def poll(self):
        while self.msvcrt.kbhit():
            self.pending += self.msvcrt.getwch()
        s, self.pending = self.pending, ''
        return s

    def query(self, seq, final, timeout=0.5):
        """端末に問い合わせて、final で終わる返事を待つ（来なければ空）。待つ間に押されたキーは後で処理するよう残す。"""
        self.write(seq)
        buf = ''
        end = time.time() + timeout
        while time.time() < end:
            while self.msvcrt.kbhit():
                buf += self.msvcrt.getwch()
            i = buf.find('\x1b[')
            if i >= 0:
                j = i + 2
                while j < len(buf) and (buf[j].isdigit() or buf[j] in ';?'):
                    j += 1
                if j < len(buf) and buf[j] == final:
                    self.pending += buf[:i] + buf[j + 1:]
                    return buf[i + 2:j]
            time.sleep(0.01)
        self.pending += buf
        return ''


def parse_keys(s):
    """入力の文字列をキーの名前の列にする（VT の入力列と、従来の 0xE0 付きの列の両方を受ける）。"""
    keys = []
    i = 0
    vt = {'D': 'left', 'C': 'right', 'A': 'up', 'B': 'down', 'H': 'home', 'F': 'end'}
    legacy = {'K': 'left', 'M': 'right', 'H': 'up', 'P': 'down', 'G': 'home', 'O': 'end'}
    while i < len(s):
        ch = s[i]
        if ch == '\x1b' and i + 2 < len(s) and s[i + 1] in '[O':
            j = i + 2
            while j < len(s) and (s[j].isdigit() or s[j] == ';'):
                j += 1
            if j < len(s):
                tail = s[i + 2:j]
                if s[j] == '~' and tail in ('1', '7'):
                    keys.append('home')
                elif s[j] == '~' and tail in ('4', '8'):
                    keys.append('end')
                else:
                    keys.append(vt.get(s[j], ''))
                i = j + 1
                continue
        if ch in '\x00\xe0' and i + 1 < len(s):
            keys.append(legacy.get(s[i + 1], ''))
            i += 2
            continue
        keys.append(ch.lower())
        i += 1
    return [k for k in keys if k]


def copy_to_clipboard(text):
    # clip.exe は標準入力を ANSI として読むので、日本語のパスが化ける。クリップボードの API へ UTF-16 で直接置く。
    u32, k32 = ctypes.windll.user32, ctypes.windll.kernel32
    k32.GlobalAlloc.restype = wintypes.HGLOBAL
    k32.GlobalLock.restype = ctypes.c_void_p
    k32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    k32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    u32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    data = (text + '\0').encode('utf-16-le')
    if not u32.OpenClipboard(None):
        return False
    try:
        u32.EmptyClipboard()
        h = k32.GlobalAlloc(0x0002, len(data))  # GMEM_MOVEABLE
        p = k32.GlobalLock(h)
        ctypes.memmove(p, data, len(data))
        k32.GlobalUnlock(h)
        return bool(u32.SetClipboardData(13, h))  # CF_UNICODETEXT
    finally:
        u32.CloseClipboard()


# ---------------------------------------------------------------- ビューア

class Viewer:
    def __init__(self):
        self.con = Console()
        self.history = []
        self.index = -1
        self.queue_offset = 0
        self.watch = {}
        self.cache = {}
        self.size = None
        self.cell = (10, 20)
        self.sixel = True
        self.message = ''
        self.dirty = True

    # --- 履歴

    def add(self, path, jump=True):
        if not is_image(path):
            return
        if path in self.history[-20:]:
            if jump:
                self.index = len(self.history) - 1 - self.history[::-1].index(path)
                self.dirty = True
            return
        self.history.append(path)
        if len(self.history) > HISTORY_MAX:
            del self.history[:len(self.history) - HISTORY_MAX]
        if jump:
            self.index = len(self.history) - 1
            self.dirty = True

    def read_queue(self, initial=False):
        try:
            size = os.path.getsize(QUEUE)
        except OSError:
            return
        if size < self.queue_offset:  # show が末尾だけ残して書き直した
            self.queue_offset = 0
            initial = True
        if size == self.queue_offset:
            return
        with open(QUEUE, 'rb') as f:
            f.seek(self.queue_offset)
            data = f.read()
        nl = data.rfind(b'\n')
        if nl < 0:
            return  # 書きかけの1行。次に読む
        self.queue_offset += nl + 1
        lines = data[:nl].decode('utf-8', errors='ignore').lstrip('\ufeff').splitlines()
        for line in lines[-HISTORY_MAX:] if initial else lines:
            self.add(line.strip().lstrip('\ufeff'), jump=True)

    def load_config(self):
        try:
            with open(CONFIG, encoding='utf-8-sig') as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            cfg = {}
        for d in cfg.get('watch', []):
            if os.path.isdir(d):
                self.watch[d] = time.time()  # 起動より後に増えたものだけ拾う

    def scan_watch(self):
        now = time.time()
        for d, since in self.watch.items():
            found = []
            try:
                for e in os.scandir(d):
                    if e.is_file() and os.path.splitext(e.name)[1].lower() in IMAGE_EXTS:
                        m = e.stat().st_mtime
                        # 書き込み途中を拾わないよう、0.5 秒以上たったものだけ
                        if since < m <= now - 0.5:
                            found.append((m, e.path))
            except OSError:
                continue
            for m, p in sorted(found):
                self.add(p)
            if found:
                self.watch[d] = max(m for m, _ in found)

    # --- 端末

    def probe(self):
        da = self.con.query('\x1b[c', 'c')
        self.sixel = '4' in da.lstrip('?').split(';')
        r = self.con.query('\x1b[16t', 't')
        parts = r.split(';')
        if len(parts) == 3 and parts[0] == '6' and parts[1].isdigit() and parts[2].isdigit() and int(parts[2]) > 0:
            self.cell = (int(parts[2]), int(parts[1]))
            return
        r = self.con.query('\x1b[14t', 't')
        parts = r.split(';')
        cols, rows = os.get_terminal_size()
        if len(parts) == 3 and parts[0] == '4' and parts[1].isdigit() and parts[2].isdigit():
            self.cell = (max(1, int(parts[2]) // cols), max(1, int(parts[1]) // rows))

    def render(self):
        cols, rows = os.get_terminal_size()
        out = ['\x1b[?25l\x1b[H\x1b[2J']
        if self.index < 0:
            out.append('\x1b[1;1Himgpane  画像を待っています')
            out.append('\x1b[3;1H  imgpane.bat show <画像>  か、gen-image・pi の拡張・フックから送られます')
        else:
            path = self.history[self.index]
            name = clean(os.path.basename(path))
            head = '%d/%d  %s' % (self.index + 1, len(self.history), name)
            body = ''
            try:
                img = load_rgb(path)
                iw, ih = img.size
                head += '  %dx%d' % (iw, ih)
                key = (path, os.path.getmtime(path), cols, rows, self.cell, self.sixel)
                body = self.cache.get(key)
                if body is None:
                    body = self.encode(img, cols, rows)
                    if len(self.cache) > 12:
                        self.cache.pop(next(iter(self.cache)))
                    self.cache[key] = body
            except Exception as e:
                body = '\x1b[3;1H  読めなかった: %s' % clean(e)
            out.append('\x1b[1;1H\x1b[7m %s \x1b[0m' % head[:max(1, cols - 2)])
            out.append('\x1b[2;1H')
            out.append(body)
        foot = self.message or '← → 前後  Home/End 最初/最新  o 開く  c パスをコピー  r 描き直す  q 終了'
        out.append('\x1b[%d;1H\x1b[2m%s\x1b[0m' % (rows, clean(foot)[:max(1, cols - 1)]))
        self.con.write(''.join(out))
        self.message = ''
        self.dirty = False

    def encode(self, img, cols, rows):
        from PIL import Image
        cw, ch = self.cell
        # 見出し 1 行・下の案内 1 行に加え、1 行あける。Sixel は描いた後にカーソルを絵の下へ送るので、
        # 最下行まで使うとそこで画面が 1 行流れて見出しが消える。
        if self.sixel:
            aw, ah = cols * cw, max(1, rows - 3) * ch
        else:
            aw, ah = cols, max(1, rows - 3) * 2  # ▀ 1 文字に上下 2 画素
        iw, ih = img.size
        # 半角ブロックは 1 文字が縦長（約 1:2）なので、横を詰めた分だけ縦も合わせる
        px_aspect = 1.0 if self.sixel else (ch / 2) / cw
        scale = min(aw / iw, ah / (ih / px_aspect), 1.0 if self.sixel else 10.0, MAX_DRAW_SIDE / max(iw, ih))
        tw, th = max(1, int(iw * scale)), max(1, int(ih * scale / px_aspect))
        small = img.resize((tw, th), Image.LANCZOS)
        return to_sixel(small) if self.sixel else to_halfblocks(small)

    def handle(self, key):
        n = len(self.history)
        if key == 'q':
            return False
        if n == 0:
            return True
        if key in ('left', 'up', 'h', 'k', 'p'):
            self.index = max(0, self.index - 1)
        elif key in ('right', 'down', 'l', 'j', 'n', ' '):
            self.index = min(n - 1, self.index + 1)
        elif key == 'home':
            self.index = 0
        elif key == 'end':
            self.index = n - 1
        elif key == 'o':
            path = self.history[self.index]
            if is_image(path):
                os.startfile(path)
                self.message = '開いた: ' + os.path.basename(path)
        elif key == 'c':
            self.message = 'パスをコピーした' if copy_to_clipboard(self.history[self.index]) else 'コピーできなかった'
        elif key != 'r':
            return True
        self.dirty = True
        return True

    def run(self):
        self.con.write('\x1b[?1049h')  # 代替スクリーン（スクロールバックを汚さない）
        try:
            self.probe()
            self.load_config()
            self.read_queue(initial=True)
            last_poll = 0.0
            while True:
                for key in parse_keys(self.con.poll()):
                    if not self.handle(key):
                        return
                now = time.time()
                if now - last_poll > 0.25:
                    last_poll = now
                    self.read_queue()
                    self.scan_watch()
                    size = os.get_terminal_size()
                    if size != self.size:
                        if self.size is not None:
                            self.probe()  # フォントの大きさが変わったかもしれない
                        self.size = size
                        self.dirty = True
                if self.dirty:
                    self.render()
                time.sleep(0.03)
        except KeyboardInterrupt:
            pass
        finally:
            self.con.write('\x1b[0m\x1b[?25h\x1b[?1049l')
            self.con.restore()


def cmd_hook():
    """Claude Code・Codex のフックから呼ぶ。標準入力の JSON のうちツールの入力（tool_input）から画像のパスを探して送る。

    ツールの結果（tool_response）は見ない。画像の中身や大きな文字列が入っていて、パスの取り違えのもとになる。
    フックを失敗させてエージェントを止めないよう、何があっても 0 で終わる。
    """
    try:
        # PowerShell からパイプで渡すと先頭に BOM が付くことがある
        data = json.loads(sys.stdin.buffer.read(1 << 20).decode('utf-8-sig', errors='ignore'))
    except ValueError:
        return 0
    if not isinstance(data, dict):
        return 0
    cwd = data.get('cwd') if isinstance(data.get('cwd'), str) else os.getcwd()
    target = data.get('tool_input', data.get('input', data.get('arguments', {})))
    found = []

    def walk(v, depth=0):
        if depth > 4 or len(found) > 20:
            return
        if isinstance(v, dict):
            for x in v.values():
                walk(x, depth + 1)
        elif isinstance(v, list):
            for x in v[:50]:
                walk(x, depth + 1)
        elif isinstance(v, str) and len(v) < 1024 and os.path.splitext(v)[1].lower() in IMAGE_EXTS:
            found.append(v if os.path.isabs(v) else os.path.join(cwd, v))

    walk(target)
    if found:
        try:
            cmd_show(found)
        except OSError:
            pass
    return 0


def main(argv):
    if len(argv) >= 2 and argv[1] == 'show':
        return cmd_show(argv[2:])
    if len(argv) >= 2 and argv[1] == 'hook':
        return cmd_hook()
    if len(argv) >= 2 and argv[1] == 'view':
        Viewer().run()
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))

import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { piRoot } from './pi-root.mjs';

const run = mkdtempSync(join(tmpdir(), 'clipboard-preview-test-'));
const temp = join(run, '一時 画像');
mkdirSync(temp);
process.env.TEMP = temp;
process.env.TMP = temp;
process.env.LOCALAPPDATA = join(run, 'local');
process.env.TERM_PROGRAM = 'WezTerm';
const packageDir = piRoot();
const uri = relative => pathToFileURL(join(packageDir, relative)).href;
const tuiDir = 'node_modules/@earendil-works/pi-tui/dist/';
let clipboard;
let clipboardReads = 0;
mock.module(uri('dist/utils/clipboard-image.js'), { namedExports: {
  readClipboardImage: async () => { clipboardReads++; return clipboard; },
  extensionForImageMimeType: mime => ({ 'image/png': 'png', 'image/jpeg': 'jpg' })[mime],
} });
mock.module(uri('dist/utils/clipboard.js'), { namedExports: {
  readClipboardFilePaths: async () => null,
  readClipboardText: async () => 'テキストだけ',
  copyToClipboard: () => { throw new Error('テストから実クリップボードへの書き込みは禁止'); },
} });
const { loadExtensions } = await import(uri('dist/core/extensions/loader.js'));
const { InteractiveMode } = await import(uri('dist/modes/interactive/interactive-mode.js'));
const { initTheme } = await import(uri('dist/modes/interactive/theme/theme.js'));
initTheme('dark', false);
const { TuiAltScreen, Container, visibleWidth, matchesKey } = await import(uri(`${tuiDir}index.js`));
const { setCapabilities } = await import(uri(`${tuiDir}terminal-image.js`));
const source = process.env.DRAFT_IMAGE_PREVIEW_EXTENSION ?? fileURLToPath(new URL('../extensions/draft-image-preview.ts', import.meta.url));
// 併用テストの相手。このリポジトリでは隣の imgpane パッケージを使い、単体で取り出した時は環境変数で渡す。
const imagePaneSource = process.env.IMAGE_PANE_EXTENSION ?? fileURLToPath(new URL('../../imgpane/pi/image-pane.ts', import.meta.url));
const loaded = await loadExtensions([source], run);
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
const theme = { fg: (_color, value) => value, bold: value => value };
const kitty = () => setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
kitty();

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); result.write(type, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
function png(color, width = 960, height = 640) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([...color, 255], y * stride + x * 4 + 1);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const red = png([255, 0, 0]), blue = png([0, 0, 255]);
const file = bytes => {
  const path = join(temp, `pi-clipboard-${randomUUID()}.png`);
  writeFileSync(path, bytes);
  return path;
};
const first = file(red), second = file(blue);
const bytesOf = component => {
  const rendered = component.render(120).join('');
  const chunks = [...rendered.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)]
    .filter(match => match[1].includes('a=T') || /(?:^|,)m=[01](?:,|$)/.test(match[1]));
  return Buffer.from(chunks.map(match => match[2]).join(''), 'base64');
};

function harness() {
  const frames = [], notices = [], requests = [];
  let text = '', overlay, overlayPromise, stopped = false;
  const terminal = {
    columns: 120, rows: 40,
    start(input, resize) { this.input = input; this.resize = resize; process.stdout.on('resize', resize); },
    stop() { if (this.resize) process.stdout.off('resize', this.resize); },
    write(data) { frames.push(data); }, hideCursor() {}, showCursor() {},
  };
  const tui = new TuiAltScreen(terminal);
  const request = tui.requestRender.bind(tui);
  tui.requestRender = force => { requests.push(force); request(force); };
  const host = {
    ui: tui, isBashMode: false,
    editor: { getText: () => text, insertTextAtCursor: value => { text += value; } },
    extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(),
    widgetContainerAbove: new Container(), widgetContainerBelow: new Container(),
    renderWidgets: InteractiveMode.prototype.renderWidgets,
    renderWidgetContainer: InteractiveMode.prototype.renderWidgetContainer,
    showError: value => { throw new Error(value); },
  };
  const context = {
    cwd: run, mode: 'tui',
    ui: {
      theme, notify: (...args) => notices.push(args),
      getEditorText: () => text,
      setWidget: (...args) => InteractiveMode.prototype.setExtensionWidget.apply(host, args),
      custom: (factory, options) => {
        overlayPromise = new Promise(resolve => {
          let handle;
          const done = () => { handle?.hide(); overlay = undefined; resolve(); };
          overlay = factory(tui, theme, {}, done);
          handle = tui.showOverlay(overlay, options.overlayOptions);
        });
        return overlayPromise;
      },
    },
  };
  tui.addChild(host.widgetContainerAbove);
  tui.addChild({ render: () => ['本文入力欄', text], invalidate() {} });
  const start = () => extension.handlers.get('session_start')[0]({}, context);
  start();
  const h = {
    tui, terminal, frames, notices, requests, context, start,
    get widget() { return host.extensionWidgetsAbove.get('draft-image-preview'); },
    get overlay() { return overlay; },
    get text() { return text; },
    set text(value) { text = value; },
    paste: () => InteractiveMode.prototype.handleClipboardPaste.call(host),
    open: () => extension.shortcuts.get('alt+o').handler(context),
    async ready() {
      for (let i = 0; i < 100; i++) {
        const lines = h.widget.render(120).join('');
        if (!lines.includes('読み込み中')) return;
        await delay(10);
      }
      throw new Error('画像プレビューの読み込みが終わらない');
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      h.widget?.dispose();
      for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({}, context);
      if (overlayPromise) await overlayPromise;
      tui.stop({ preserveScreen: true });
    },
  };
  return h;
}
const active = new Set();
async function withUI(fn) {
  kitty();
  const h = harness(); active.add(h);
  try { await fn(h); } finally { await h.stop(); active.delete(h); }
}
after(async () => { for (const h of active) await h.stop(); mock.restoreAll(); });

test('標準の画像貼り付けで取り込んだ同じ画像が、入力欄の上に出る', () => withUI(async h => {
  assert.deepEqual(h.widget.render(120), []);
  const reads = clipboardReads;
  h.text = 'この画像を見て ';
  clipboard = { bytes: red, mimeType: 'image/png' };
  await h.paste();
  assert.equal(clipboardReads, reads + 1);
  assert.match(h.text, /この画像を見て .*pi-clipboard-[\w-]+\.png$/);
  await h.ready();
  assert.deepEqual(bytesOf(h.widget), red);
  assert.match(h.widget.render(120)[0], /画像 1\/1/);
  assert.equal(h.notices.length, 0);
  assert.equal(clipboardReads, reads + 1, 'プレビューはクリップボードを監視しない');
  assert.equal(extension.handlers.has('input'), false);
  assert.equal(extension.handlers.has('before_agent_start'), false);
  assert.equal(extension.shortcuts.has('alt+v'), false);
}));

test('文字貼り付けと任意の画像パスではプレビューを開かない', () => withUI(async h => {
  clipboard = null;
  await h.paste();
  assert.equal(h.text, 'テキストだけ');
  assert.deepEqual(h.widget.render(120), []);
  h.text = 'D:\\images\\secret.png https://example.com/test.png';
  assert.deepEqual(h.widget.render(120), []);
}));

test('複数枚は最新を表示し、前後移動・削除・下書き復元が同じ画像に追従する', () => withUI(async h => {
  h.text = `${first}\n${second.replaceAll('\\', '/')}`;
  await h.ready();
  assert.deepEqual(bytesOf(h.widget), blue);
  const header = h.widget.render(120)[0];
  const x = visibleWidth(header.slice(0, header.indexOf('[前]'))) + 1;
  h.widget.handleMouse({ type: 'click', button: 'left', x, y: 0 });
  await h.ready();
  assert.deepEqual(bytesOf(h.widget), red);
  h.text += ' 比較して';
  await h.ready();
  assert.deepEqual(bytesOf(h.widget), red, '本文編集で選択を最新へ戻さない');
  h.text = `${second}\n${second}`;
  await h.ready();
  assert.match(h.widget.render(120)[0], /画像 1\/1/);
  assert.deepEqual(bytesOf(h.widget), blue);
  h.text = ''; assert.deepEqual(h.widget.render(120), []);
  h.text = first; await h.ready();
  assert.deepEqual(bytesOf(h.widget), red);
}));

test('拡大中の左右キーは画像を切り替え、EnterとEscは本文を送信せず閉じる', () => withUI(async h => {
  assert.ok(matchesKey('\x1bo', 'alt+o'));
  assert.equal(matchesKey('\x1bv', 'alt+o'), false);
  h.text = `${first}\n${second} 比較して`;
  await h.ready();
  const draft = h.text;
  let closed = h.open();
  assert.ok(h.overlay);
  assert.ok(h.overlay.render(120).length > h.widget.render(120).length);
  h.overlay.handleInput('\x1b[D');
  await h.ready();
  assert.deepEqual(bytesOf(h.overlay), red);
  h.overlay.handleInput('\r'); await closed;
  assert.equal(h.overlay, undefined);
  assert.equal(h.text, draft);
  closed = h.open();
  h.overlay.handleInput('\x1b'); await closed;
  assert.equal(h.text, draft);
}));

test('画像をクリックすると拡大し、送信相当の入力消去で画像の配置も消える', () => withUI(async h => {
  h.text = first; await h.ready();
  h.tui.start(); await delay(80);
  assert.match(h.frames.join(''), /\x1b_Ga=T/);
  assert.equal(h.widget.handleMouse({ type: 'press', button: 'left', x: 2, y: 1 }).handled, true);
  h.widget.handleMouse({ type: 'click', button: 'left', x: 2, y: 1 });
  assert.ok(h.overlay);
  h.overlay.handleInput('\x1b'); await delay(40);
  h.frames.length = 0;
  h.text = ''; h.tui.requestRender(); await delay(80);
  assert.deepEqual(h.widget.render(120), []);
  assert.doesNotMatch(h.tui.getScreenLines().join(''), /画像 1\/1/);
  assert.match(h.frames.join(''), /\x1b_Ga=d/, '取り除いた画像のKitty配置も消す');
}));

test('読み込み中に消した画像は、遅れてプレビューへ戻ってこない', () => withUI(async h => {
  h.text = first;
  assert.match(h.widget.render(120).join(''), /読み込み中/);
  h.text = ''; assert.deepEqual(h.widget.render(120), []);
  await delay(100);
  assert.deepEqual(h.widget.render(120), []);
}));

test('上書きと欠損から復帰し、大きすぎる画像と壊れた画像は短いエラーになる', () => withUI(async h => {
  const path = file(red);
  h.text = path; await h.ready(); assert.deepEqual(bytesOf(h.widget), red);
  writeFileSync(path, blue); await delay(1050); h.widget.render(120); await delay(60);
  assert.deepEqual(bytesOf(h.widget), blue);
  unlinkSync(path); await delay(1050); h.widget.render(120); await delay(60);
  assert.match(h.widget.render(120).join(''), /ファイルが見つかりません/);
  writeFileSync(path, red); await delay(1050); h.widget.render(120); await delay(60);
  assert.deepEqual(bytesOf(h.widget), red);
  const huge = file(Buffer.alloc(0));
  const fd = openSync(huge, 'r+'); ftruncateSync(fd, 21 * 1024 * 1024); closeSync(fd);
  h.text = huge; await h.ready(); assert.match(h.widget.render(120).join(''), /20 MiB/);
  h.text = file(Buffer.from('not an image')); await h.ready();
  assert.match(h.widget.render(120).join(''), /画像形式/);
}));

test('狭い端末では高さを抑え、画像非対応端末でも文字を表示できる', () => withUI(async h => {
  h.text = first; await h.ready();
  for (const [width, rows] of [[120, 40], [30, 12], [12, 8]]) {
    h.terminal.columns = width; h.terminal.rows = rows;
    const lines = h.widget.render(width);
    assert.ok(lines.length <= 1 + Math.max(1, Math.min(6, Math.floor(rows / 5))));
    assert.ok(visibleWidth(lines[0]) <= width);
  }
  setCapabilities({ images: null, trueColor: true, hyperlinks: true }); h.widget.invalidate();
  assert.doesNotMatch(h.widget.render(120).join(''), /\x1b_G/);
  assert.match(h.widget.render(120).join(''), /image\/png/);
}));

test('最大化・高さだけ・同じセル数のresizeで画像本体を再送し、通常描画で再送し続けない', () => withUI(async h => {
  h.text = first; await h.ready();
  h.tui.start(); await delay(80);
  for (const [columns, rows] of [[160, 60], [160, 64], [160, 64], [120, 40]]) {
    h.frames.length = 0; h.terminal.columns = columns; h.terminal.rows = rows;
    process.stdout.emit('resize'); await delay(230);
    assert.match(h.frames.join(''), /\x1b_Ga=T/, `${columns}x${rows}`);
  }
  h.frames.length = 0; h.tui.requestRender(); await delay(80);
  assert.doesNotMatch(h.frames.join(''), /\x1b_Ga=T/);
}));

test('reload・shutdownで古い読み込みとresize購読を残さず、RPCではUIを作らない', () => withUI(async h => {
  h.text = first; await h.ready();
  const listeners = process.stdout.listenerCount('resize');
  const old = h.widget;
  process.stdout.emit('resize');
  h.start(); old.dispose();
  assert.equal(process.stdout.listenerCount('resize'), listeners);
  h.widget.render(120); await h.ready();
  h.requests.length = 0;
  process.stdout.emit('resize'); process.stdout.emit('resize'); process.stdout.emit('resize');
  await delay(230);
  assert.equal(h.requests.filter(value => value === true).length, 1);
  const closed = h.open(); assert.ok(h.overlay);
  await h.stop(); await closed;
  assert.equal(process.stdout.listenerCount('resize'), listeners - 1);
  await extension.handlers.get('session_start')[0]({}, { mode: 'rpc', ui: { setWidget() { assert.fail('RPCでUIを作らない'); } } });
}));

test('実TUIの拡大overlayに画像を送り、resizeとキー入力後に本文へ戻る', () => withUI(async h => {
  h.text = first; await h.ready();
  h.tui.start(); await delay(80);
  h.frames.length = 0;
  const closed = h.open(); await delay(80);
  assert.match(h.frames.join(''), /\x1b_Ga=T/);
  assert.match(h.tui.getScreenLines().join(''), /閉じる/);
  h.frames.length = 0;
  h.terminal.rows = 60; process.stdout.emit('resize'); await delay(230);
  assert.match(h.frames.join(''), /\x1b_Ga=T/);
  h.terminal.input('\r'); await closed; await delay(80);
  assert.equal(h.overlay, undefined);
  assert.equal(h.text, first);
  assert.match(h.tui.getScreenLines().join(''), /本文入力欄/);
  assert.doesNotMatch(h.tui.getScreenLines().join(''), /閉じる/);
}));

test('既存image-paneと併用して両方を描画でき、resize購読も両方解除される', { skip: existsSync(imagePaneSource) ? false : 'image-pane.ts が見つからない（IMAGE_PANE_EXTENSION で指定）' }, () => withUI(async h => {
  const legacy = await loadExtensions([imagePaneSource], run);
  assert.deepEqual(legacy.errors, []);
  const imagePane = legacy.extensions[0];
  const listeners = process.stdout.listenerCount('resize');
  let helper;
  const context = { ...h.context, ui: { ...h.context.ui,
    setWidget: (_name, factory) => { helper = factory(h.tui, theme); },
  } };
  try {
    await imagePane.handlers.get('session_start')[0]({}, context);
    const existing = imagePane.entryRenderers.get('image-inline')({ id: 'previous-picture', data: { path: first } }, {}, theme);
    h.tui.addChild(existing);
    h.text = second; await h.ready();
    h.tui.start(); await delay(80);
    assert.deepEqual(bytesOf(existing), red);
    assert.deepEqual(bytesOf(h.widget), blue);
    h.frames.length = 0;
    process.stdout.emit('resize'); await delay(230);
    assert.ok((h.frames.join('').match(/\x1b_Ga=T/g) ?? []).length >= 2);
    assert.equal(process.stdout.listenerCount('resize'), listeners + 2);
  } finally {
    helper?.dispose();
    await imagePane.handlers.get('session_shutdown')[0]({}, context);
  }
  assert.equal(process.stdout.listenerCount('resize'), listeners + 1);
}));

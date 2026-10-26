import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { piRoot } from './pi-root.mjs';

const run = mkdtempSync(join(tmpdir(), 'image-pane-test-'));
process.env.LOCALAPPDATA = join(run, 'local');
process.env.TERM_PROGRAM = 'WezTerm';
delete process.env.IMAGE_PANE_DEBUG_LOG;
const settings = join(run, '.pi/settings.json');
mkdirSync(dirname(settings), { recursive: true });
const setNativeImages = showImages => writeFileSync(settings, JSON.stringify({ terminal: { showImages } }));
setNativeImages(false);
const packageDir = piRoot();
const tuiDir = join(packageDir, 'node_modules/@earendil-works/pi-tui/dist');
const { loadExtensions } = await import(pathToFileURL(join(packageDir, 'dist/core/extensions/loader.js')));
const { TuiAltScreen } = await import(pathToFileURL(join(tuiDir, 'tui-alt-screen.js')));
const { setCapabilities } = await import(pathToFileURL(join(tuiDir, 'terminal-image.js')));
setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
const source = process.env.IMAGE_PANE_EXTENSION ?? fileURLToPath(new URL('../pi/image-pane.ts', import.meta.url));
const loaded = await loadExtensions([source], run);
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
const entries = [];
loaded.runtime.appendEntry = (customType, data) => entries.push({ customType, data });
const theme = { fg: (_color, value) => value, bold: value => value };
let widget;
const requests = [];
const ctx = {
  cwd: run, mode: 'tui',
  ui: {
    theme, notify() {}, setStatus() {},
    setWidget(_name, factory) { widget = factory({ requestRender: force => requests.push(force) }); },
  },
};
let id = 0;
const renderer = extension.entryRenderers.get('image-inline');
const view = path => renderer({ id: `test-${++id}`, data: { path } }, {}, theme);
const hook = extension.handlers.get('tool_result')[0];
const start = context => extension.handlers.get('session_start')[0]({}, context);
const shutdown = async () => {
  widget?.dispose();
  for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({}, ctx);
};
after(shutdown);

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
function png(color) {
  const width = 960, height = 640;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels.set([...color, 255], y * stride + x * 4 + 1);
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const red = png([255, 0, 0]), blue = png([0, 0, 255]);
const normalPath = join(run, 'normal.png');
writeFileSync(normalPath, red);
function imageBytes(component) {
  const line = component.render(120).join('');
  const chunks = [...line.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)]
    .filter(match => match[1].includes('a=T') || /(?:^|,)m=[01](?:,|$)/.test(match[1]));
  return Buffer.from(chunks.map(match => match[2]).join(''), 'base64');
}
async function emit(event) {
  entries.length = 0;
  const delivered = { toolCallId: `tool-${++id}`, isError: false, ...event };
  const before = structuredClone(delivered);
  const result = await hook(delivered, ctx);
  assert.deepEqual(delivered, before);
  assert.equal(result, undefined);
  return entries.map(entry => structuredClone(entry));
}
const generatedEvent = path => ({
  toolName: 'generate_image', input: {},
  content: [{ type: 'text', text: `画像: ${path}（seed 42）` }],
  details: { generatedImages: [{ path, seed: 42 }], vision: { attachedPaths: [] } },
});
const imageBlock = { type: 'image', mimeType: 'image/png', data: red.toString('base64') };

test('同名上書き後のimgshowは更新後の画像を描く', async () => {
  const path = join(run, 'overwrite.png');
  writeFileSync(path, red);
  assert.deepEqual(imageBytes(view(path)), red);
  writeFileSync(path, blue);
  entries.length = 0;
  await extension.commands.get('imgshow').handler(`"${path}"`, ctx);
  assert.deepEqual(imageBytes(view(entries[0].data.path)), blue);
});

test('欠損ファイルが戻ったら画像表示が復帰する', () => {
  const path = join(run, 'missing.png');
  assert.match(view(path).render(120)[0], /画像を読めない/);
  writeFileSync(path, red);
  assert.deepEqual(imageBytes(view(path)), red);
  unlinkSync(path);
  assert.match(view(path).render(120)[0], /画像を読めない/);
  writeFileSync(path, blue);
  assert.deepEqual(imageBytes(view(path)), blue);
});

test('空白・日本語を含む生成画像は構造化パスと本文の両方から拾える', async () => {
  const path = join(run, '生成 画像（試験）', 'output.png');
  mkdirSync(dirname(path)); writeFileSync(path, red);
  for (const event of [generatedEvent(path), { ...generatedEvent(path), details: undefined }, generatedEvent(path.replaceAll('\\', '/'))]) {
    const result = await emit(event);
    assert.equal(result.length, 1);
    assert.deepEqual(readFileSync(result[0].data.path), red);
  }
  assert.equal((await emit(generatedEvent(normalPath))).length, 1);
});

test('read画像・ファイルのない画像blockを表示し、モデル用の結果を変えない', async () => {
  const read = await emit({ toolName: 'read', input: { path: normalPath }, content: [imageBlock] });
  assert.equal(read.length, 1);
  assert.equal(read[0].data.path, normalPath);
  const capture = await emit({ toolName: 'capture_screen', input: {}, content: [imageBlock] });
  assert.equal(capture.length, 1);
  assert.deepEqual(readFileSync(capture[0].data.path), red);
});

test('pi本体の画像表示がONなら添付画像を二重に描かない', async () => {
  setNativeImages(true);
  try {
    assert.equal((await emit({ toolName: 'read', input: { path: normalPath }, content: [imageBlock] })).length, 0);
    const event = generatedEvent(normalPath);
    event.content.push(imageBlock);
    event.details.vision.attachedPaths = [normalPath];
    assert.equal((await emit(event)).length, 0);
    assert.equal((await emit(generatedEvent(normalPath))).length, 1);
  } finally { setNativeImages(false); }
});

test('外部ビューアのqueueが壊れていても会話内に画像を描く', async () => {
  const queue = join(process.env.LOCALAPPDATA, 'imgpane/queue.txt');
  unlinkSync(queue); mkdirSync(queue);
  try {
    assert.equal((await emit({ toolName: 'read', input: { path: normalPath }, content: [imageBlock] })).length, 1);
    assert.equal((await emit(generatedEvent(normalPath))).length, 1);
  } finally { rmdirSync(queue); }
});

test('拡大・遅いdoubleclick折畳み・再展開・Alt+Iを維持する', async () => {
  await start(ctx);
  const component = view(normalPath);
  const normalRows = component.render(120).length;
  const click = count => component.handleMouse({ type: 'click', button: 'left', clickCount: count, x: 1, y: 1 });
  try {
    click(1); await delay(190);
    const largeRows = component.render(120).length;
    assert.ok(largeRows > normalRows);
    click(1); await delay(190);
    assert.equal(component.render(120).length, largeRows);
    click(2);
    assert.match(component.render(120)[0], /^▸ 画像/);
    click(1);
    assert.equal(component.render(120).length, normalRows);
    await extension.shortcuts.get('alt+i').handler(ctx);
    assert.match(component.render(120)[0], /^▸ 画像/);
    await extension.shortcuts.get('alt+i').handler(ctx);
    assert.equal(component.render(120).length, normalRows);
    await delay(550);
  } finally { await shutdown(); }
});

test('Alt左クリックは保存場所を開き、通常クリックの待機や折畳み状態を変えない', async () => {
  const path = join(run, '保存先 日本語 & (画像),1.png');
  writeFileSync(path, red);
  const child = new EventEmitter();
  child.unref = () => {};
  const launch = mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  await start(ctx);
  const component = view(path);
  const normalRows = component.render(120).length;
  const mouse = (type, alt = false, clickCount = 1) => component.handleMouse({
    type, button: 'left', alt, clickCount, x: 1, y: 1,
  });
  try {
    mouse('click');
    mouse('press', true);
    assert.equal(launch.mock.callCount(), 0);
    mouse('click', true, 2);
    await delay(190);
    assert.equal(component.render(120).length, normalRows);
    assert.equal(launch.mock.callCount(), 1);
    const [executable, args, options] = launch.mock.calls[0].arguments;
    assert.equal(executable, 'explorer.exe');
    assert.deepEqual(args, ['/select,', path]);
    assert.notEqual(options.shell, true);
    assert.equal(options.windowsHide, false, '保存場所のウィンドウを隠さない');
    mouse('click', false, 2);
    const folded = component.render(120);
    mouse('click', true);
    assert.deepEqual(component.render(120), folded);
    assert.equal(launch.mock.callCount(), 2);
    assert.equal(component.handleMouse({ type: 'click', button: 'right', alt: true }), undefined);
    assert.equal(launch.mock.callCount(), 2);
    assert.doesNotThrow(() => child.emit('error', new Error('Explorer unavailable')));
  } finally {
    await shutdown();
    launch.mock.restore();
    syncBuiltinESMExports();
  }
});

test('最大化・高さだけの変更・同じセル寸法のresizeでも画像本体を再送する', async () => {
  const frames = [];
  const terminal = {
    columns: 120, rows: 40,
    start(_input, resize) { this.resize = resize; process.stdout.on('resize', resize); },
    stop() { process.stdout.off('resize', this.resize); },
    write(data) { frames.push(data); }, hideCursor() {}, showCursor() {},
  };
  const tui = new TuiAltScreen(terminal);
  const context = { ...ctx, ui: { ...ctx.ui, setWidget(_name, factory) { widget = factory(tui); } } };
  const listenersBefore = process.stdout.listenerCount('resize');
  await start(context);
  tui.addChild(view(normalPath));
  const uploadCount = () => (frames.join('').match(/\x1b_Ga=T/g) ?? []).length;
  try {
    tui.start(); await delay(200);
    assert.ok(uploadCount() > 0);
    for (const [columns, rows] of [[180, 60], [180, 64], [180, 64], [120, 40]]) {
      frames.length = 0;
      terminal.columns = columns; terminal.rows = rows;
      process.stdout.emit('resize'); await delay(250);
      assert.ok(uploadCount() > 0, `${columns}x${rows}で画像本体が再送されていない`);
    }
    frames.length = 0;
    tui.requestRender(); await delay(80);
    assert.equal(uploadCount(), 0, '通常の描画で画像を毎回再送しない');
  } finally {
    await shutdown(); tui.stop({ preserveScreen: true });
  }
  assert.equal(process.stdout.listenerCount('resize'), listenersBefore);
});

test('resizeの連発をまとめ、reload後にlistenerや古いtimerを残さない', async () => {
  const listenersBefore = process.stdout.listenerCount('resize');
  requests.length = 0;
  await start(ctx);
  const oldWidget = widget;
  process.stdout.emit('resize');
  await start(ctx);
  oldWidget.dispose();
  assert.equal(process.stdout.listenerCount('resize'), listenersBefore + 1);
  process.stdout.emit('resize'); process.stdout.emit('resize'); process.stdout.emit('resize');
  await delay(250);
  assert.deepEqual(requests, [true]);
  requests.length = 0;
  process.stdout.emit('resize');
  await shutdown(); await delay(200);
  assert.equal(process.stdout.listenerCount('resize'), listenersBefore);
  assert.deepEqual(requests, []);
});

test('/imgpane は同じパッケージのビューアを横に開く', async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const launch = mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  try {
    // 先に読み込んだ拡張は前のテストの差し替えを掴んでいることがあるので、差し替え後に読み直す。
    const fresh = await loadExtensions([source], run);
    await fresh.extensions[0].commands.get('imgpane').handler('', ctx);
    const [executable, args] = launch.mock.calls[0].arguments;
    assert.equal(executable, 'wt.exe');
    const viewer = args[args.indexOf('/c') + 1];
    assert.equal(viewer, fileURLToPath(new URL('../viewer/imgpane.bat', import.meta.url)));
    assert.ok(existsSync(viewer));
  } finally {
    launch.mock.restore();
    syncBuiltinESMExports();
  }
});

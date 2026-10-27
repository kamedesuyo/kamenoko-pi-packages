import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { extension, imagePaneSource, workDir, writePng } from './fixtures.mjs';
import { piRoot } from './pi-root.mjs';

const packageDir = piRoot();
const { loadExtensions } = await import(pathToFileURL(join(packageDir, 'dist/core/extensions/loader.js')));
const { setCapabilities } = await import(pathToFileURL(join(packageDir, 'node_modules/@earendil-works/pi-tui/dist/terminal-image.js')));
const { TuiAltScreen } = await import(pathToFileURL(join(packageDir, 'node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js')));
const { ToolExecutionComponent } = await import(pathToFileURL(join(packageDir, 'dist/modes/interactive/components/tool-execution.js')));
const { initTheme } = await import(pathToFileURL(join(packageDir, 'dist/modes/interactive/theme/theme.js')));
initTheme('dark', false);
setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
const loaded = await loadExtensions([extension('generate-image-qwen.ts'), extension('generate-image.ts'), imagePaneSource], workDir);
assert.deepEqual(loaded.errors, []);
const fixture = writePng('preview.png', 96, 96, 1);
const second = writePng('second.png', 96, 96, 2);
const preview = readFileSync(fixture).toString('base64');
const theme = { fg: (_color, text) => text };
let send;
const mocked = mock.method(childProcess, 'spawn', () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  process.nextTick(() => send(child));
  return child;
});
syncBuiltinESMExports();
test.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });

for (const [extensionIndex, name, params, key, prefix] of [
  [0, 'generate_image_qwen', { prompt: 'x' }, 'qwenProgress', 'QWEN_EVENT'],
  [1, 'generate_image', { tags: 'x' }, 'imageProgress', 'IMAGE_EVENT'],
]) {
const tool = loaded.extensions[extensionIndex].tools.get(name).definition;
const event = (fields) => `${prefix} ${JSON.stringify({ type: 'progress', ...fields })}\r\n`;

test(`${name}: 分割されたUTF-8とイベントから途中画像・進捗を更新し、完成結果にプレビューを残さない`, async () => {
  send = (child) => {
    for (const byte of Buffer.from('準備しています\r\n')) child.stdout.emit('data', Buffer.from([byte]));
    const data = Buffer.from('\n\n\n' + event({ phase: 'sampling', index: 1, count: 2, step: 1, steps: 4, preview }));
    for (let i = 0; i < data.length; i += 777) child.stdout.emit('data', data.subarray(i, i + 777));
    child.stdout.emit('data', Buffer.from(event({ phase: 'decoding', index: 1, count: 2 })));
    child.stdout.emit('data', Buffer.from(event({ phase: 'sampling', index: 2, count: 2, step: 0, steps: 4 })));
    child.stdout.emit('data', Buffer.from(`画像: ${fixture}（seed 42）`));
    child.emit('close', 0);
  };
  const updates = [];
  const result = await tool.execute('stream-test', params, undefined, (u) => updates.push(u), { cwd: workDir });
  assert.equal(mocked.mock.calls.at(-1).arguments[2].env.GEN_IMAGE_PROGRESS_EVENTS, '1');
  const partial = updates.find(u => u.details?.[key]?.preview);
  assert.ok(partial.content[0].text.includes('25%'));
  assert.ok(partial.content[0].text.includes('1/4 step'));
  assert.equal(updates.find(u => u.details?.[key]?.phase === 'decoding').details[key].preview, preview);
  assert.equal(updates.find(u => u.details?.[key]?.index === 2).details[key].preview, undefined);
  // generate_image は 2026-10-26、generate_image_qwen は 2026-10-27 から生成後もターンを続ける。
  assert.notEqual(result.terminate, true);
  assert.equal(result.content.length, 1);
  assert.ok(result.content[0].text.includes('準備しています'));
  assert.ok(!JSON.stringify(result).includes(prefix));
  assert.ok(!JSON.stringify(result).includes(preview));
  assert.ok(!result.content[0].text.includes('\n\n\n'), 'event separators must not expand the final tool result');
  const view = tool.renderResult(partial, { isPartial: true }, theme, {});
  const first = view.render(100).join('\n');
  assert.ok(first.includes('\x1b_G'), 'terminal receives image pixels even with native images disabled');
  assert.ok(first.includes('途中プレビュー'));
  view.invalidate();
  assert.ok(view.render(60).join('\n').includes('\x1b_G'));
  const final = tool.renderResult(result, { isPartial: false }, theme, { lastComponent: view });
  assert.ok(!final.render(100).join('\n').includes('\x1b_G'), 'final image is left to image-pane');
});

test(`${name}: 途中画像の後でも子プロセスの失敗は成功へ変えない`, async () => {
  send = (child) => {
    child.stdout.emit('data', Buffer.from(event({ phase: 'sampling', step: 1, steps: 4, preview })));
    child.stderr.emit('data', Buffer.from('VRAM復帰エラー'));
    child.emit('close', 1);
  };
  await assert.rejects(tool.execute('failure', params, undefined, () => {}, {}), /VRAM復帰エラー/);
});

test(`${name}: pi本体のツール欄でも画像を更新し、端末サイズ変更後に再送できる`, async () => {
  const frames = [];
  const terminal = {
    columns: 100, rows: 40,
    start(_input, resize) { this.resize = resize; }, stop() {},
    write(data) { frames.push(data); }, hideCursor() {}, showCursor() {},
  };
  const tui = new TuiAltScreen(terminal);
  const pane = loaded.extensions[extensionIndex];
  let widget;
  await pane.handlers.get('session_start')[0]({}, {
    mode: 'tui', ui: { setWidget(_key, factory) { widget = factory(tui); } },
  });
  const row = new ToolExecutionComponent(name, 'row-test', params,
    { showImages: false }, tool, tui, workDir);
  const update = (data, percent) => {
    row.updateResult({ content: [{ type: 'text', text: `描画中 ${percent}%` }],
      details: { [key]: { phase: 'sampling', preview: data } } }, true);
    tui.requestRender();
  };
  tui.addChild(row);
  try {
    update(preview, 25); tui.start(); await delay(100);
    assert.ok(frames.join('').includes('\x1b_Ga=T'));
    frames.length = 0;
    update(readFileSync(second).toString('base64'), 50);
    await delay(100);
    assert.ok(frames.join('').includes('\x1b_Ga=T'), 'second frame must be uploaded');
    for (const [columns, rows] of [[60, 35], [120, 50], [120, 55], [120, 55]]) {
      frames.length = 0;
      terminal.columns = columns; terminal.rows = rows;
      terminal.resize(); process.stdout.emit('resize'); await delay(220);
      assert.ok(frames.join('').includes('\x1b_Ga=T'), `image upload on resize ${columns}x${rows}`);
    }
  } finally {
    widget?.dispose();
    await pane.handlers.get('session_shutdown')[0]();
    tui.stop({ preserveScreen: true });
  }
});
}

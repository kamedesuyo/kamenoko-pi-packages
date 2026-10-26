import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, mock } from "node:test";
import { extension, workDir, writePng } from "./fixtures.mjs";
import { piRoot } from "./pi-root.mjs";

const { loadExtensions } = await import(pathToFileURL(join(piRoot(), "dist/core/extensions/loader.js")));
const loaded = await loadExtensions([extension("generate-image.ts")], workDir);
assert.deepEqual(loaded.errors, []);
const imageTool = loaded.extensions[0].tools.get("generate_image");
const fixture = writePng("legacy-size.png");
const ctx = { cwd: workDir, model: { provider: "localllm", input: ["text"] } };
// 偽の spawn はファイルで1回だけ差し込む（テストごとに付け外しすると、後のテストの呼び出しが前の偽物へ届く）。
const calls = [];
mock.method(childProcess, "spawn", (command, args) => {
	calls.push(args);
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	process.nextTick(() => {
		child.stdout.emit("data", Buffer.from(`画像: ${fixture}（seed 42）\n`));
		child.emit("close", 0);
	});
	return child;
});
syncBuiltinESMExports();

const sizeOf = (args) => args[args.indexOf("-Size") + 1];
const run = (params) => imageTool.definition.execute("size-test", params, undefined, undefined, ctx);

test("旧SDXL（tagsだけ）は同じ寸法の指定を名前に戻して gen-image.ps1 へ渡す", async () => {
	calls.length = 0;
	for (const [size, named] of [["portrait", "portrait"], ["1216x832", "landscape"], ["832X1216", "portrait"], ["1024x1024", "square"]]) {
		await run({ tags: "small robot", size });
		assert(calls.at(-1).some((a) => a.endsWith("gen-image.ps1")));
		assert.equal(sizeOf(calls.at(-1)), named, size);
	}
});

test("旧SDXLで扱えない寸法は、子プロセスを起こす前に理由つきで断る", async () => {
	calls.length = 0;
	await assert.rejects(run({ tags: "small robot", size: "768x1024" }), /tags-only legacy SDXL path.*portrait \(832x1216\)/);
	assert.equal(calls.length, 0);
});

test("profile経由の寸法指定は従来どおり（名前はQwenの寸法、数値はそのまま）", async () => {
	calls.length = 0;
	await run({ prompt: "a red fox in the snow", size: "portrait" });
	await run({ prompt: "a red fox in the snow", size: "768x1024" });
	assert(calls.every((args) => args.some((a) => a.endsWith("gen-image-profile.ps1"))));
	assert.deepEqual(calls.map(sizeOf), ["832x1248", "768x1024"]);
});

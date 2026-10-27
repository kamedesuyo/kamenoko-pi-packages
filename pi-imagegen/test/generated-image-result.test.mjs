import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, mock } from "node:test";
import { extension, imagePaneSource, workDir, writePng } from "./fixtures.mjs";
import { piRoot } from "./pi-root.mjs";

const packageDir = piRoot();
const { loadExtensions } = await import(pathToFileURL(join(packageDir, "dist/core/extensions/loader.js")));
const loaded = await loadExtensions([extension("generate-image.ts"), extension("generate-image-qwen.ts"), imagePaneSource], workDir);
assert.deepEqual(loaded.errors, []);
const tools = new Map(loaded.extensions.flatMap((extension) => [...extension.tools]));
const fixture = writePng("fixture.png");
const ctx = { cwd: workDir, model: { input: ["text", "image"] } };
let output;
let exitCode;
const spawnMock = mock.method(childProcess, "spawn", () => {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	process.nextTick(() => {
		child.stdout.emit("data", Buffer.from(output));
		child.emit("close", exitCode);
	});
	return child;
});
syncBuiltinESMExports();

async function run(name, params = {}, context = ctx) {
	const registered = tools.get(name);
	return registered.definition.execute("review-test", { tags: "red fox, snow", prompt: "A red fox in the snow.", ...params }, undefined, undefined, context);
}

// generate_image は 2026-10-26、generate_image_qwen は 2026-10-27 から生成後もターンを続ける（follow_up は互換のため受け取るだけ）。
const endsTurn = () => false;

test("通常生成は画像対応モデルでも確認せず表示し、ターンは終了しない", async () => {
	exitCode = 0;
	output = `画像: ${fixture}（seed 42）\r\n全体 39 秒`;
	for (const name of ["generate_image", "generate_image_qwen"]) {
		for (const params of [{}, { review: false }, { follow_up: false }]) {
			const result = await run(name, params);
			assert.equal(result.terminate === true, endsTurn(name), name);
			assert.equal(result.details.vision.status, "skipped");
			assert.equal(result.content.some((block) => block.type === "image"), false);
			assert.ok(result.content[0].text.includes(fixture));
		}
		const continued = await run(name, { follow_up: true });
		assert.notEqual(continued.terminate, true);
		assert.equal(continued.content.some((block) => block.type === "image"), false);
	}
});

test("明示した画像確認では画像を読み、follow_upなし/falseでも確認を続ける", async () => {
	exitCode = 0;
	output = `画像: ${fixture}（seed 42）\r\n全体 39 秒`;
	for (const name of ["generate_image", "generate_image_qwen"]) {
		for (const params of [{}, { follow_up: false }]) {
			const result = await run(name, { ...params, review: true });
			assert.notEqual(result.terminate, true);
			assert.equal(result.details.vision.status, "attached");
			assert.deepEqual(result.details.vision.attachedPaths, [fixture]);
			const images = result.content.filter((block) => block.type === "image");
			assert.equal(images.length, 1);
			assert.ok(Buffer.from(images[0].data, "base64").length > 1000);
		}
	}
});

test("複数枚と半角括弧の結果も画像本体を渡す", async () => {
	output = `画像: ${fixture} (seed 42)\n画像: ${fixture}（seed 43）`;
	const result = await run("generate_image", { review: true });
	assert.equal(result.content.filter((block) => block.type === "image").length, 2);
	assert.equal(result.details.generatedImages[1].seed, 43);
});

test("画像非対応モデルは画像を読まず未確認にし、ターンは常に続く", async () => {
	output = `画像: ${fixture}（seed 42）`;
	const textOnly = { ...ctx, model: { input: ["text"] } };
	for (const name of ["generate_image", "generate_image_qwen"]) {
		const stopped = await run(name, { review: true }, textOnly);
		assert.equal(stopped.terminate === true, endsTurn(name), name);
		assert.equal(stopped.content.some((block) => block.type === "image"), false);
		assert.equal(stopped.details.vision.status, "unavailable");
		assert.notEqual((await run(name, { review: true, follow_up: true }, textOnly)).terminate, true);
	}
});

test("生成後の画像読み込み失敗は未確認として続け、生成失敗はエラーを維持する", async () => {
	output = `画像: ${join(workDir, "missing-review-fixture.png")}（seed 1）`;
	const result = await run("generate_image", { review: true });
	assert.equal(result.details.vision.status, "failed");
	assert.equal(result.content.some((block) => block.type === "image"), false);
	assert.notEqual(result.terminate, true);
	output = "generation failed";
	exitCode = 1;
	await assert.rejects(run("generate_image"), /generation failed/);
	await assert.rejects(run("generate_image_qwen"), /generation failed/);
	exitCode = 0;
});

test("添付済み画像は二重表示しないが、従来のパスだけの画像表示は維持する", async () => {
	const directory = fs.mkdtempSync(join(tmpdir(), "generated-image-result-"));
	fs.mkdirSync(join(directory, ".pi"));
	fs.writeFileSync(join(directory, ".pi/settings.json"), JSON.stringify({ terminal: { showImages: true } }));
	const nativeImageContext = { ...ctx, cwd: directory };
	const entries = [];
	loaded.runtime.appendEntry = (type, data) => entries.push({ type, data });
	const queueMock = mock.method(fs, "appendFileSync", () => {});
	syncBuiltinESMExports();
	try {
		const pane = loaded.extensions.find((extension) => extension.path.endsWith("image-pane.ts"));
		const handler = pane.handlers.get("tool_result")[0];
		const event = { toolName: "generate_image", content: [{ type: "text", text: `画像: ${fixture}（seed 42）` }], details: { vision: { attachedPaths: [fixture] } } };
		await handler(event, nativeImageContext);
		assert.equal(entries.length, 0);
		await handler({ ...event, details: undefined }, nativeImageContext);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].data.path, fixture);
	} finally {
		queueMock.mock.restore();
		syncBuiltinESMExports();
		fs.unlinkSync(join(directory, ".pi/settings.json"));
		fs.rmdirSync(join(directory, ".pi"));
		fs.rmdirSync(directory);
	}
});

test.after(() => {
	spawnMock.mock.restore();
	syncBuiltinESMExports();
});

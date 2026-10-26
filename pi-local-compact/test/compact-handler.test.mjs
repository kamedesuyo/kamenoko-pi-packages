import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { findPiRoot } from "../src/local-compact-health.mjs";

process.env.PI_LOCAL_COMPACT_PROVIDERS = "localllm-llamacpp-local";
const packageDir = await findPiRoot(null);
const { loadExtensions } = await import(pathToFileURL(join(packageDir, "dist/core/extensions/loader.js")));
const { createFileOps } = await import(pathToFileURL(join(packageDir, "dist/core/compaction/utils.js")));
const loaded = await loadExtensions([fileURLToPath(new URL("../extensions/local-compact.ts", import.meta.url))], process.cwd());
assert.deepEqual(loaded.errors, []);
const handler = loaded.extensions[0].handlers.get("session_before_compact")[0];

function fixture(stopReason = "stop") {
	const requests = [], notices = [];
	const event = { signal: new AbortController().signal, customInstructions: "Keep the pending check.", branchEntries: [], preparation: {
		firstKeptEntryId: "keep-this-entry", tokensBefore: 1024, isSplitTurn: false,
		messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "Keep D:/fixture/task.py" }], timestamp: 0 }],
		turnPrefixMessages: [], previousSummary: "Existing goal", fileOps: createFileOps(),
		settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
	} };
	event.preparation.fileOps.read.add("D:/fixture/task.py");
	const ctx = { cwd: process.cwd(), model: { id: "coder390", provider: "localllm-llamacpp-local", reasoning: true, maxTokens: 65536 },
		sessionManager: { getSessionId: () => "fixture-session" },
		ui: { notify: (...args) => notices.push(args) }, modelRegistry: { streamSimple(model, context, options) {
			requests.push({ model, context, options });
			return { result: async () => ({ role: "assistant", stopReason, content: [{ type: "text", text: "Goal retained. Next: run the pending check." }],
				usage: { input: 100, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 112, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) };
		} } };
	return { event, ctx, requests, notices };
}

test("標準の要約・保持境界・ファイル一覧を維持し、要約だけ思考を止める", async () => {
	const { event, ctx, requests } = fixture();
	const result = await handler(event, ctx);
	assert.equal(result.compaction.firstKeptEntryId, event.preparation.firstKeptEntryId);
	assert.equal(result.compaction.tokensBefore, 1024);
	assert.deepEqual(result.compaction.details.readFiles, ["D:/fixture/task.py"]);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].options.signal, event.signal);
	const input = { messages: ["unchanged"], max_tokens: 65536, chat_template_kwargs: { preserve_thinking: true } };
	const before = structuredClone(input);
	assert.deepEqual(await requests[0].options.onPayload(input), { ...before, cache_prompt: true, chat_template_kwargs: { preserve_thinking: true, enable_thinking: false } });
	assert.deepEqual(input, before);
});

test("ターン分割時は両方の標準要約へ思考OFFを指定する", async () => {
	const { event, ctx, requests } = fixture();
	event.preparation.isSplitTurn = true;
	event.preparation.turnPrefixMessages = event.preparation.messagesToSummarize;
	const result = await handler(event, ctx);
	assert.ok(result.compaction);
	assert.equal(requests.length, 2);
	for (const request of requests) assert.equal((await request.options.onPayload({})).chat_template_kwargs.enable_thinking, false);
});

test("出力上限で途切れた要約は保存しない", async () => {
	const { event, ctx, notices } = fixture("length");
	assert.deepEqual(await handler(event, ctx), { cancel: true });
	assert.ok(notices.some(([message]) => /incomplete/.test(message)), JSON.stringify(notices));
});

test("別providerのcompactは引き受けない", async () => {
	const { event, ctx, requests } = fixture();
	ctx.model.provider = "other";
	assert.equal(await handler(event, ctx), undefined);
	assert.equal(requests.length, 0);
});

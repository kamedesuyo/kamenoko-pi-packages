import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, mock } from "node:test";
import { extension, strataIntegrationSource, workDir } from "./fixtures.mjs";
import { piRoot } from "./pi-root.mjs";

// strata-integration は別の部品なので、見つからない時はこのファイルの検査を飛ばす。
const skip = strataIntegrationSource ? false : "strata-integration.ts が見つからない（STRATA_INTEGRATION_EXTENSION で指定）";
const packageDir = piRoot();
const { loadExtensions } = await import(pathToFileURL(join(packageDir, "dist/core/extensions/loader.js")));
const loaded = skip ? undefined : await loadExtensions([strataIntegrationSource, extension("generate-image.ts")], workDir);
if (loaded) assert.deepEqual(loaded.errors, []);
const routing = loaded?.extensions[0];
const imageTool = loaded?.extensions[1].tools.get("generate_image");
const ctx = { cwd: workDir, model: { provider: "localllm-strata", input: ["text", "image"] } };

test("StrataのQwenは画像APIがある場合だけ許可する", { skip }, async () => {
  let ready = false;
  const fake = mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ service: "strata", image_generation: ready }) }));
  try {
    for (const handler of routing.handlers.get("tool_call")) {
      assert.equal(await handler({ toolName: "generate_image" }, ctx), undefined);
      assert.equal((await handler({ toolName: "generate_image_qwen" }, ctx)).block, true);
      ready = true;
      assert.equal(await handler({ toolName: "generate_image_qwen" }, ctx), undefined);
      assert.equal(await handler({ toolName: "generate_image_qwen" }, { model: { provider: "localllm" } }), undefined);
    }
  } finally { fake.mock.restore(); }
});

test("Strataの画像生成では専用4060を明示し従来経路ではautoを保つ", { skip }, async () => {
  const calls = [];
  const spawnMock = mock.method(childProcess, "spawn", (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit("data", Buffer.from(`画像: ${join(workDir, "fixture.png")}（seed 42）\n`));
      child.emit("close", 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    for (const context of [ctx, { ...ctx, model: { provider: "localllm", input: ["text"] } }]) {
      const result = await imageTool.definition.execute("routing-test", { tags: "small robot" }, undefined, undefined, context);
      assert.equal(result.details.generatedImages.length, 1);
    }
    assert.deepEqual(calls[0].args.slice(-2), ["-Gpu", "rtx4060"]);
    assert.equal(calls[1].args.includes("-Gpu"), false);
    const prompt = '"日本語" $(not-code)';
    const result = await imageTool.definition.execute("profile-test", {profile:"my-model", prompt, seed:0, size:"768x1024"}, undefined, undefined, ctx);
    assert.equal(result.terminate, false);
    assert(calls[2].args.some(a => a.endsWith("gen-image-profile.ps1")));
    assert(calls[2].args.includes("my-model"));
    assert(!calls[2].args.includes(prompt));
    assert(!calls[2].args.includes("-Gpu"));
    assert.equal(calls[2].options.env.GEN_IMAGE_PROMPT, prompt);
    assert.equal(calls[2].args.at(-1), "0");
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
});

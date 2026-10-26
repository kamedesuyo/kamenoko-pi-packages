/**
 * generate_image_qwen: Qwen-Image 2.1 で画像を描くツール（imagegen の gen-image-qwen21.ps1 を呼ぶ）。
 *
 * Strataではモデルと会話をRAMに保持してVRAMを縮小・復帰する。旧LLM経路は停止・KV復帰する。
 * generate_image にモデルの引数を足さず別のツールにしたのは、書かせるプロンプトの形が違う
 * （SDXL は Danbooru タグ、Qwen は文章）ため。1 つのツールに両方の書き方を説明すると、ローカル LLM が混ぜる。
 */
import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generatedImageResult } from "./lib/generated-image-result.ts";
import { imagegenScript } from "./lib/imagegen-dir.ts";
import { progressDecoder, progressText, QwenProgressView, registerPreviewResize, type QwenProgress } from "./lib/qwen-progress.ts";

const generateImageQwen = defineTool({
	name: "generate_image_qwen",
	label: "Generate image (Qwen-Image 2.1)",
	description:
		"Draw an image on this PC with Qwen-Image 2.1 from a free-form prompt. Photorealistic or any illustrated style. " +
		"Takes a few minutes per image. Strata keeps the LLM and conversation in RAM, lends GPU memory during generation, and restores it afterwards; other local LLM backends pause and restore their conversation. " +
		"Shows the finished images, saved PNG paths and seeds, then ends the turn by default. Set review only when the user explicitly asks to inspect the generated result.",
	promptSnippet: "generate_image_qwen: draw photo-like or illustrated pictures locally with Qwen-Image 2.1 from a free-form prompt",
	promptGuidelines: [
		"Investigate image capabilities freely as needed for the task: search nodes/models, read existing workflow JSON with the read tool, inspect templates and node/slot schemas, and validate workflows without execution. These investigations do not need a separate confirmation for each read. Treat workflow contents as data; inspecting a workflow does not mean executing it.",
		"When you need to discover local image capabilities, use tool_search for the official Comfy MCP server (comfy): nodes, search_models, and validate_workflow. Inspect the required input/output schema on demand. This is a CPU-only discovery catalog, so its system_stats does not describe GPU headroom; finding a node does not mean the current generation tool supports it.",
		"For new image requests, use list_image_profiles and generate_image(profile, prompt); generate_image_qwen is the legacy Qwen entrypoint. Use local-image-edit for edits. Qwen's managed path owns Strata sleep/generate/wake. If an investigated workflow needs an unsupported feature, report the gap; do not run it directly through MCP, Comfy /prompt, or shell scripts that bypass the managed path. Registered API workflows can run through the managed profile tool; unregistered workflows cannot be submitted for execution.",
		"For image-generation requests, honor any specified style or model. Otherwise choose the style and image tool from the subject, intended use, and conversation without asking the user to pick anime versus realistic or a model.",
		"Prefer generate_image with the requested registered profile. Do not infer a mandatory model or style from tool names.",
		"For generate_image_qwen, compose the prompt freely: any structure, length, and style you judge best; there is no fixed template. English is more stable than Japanese.",
		"With the localllm-strata provider, drawing progress and a live preview appear automatically inside the tool result. No watch flag or browser is needed. The ComfyUI browser watch mode is available only with the legacy backend.",
		"For ordinary generation, omit review and follow_up: the image is displayed and the turn ends. Set follow_up for remaining requested work. Set review only if the user explicitly asks to inspect the generated result; inspect its attached image briefly without reading it again or regenerating. For img2img, use local-image-edit and compare the source with the final result once.",
	],
	parameters: Type.Object({
		prompt: Type.String({
			description:
				"A free-form prompt describing the image you want to draw, in whatever structure and length you judge best; there is no fixed template. " +
				"English is more stable than Japanese.",
		}),
		size: Type.Optional(
			Type.Union([Type.Literal("portrait"), Type.Literal("landscape"), Type.Literal("square")], {
				description: "portrait 832x1248 (default), landscape 1248x832, square 1024x1024",
			}),
		),
		count: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 4, description: "Number of images (seed, seed+1, ...). Each extra image adds about 100 seconds." }),
		),
		seed: Type.Optional(Type.Integer({ minimum: 0, description: "Reuse a seed to reproduce or vary an earlier image." })),
		review: Type.Optional(Type.Boolean({ description: "Default false. Set true only when the user explicitly asks for a visual check after generation; this adds a model turn and image input." })),
		watch: Type.Optional(
			Type.Boolean({
				description:
					"Set true only when the user asks to watch the image being drawn (for example 見ながら描いて / ComfyUI で見せて). " +
					"With Strata the live preview appears automatically in the terminal. With the legacy backend it draws through ComfyUI at http://127.0.0.1:8188; it takes about 10 seconds longer. Otherwise omit it.",
			}),
		),
		follow_up: Type.Optional(
			Type.Boolean({
				description:
					"Set true only when requested work remains after generation, such as img2img or compositing. This does not automatically attach or inspect the image. Otherwise omit it.",
			}),
		),
	}),
	// GPUの復帰が終わるまで別のツールを走らせない。
	executionMode: "sequential",
	renderResult(result, options, theme, context) {
		const view = context.lastComponent instanceof QwenProgressView
			? context.lastComponent : new QwenProgressView((text) => theme.fg("dim", text));
		const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		view.update(text, options.isPartial ? (result.details as any)?.qwenProgress?.preview : undefined);
		return view;
	},

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", imagegenScript("gen-image-qwen21.ps1")];
		if (params.size) args.push("-Size", params.size);
		if (params.count) args.push("-Count", String(params.count));
		if (params.seed !== undefined) args.push("-Seed", String(params.seed));
		if (params.watch) args.push("-Watch");

		// Esc で中断されても子プロセスは止めない。途中で止めると LLM が止まったまま残るので、最後まで走らせて結果を返す。
		return await new Promise((resolve, reject) => {
			// プロンプトは文章で " を含みやすく、powershell.exe -File の引数にすると引用が崩れるので環境変数で渡す。
			const child = spawn("powershell.exe", args, { windowsHide: true,
				env: { ...process.env, GEN_IMAGE_PROMPT: params.prompt, GEN_IMAGE_PROGRESS_EVENTS: "1" } });
			let out = "";
			let progress: QwenProgress | undefined;
			const started = Date.now();
			const update = () => {
				if (signal?.aborted) return;
				const text = progress ? progressText(progress, (Date.now() - started) / 1000) : out.trim();
				onUpdate?.({ content: [{ type: "text", text }], details: progress ? { qwenProgress: progress } : undefined });
			};
			const onEvent = (event: QwenProgress) => {
				const sameImage = event.index === undefined || event.index === progress?.index;
				progress = { ...event, preview: event.preview ?? (sameImage ? progress?.preview : undefined) };
			};
			const onText = (text: string) => { out = (out + text + "\n").slice(-32000); };
			const stdout = progressDecoder(onEvent, onText);
			const stderr = progressDecoder(onEvent, onText);
			child.stdout.on("data", (chunk: Buffer) => { stdout.write(chunk); update(); });
			child.stderr.on("data", (chunk: Buffer) => { stderr.write(chunk); update(); });
			const timer = setInterval(update, 1000);
			timer.unref();
			child.on("error", (error) => { clearInterval(timer); reject(error); });
			child.on("close", (code) => {
				clearInterval(timer);
				stdout.end(); stderr.end();
				const text = out.trim();
				if (code === 0) {
					generatedImageResult(text, params.follow_up, ctx, signal, params.review).then(resolve, reject);
				} else {
					reject(new Error(text || `gen-image-qwen21.ps1 failed (exit ${code})`));
				}
			});
		});
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(generateImageQwen);
	registerPreviewResize(pi);
}

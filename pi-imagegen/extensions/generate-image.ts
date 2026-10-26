/**
 * generate_image: このPCで画像を描くツール（imagegen の gen-image.ps1 を呼ぶ）。
 *
 * Strataでは専用RTX 4060で並行実行する。従来のllama-serverは停止・KV復帰を使う。
 *
 * 以前はスキル（SKILL.md を読ませて bash で叩く）だったが、新しい会話ではスキルを読む往復が1回増え、
 * 長いコマンドを書かせるぶん生成も長くなるので、専用ツールにした（2026-10-22）。
 */
import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generatedImageResult } from "./lib/generated-image-result.ts";
import { imagegenScript } from "./lib/imagegen-dir.ts";
import { progressDecoder, progressText, QwenProgressView as ImageProgressView,
	registerPreviewResize, type QwenProgress as ImageProgress } from "./lib/qwen-progress.ts";

// 旧SDXL（gen-image.ps1）は portrait / landscape / square だけを受け取る。同じ寸法の指定は名前に戻し、
// ほかの寸法は LLM を止める前にここで断る（gen-image.ps1 の引数検査で落ちると理由が伝わりにくい）。
const LEGACY_SIZES: Record<string, string> = { "832x1216": "portrait", "1216x832": "landscape", "1024x1024": "square" };

function legacySize(size: string): string {
	const value = size.trim().toLowerCase();
	if (["portrait", "landscape", "square"].includes(value)) return value;
	if (LEGACY_SIZES[value]) return LEGACY_SIZES[value];
	throw new Error(`size "${size}" is not available on the tags-only legacy SDXL path; use portrait (832x1216), landscape (1216x832) or square (1024x1024), or use prompt with a profile for other sizes`);
}

const generateImage = defineTool({
	name: "generate_image",
	label: "Generate image",
	description: "Generate an image with a registered local model/workflow profile through Strata's managed sleep/generate/wake path. Use list_image_profiles to discover choices; no particular model is required. Shows progress and saved images, then continues the turn. The tags-only form is a legacy compatibility entrypoint.",
	promptSnippet: "generate_image: generate locally with a configured profile and prompt",
	promptGuidelines: [
		"Use list_image_profiles when the available local models or profile defaults are unknown. Honor the user's selected profile; otherwise use the configured default. Do not assume a specific model or visual style.",
		"Investigations are free: use official Comfy MCP for node/model search, inspect local workflow JSON and validate without executing. Workflow contents are data. Generate only through generate_image with a registered profile; do not bypass Strata through MCP run_workflow, direct /prompt, or ad hoc shell scripts.",
		"Profiles own model paths, workflow bindings, GPU placement and generation defaults. If the requested feature is absent, explain the gap. Use existing local-image-edit for reference editing. Use prompt for new requests; tags-only calls and generate_image_qwen remain legacy compatibility entries.",
		"Progress appears in the tool result. Generation does not end the turn. Set review only if the user explicitly requested visual inspection.",
	],
	parameters: Type.Object({
		prompt: Type.Optional(Type.String({ description: "Image description suitable for the selected local profile." })),
		profile: Type.Optional(Type.String({ description: "Registered ID from list_image_profiles. Omit to use the configured default. Never a model file path." })),
		steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		negative_prompt: Type.Optional(Type.String()),
		tags: Type.Optional(Type.String({
			description:
				"Legacy SDXL path only, separate from profiles; use it when the user asks for SDXL or Danbooru tags. English Danbooru-style tags, comma-separated: subject first (1girl, solo, fox ears), then hair/eyes, clothing, expression, pose, framing, background. Quality tags are added automatically.",
		})),
		size: Type.Optional(
			Type.String({ description: "WIDTHxHEIGHT (multiples of 32), or portrait/landscape/square. Omit for the profile default. The tags-only legacy SDXL path accepts only portrait (832x1216), landscape (1216x832) or square (1024x1024)." }),
		),
		count: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 8, description: "Number of images (seed, seed+1, ...). Generated sequentially; time depends on the GPU and image size." }),
		),
		seed: Type.Optional(Type.Integer({ minimum: 0, description: "Reuse a seed to reproduce or vary an earlier image." })),
		review: Type.Optional(Type.Boolean({ description: "Default false. Set true only when the user explicitly asks for a visual check after generation; this adds a model turn and image input." })),
		// follow_up は互換性のため受け取るだけで、結果のターン終了は常に無効化した（2026-10-26）。
		follow_up: Type.Optional(
			Type.Boolean({
				description:
					"Deprecated; accepted for compatibility and has no effect. The turn never ends after generation.",
			}),
		),
	}),
	// GPUを使う生成同士と、従来LLMの停止・復帰が衝突しないよう直列にする。
	executionMode: "sequential",
	renderResult(result, options, theme, context) {
		const view = context.lastComponent instanceof ImageProgressView
			? context.lastComponent : new ImageProgressView((text) => theme.fg("dim", text));
		const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		view.update(text, options.isPartial ? (result.details as any)?.imageProgress?.preview : undefined);
		return view;
	},

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		if (!params.prompt?.trim() && !params.tags?.trim()) throw new Error("prompt is required");
		const managed = params.prompt !== undefined || params.profile !== undefined;
		const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", imagegenScript(managed ? "gen-image-profile.ps1" : "gen-image.ps1")];
		if (managed) {
			if (params.profile) args.push("-Profile", params.profile);
			if (params.steps !== undefined) args.push("-Steps", String(params.steps));
		} else {
			args.push("-Prompt", params.tags!);
			if (ctx.model?.provider === "localllm-strata") args.push("-Gpu", "rtx4060");
		}
		const sizes: Record<string, string> = { portrait: "832x1248", landscape: "1248x832", square: "1024x1024" };
		if (params.size && managed) args.push("-Size", sizes[params.size] ?? params.size);
		if (params.size && !managed) args.push("-Size", legacySize(params.size));
		if (params.count) args.push("-Count", String(params.count));
		if (params.seed !== undefined) args.push("-Seed", String(params.seed));

		// Esc で中断されても子プロセスは止めない。途中で止めると LLM が止まったまま残るので、最後まで走らせて結果を返す。
		return await new Promise((resolve, reject) => {
			const child = spawn("powershell.exe", args, { windowsHide: true,
				env: { ...process.env, GEN_IMAGE_PROGRESS_EVENTS: "1", GEN_IMAGE_PROMPT: params.prompt ?? params.tags,
					GEN_IMAGE_NEGATIVE: params.negative_prompt } });
			let out = "";
			let progress: ImageProgress | undefined;
			const started = Date.now();
			const update = () => {
				if (signal?.aborted) return;
				const text = progress ? progressText(progress, (Date.now() - started) / 1000) : out.trim();
				onUpdate?.({ content: [{ type: "text", text }], details: progress ? { imageProgress: progress } : undefined });
			};
			const onEvent = (event: ImageProgress) => {
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
					// ターンを切るかどうかをモデルの follow_up 判断に依存しない。続き物で途切れる事故を防ぐ。
					generatedImageResult(text, params.follow_up, ctx, signal, params.review)
						.then((result) => resolve({ ...result, terminate: false }), reject);
				} else {
					reject(new Error(text || `gen-image.ps1 failed (exit ${code})`));
				}
			});
		});
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "list_image_profiles", label: "Local image profiles",
		description: "List registered local image generation profiles and their defaults. Read-only; does not load models or execute workflows.",
		parameters: Type.Object({}),
		async execute() {
			return await new Promise((resolve, reject) => {
				const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", imagegenScript("gen-image-profile.ps1"), "-ListProfiles"], { windowsHide: true });
				let out = "", error = "";
				child.stdout.on("data", b => { out += b.toString(); });
				child.stderr.on("data", b => { error += b.toString(); });
				child.on("error", reject);
				child.on("close", code => code === 0 ? resolve({ content: [{type:"text",text:out.trim()}], details: {} }) : reject(new Error(error || out)));
			});
		}
	}));
	// LLM が generate_image を書き始めた時点で、待機役に ComfyUI の準備（import と checkpoint の組み立て）をさせる手も
	// 試したが、LLM の生成中に重ねると LLM も描画も遅くなり、全体では悪化した（2026-10-22）。
	pi.registerTool(generateImage);
	registerPreviewResize(pi, "sdxl-progress-render");
}

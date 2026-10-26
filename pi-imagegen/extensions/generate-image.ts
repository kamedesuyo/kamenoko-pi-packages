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

const generateImage = defineTool({
	name: "generate_image",
	label: "Generate image",
	description:
		"Draw anime-style images on this PC (SDXL Illustrious). Usually takes tens of seconds; startup and model loading can make it slower. " +
		"With Strata, uses the dedicated RTX 4060 while the LLM stays running. Other local LLMs are paused and restored with this conversation. " +
		"Quality tags are added automatically. Drawing progress and a live preview appear automatically in the terminal. " +
		"Shows the finished images, saved PNG paths and seeds; the turn continues so remaining requested work can proceed. Set review only when the user explicitly asks to inspect the generated result.",
	promptSnippet: "generate_image: draw anime-style pictures locally from English Danbooru-style tags",
	promptGuidelines: [
		"For image-generation requests, honor any specified style or model. Otherwise choose the style and image tool from the subject, intended use, and conversation without asking the user to pick anime versus realistic or a model.",
		"Use generate_image for quick anime-style pictures from English Danbooru tags. Use generate_image_qwen for Qwen or photo-like images. Both tools show drawing progress and a live preview automatically. Do not inspect implementation scripts for routine generation.",
		"With provider localllm-strata, generate_image uses the dedicated RTX 4060. generate_image_qwen uses Strata's image API when enabled and shows live progress automatically. Do not switch servers or bypass the image API capability check.",
		"When the user explicitly asks to use or review the local image-generation skill, read local-llm-env first. Otherwise a simple image request can go straight to the appropriate image tool.",
		"Generation never ends the turn early; continue any remaining requested work yourself and finish with a short reply when done. Set review only if the user explicitly asks to inspect the generated result; inspect its attached image briefly without reading it again or regenerating. For img2img, use local-image-edit and compare the source with the final result once.",
	],
	parameters: Type.Object({
		tags: Type.String({
			description:
				"English Danbooru-style tags, comma-separated: subject first (1girl, solo, fox ears), then hair/eyes, clothing, expression, pose, framing, background. Quality tags are added automatically.",
		}),
		size: Type.Optional(
			Type.Union([Type.Literal("portrait"), Type.Literal("landscape"), Type.Literal("square")], {
				description: "portrait 832x1216 (default), landscape 1216x832, square 1024x1024",
			}),
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
		const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", imagegenScript("gen-image.ps1"), "-Prompt", params.tags];
		if (ctx.model?.provider === "localllm-strata") args.push("-Gpu", "rtx4060");
		if (params.size) args.push("-Size", params.size);
		if (params.count) args.push("-Count", String(params.count));
		if (params.seed !== undefined) args.push("-Seed", String(params.seed));

		// Esc で中断されても子プロセスは止めない。途中で止めると LLM が止まったまま残るので、最後まで走らせて結果を返す。
		return await new Promise((resolve, reject) => {
			const child = spawn("powershell.exe", args, { windowsHide: true,
				env: { ...process.env, GEN_IMAGE_PROGRESS_EVENTS: "1" } });
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
	// LLM が generate_image を書き始めた時点で、待機役に ComfyUI の準備（import と checkpoint の組み立て）をさせる手も
	// 試したが、LLM の生成中に重ねると LLM も描画も遅くなり、全体では悪化した（2026-10-22）。
	pi.registerTool(generateImage);
	registerPreviewResize(pi, "sdxl-progress-render");
}

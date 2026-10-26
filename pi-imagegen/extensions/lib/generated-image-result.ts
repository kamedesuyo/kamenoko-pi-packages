import { createReadToolDefinition, type AgentToolResult, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";

interface GeneratedImageDetails {
	exitCode: number;
	generatedImages: { path: string; seed: number }[];
	vision: { status: "attached" | "partial" | "failed" | "unavailable" | "skipped"; attachedPaths: string[]; errors: string[] };
}

export async function generatedImageResult(
	text: string,
	followUp: boolean | undefined,
	ctx: ExtensionToolContext,
	signal?: AbortSignal,
	review = false,
): Promise<AgentToolResult<GeneratedImageDetails>> {
	const generatedImages = [...text.matchAll(/^画像:\s+(.+?\.png)\s*[（(]seed\s+(\d+)[）)]\s*$/gm)]
		.map((match) => ({ path: match[1], seed: Number(match[2]) }));
	const details: GeneratedImageDetails = {
		exitCode: 0,
		generatedImages,
		vision: { status: "skipped", attachedPaths: [], errors: [] },
	};
	// 通常生成に確認の推論往復を加えない。編集の続きがあるだけでも画像確認は強制しない。
	if (!review) return { content: [{ type: "text", text }], details, terminate: !followUp };
	if (!ctx.model?.input.includes("image")) {
		details.vision.status = "unavailable";
		const note = "\n\n画像確認: このモデルは画像入力に非対応のため未確認。";
		return { content: [{ type: "text", text: text + note }], details, terminate: !followUp };
	}

	const content: AgentToolResult<GeneratedImageDetails>["content"] = [{ type: "text", text }];
	const reader = createReadToolDefinition(ctx.cwd);
	for (const image of generatedImages) {
		try {
			const result = await reader.execute("generated-image-review", { path: image.path }, signal, undefined, ctx);
			if (!result.content.some((block) => block.type === "image")) throw new Error("画像データを取得できなかった");
			content.push({ type: "text", text: `確認対象: ${image.path} (seed ${image.seed})` }, ...result.content);
			details.vision.attachedPaths.push(image.path);
		} catch (error) {
			details.vision.errors.push(`${image.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (generatedImages.length === 0) details.vision.errors.push("生成結果からPNGの出力先を取得できなかった");
	const attached = details.vision.attachedPaths.length;
	details.vision.status = attached === 0 ? "failed" : details.vision.errors.length ? "partial" : "attached";
	if (details.vision.errors.length) {
		content.push({ type: "text", text: `画像確認で読み込めなかったもの:\n${details.vision.errors.join("\n")}` });
	}
	// 添付があっても terminate を返すと、モデルが実際に見る前にターンが終わる。
	content.push({
		type: "text",
		text: attached > 0
			? "Inspect the attached finished image(s) now. Compare what is actually visible with the user's request. Give a brief visual check (1-3 sentences) in the user's language: concrete visible details and any clear mismatch. If a detail is unclear, say so. Do not repeat the generation prompt or tags. Do not read the same image again or regenerate unless the user requested it. Report any unattached image as unverified. Then continue any remaining requested work."
			: "The image was generated, but no image could be attached for visual review. Tell the user it is visually unverified; do not infer its appearance from the prompt. Do not regenerate automatically. Continue any remaining requested work.",
	});
	return { content, details };
}

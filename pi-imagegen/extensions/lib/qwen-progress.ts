import { StringDecoder } from "node:string_decoder";
import { Image, Text, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let previewGeneration = 0;

export function registerPreviewResize(pi: ExtensionAPI, widgetKey = "qwen-progress-render") {
	let detach: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		detach?.();
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(widgetKey, (tui) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const resize = () => {
				clearTimeout(timer);
				timer = setTimeout(() => {
					// 高さだけの変更では端末側が消した画像を配置情報だけで戻せない。
					previewGeneration++;
					tui.requestRender(true);
				}, 120);
			};
			process.stdout.on("resize", resize);
			const dispose = () => {
				process.stdout.off("resize", resize);
				clearTimeout(timer);
				if (detach === dispose) detach = undefined;
			};
			detach = dispose;
			return { render: () => [], invalidate: () => {}, dispose };
		}, { placement: "belowEditor" });
	});
	pi.on("session_shutdown", () => detach?.());
}

export interface QwenProgress {
	phase: string;
	index?: number;
	count?: number;
	step?: number;
	steps?: number;
	preview?: string;
}

const phases: Record<string, string> = {
	queued: "順番待ち・GPU準備中", loading: "モデルを読み込み中", encoding: "プロンプトを処理中",
	sampling: "描画中", decoding: "完成画像を展開中", saving: "画像を保存中", restoring: "StrataのVRAMを復帰中",
	releasing: "GPUを解放中", resuming: "LLMを再開中",
};

export function progressText(progress: QwenProgress, elapsed: number): string {
	const label = phases[progress.phase] ?? "画像生成中";
	const count = progress.count && progress.count > 1 ? ` ${progress.index}/${progress.count}枚` : "";
	let bar = "";
	if (progress.phase === "sampling" && progress.steps && progress.step !== undefined) {
		const ratio = Math.max(0, Math.min(1, progress.step / progress.steps));
		const filled = Math.round(ratio * 20);
		bar = `\n${"━".repeat(filled)}${"─".repeat(20 - filled)} ${Math.round(ratio * 100)}% · ${progress.step}/${progress.steps} step`;
	}
	const seconds = Math.max(0, Math.floor(elapsed));
	return `${label}${count} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}${bar}`;
}

export function progressDecoder(onEvent: (event: QwenProgress) => void, onText: (text: string) => void) {
	const decoder = new StringDecoder("utf8");
	let pending = "";
	function line(value: string) {
		const prefix = ["QWEN_EVENT ", "IMAGE_EVENT "].find((prefix) => value.startsWith(prefix));
		if (prefix) {
			try {
				const event = JSON.parse(value.slice(prefix.length));
				if (event.type === "progress" && typeof event.phase === "string") onEvent(event);
			} catch {}
			return;
		}
		if (value.trim()) onText(value);
	}
	function consume(text: string) {
		pending += text;
		let end: number;
		while ((end = pending.indexOf("\n")) >= 0) {
			line(pending.slice(0, end).replace(/\r$/, ""));
			pending = pending.slice(end + 1);
		}
	}
	return {
		write(chunk: Buffer) { consume(decoder.write(chunk)); },
		end() { consume(decoder.end()); if (pending) line(pending); pending = ""; },
	};
}

export class QwenProgressView implements Component {
	private text = new Text("", 0, 0);
	private image?: Image;
	private preview?: string;
	private generation = previewGeneration;
	constructor(private dim: (text: string) => string) {}
	update(text: string, preview?: string) {
		this.text.setText(text + (preview ? "\n" + this.dim("途中プレビュー（概略）") : ""));
		if (preview !== this.preview) {
			const imageId = this.image?.getImageId();
			this.preview = preview;
			this.image = preview ? new Image(preview, "image/png", { fallbackColor: this.dim },
				{ maxWidthCells: 48, maxHeightCells: 16, filename: "Image preview", imageId }) : undefined;
		}
	}
	invalidate() { this.text.invalidate(); this.image?.invalidate(); }
	render(width: number) {
		if (this.generation !== previewGeneration) {
			this.generation = previewGeneration;
			this.image?.invalidate();
		}
		return [...this.text.render(width), ...(this.image?.render(width) ?? [])];
	}
}

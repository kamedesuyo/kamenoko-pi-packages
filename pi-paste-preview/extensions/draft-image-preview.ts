import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, normalize } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult,
	Image, getImageDimensions, matchesKey, truncateToWidth, visibleWidth,
} from "@earendil-works/pi-tui";

const WIDGET = "draft-image-preview";
const MAX_BYTES = 20 * 1024 * 1024;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tempPattern = escapeRegex(tmpdir().replace(/\\/g, "/").replace(/\/$/, "")).replace(/\//g, "[\\\\/]");
// 本文に書かれただけの任意パスを勝手に開かず、pi自身が取り込んだ画像に限定する。
const CLIPBOARD_PATH = new RegExp(`${tempPattern}[\\\\/]pi-clipboard-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.(?:png|jpe?g|gif|webp)`, "gi");

function imagePaths(text: string): string[] {
	const paths = [...text.matchAll(CLIPBOARD_PATH)].map((match) => normalize(match[0]));
	return [...new Map(paths.map((path) => [process.platform === "win32" ? path.toLowerCase() : path, path])).values()];
}

type Picture = {
	fingerprint: string;
	data: string;
	mime: string;
	dimensions: { widthPx: number; heightPx: number };
};
type Button = { from: number; to: number; action: () => void };

class DraftImagePreview implements Component {
	private paths: string[] = [];
	private selected = "";
	private text: string | undefined;
	private picture: Picture | undefined;
	private error = "";
	private checkedAt = 0;
	private loading: AbortController | undefined;
	private images = new Map<string, { height: number; image: Image }>();
	private buttons: Button[] = [];
	private resizeTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private zoomOpen = false;
	private closeZoom: (() => void) | undefined;

	constructor(private readonly ctx: ExtensionContext, private readonly tui: TUI, private readonly theme: Theme) {
		process.stdout.on("resize", this.onResize);
	}

	private onResize = () => {
		clearTimeout(this.resizeTimer);
		this.resizeTimer = setTimeout(() => {
			this.resizeTimer = undefined;
			if (!this.disposed && this.selected) {
				// セル数が変わらない最大化でも、端末から消えた画像本体を再送する必要がある。
				this.invalidate();
				this.tui.requestRender(true);
			}
		}, 120);
	};

	private sync(): void {
		if (this.disposed) return;
		const text = this.ctx.ui.getEditorText();
		if (text !== this.text) {
			this.text = text;
			const next = imagePaths(text);
			const added = next.filter((path) => !this.paths.includes(path));
			this.paths = next;
			this.select(added.at(-1) ?? (next.includes(this.selected) ? this.selected : next.at(-1) ?? ""));
		}
		if (this.selected && !this.loading && (this.checkedAt === 0 || Date.now() - this.checkedAt >= 1000)) {
			void this.load();
		}
	}

	private select(path: string): void {
		if (path === this.selected) return;
		this.loading?.abort();
		this.loading = undefined;
		this.selected = path;
		this.picture = undefined;
		this.error = "";
		this.checkedAt = 0;
		this.images.clear();
	}

	private async load(): Promise<void> {
		const path = this.selected;
		const controller = new AbortController();
		this.loading = controller;
		this.checkedAt = Date.now();
		try {
			const info = await stat(path, { bigint: true });
			if (controller.signal.aborted) return;
			if (!info.isFile()) throw new Error("ファイルが見つかりません");
			if (info.size > BigInt(MAX_BYTES)) throw new Error("プレビュー上限20 MiBを超えています");
			const fingerprint = `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`;
			if (this.picture?.fingerprint === fingerprint) return;
			const bytes = await readFile(path, { signal: controller.signal });
			if (bytes.length > MAX_BYTES) throw new Error("プレビュー上限20 MiBを超えています");
			const mime = MIME[extname(path).toLowerCase()];
			const data = bytes.toString("base64");
			const dimensions = getImageDimensions(data, mime);
			if (!dimensions || dimensions.widthPx <= 0 || dimensions.heightPx <= 0) throw new Error("画像形式を読み取れません");
			if (dimensions.widthPx * dimensions.heightPx > 40_000_000) throw new Error("プレビュー上限4000万画素を超えています");
			if (controller.signal.aborted || this.disposed) return;
			this.picture = { fingerprint, data, mime, dimensions };
			this.error = "";
			this.images.clear();
		} catch (error) {
			if (controller.signal.aborted || this.disposed) return;
			this.picture = undefined;
			this.images.clear();
			const code = (error as NodeJS.ErrnoException).code;
			this.error = code ? (code === "ENOENT" ? "ファイルが見つかりません" : "ファイルを読めません") : String((error as Error).message);
		} finally {
			if (this.loading === controller) {
				this.loading = undefined;
				if (!this.disposed) this.tui.requestRender();
			}
		}
	}

	private step(delta: number): void {
		this.sync();
		if (this.paths.length < 2) return;
		const index = (this.paths.indexOf(this.selected) + delta + this.paths.length) % this.paths.length;
		this.select(this.paths[index]);
		this.tui.requestRender();
	}

	private title(): string {
		const dimensions = this.picture?.dimensions;
		return `画像 ${this.paths.indexOf(this.selected) + 1}/${this.paths.length}${dimensions ? ` · ${dimensions.widthPx}×${dimensions.heightPx}` : ""}`;
	}

	private drawPicture(width: number, zoom: boolean): string[] {
		if (this.error) return [truncateToWidth(this.theme.fg("warning", this.error), width)];
		if (!this.picture) return [truncateToWidth(this.theme.fg("dim", "画像を読み込み中…"), width)];
		const terminalRows = this.tui.terminal.rows || 40;
		const height = zoom ? Math.max(1, Math.floor(terminalRows * 0.85) - 4) : Math.max(1, Math.min(6, Math.floor(terminalRows / 5)));
		const mode = zoom ? "zoom" : "small";
		let cached = this.images.get(mode);
		if (!cached || cached.height !== height) {
			cached = {
				height,
				image: new Image(this.picture.data, this.picture.mime, { fallbackColor: (text) => this.theme.fg("dim", text) },
					{ maxWidthCells: zoom ? 10_000 : 40, maxHeightCells: height, filename: basename(this.selected) }, this.picture.dimensions),
			};
			this.images.set(mode, cached);
		}
		return cached.image.render(width);
	}

	render(width: number): string[] {
		this.sync();
		this.buttons = [];
		if (this.disposed || !this.selected || width < 1) return [];
		let header = this.title();
		const button = (label: string, action: () => void) => {
			const from = visibleWidth(header) + 2;
			const to = from + visibleWidth(label);
			if (to > width) return;
			header += `  ${label}`;
			this.buttons.push({ from, to, action });
		};
		if (this.paths.length > 1) {
			button("[前]", () => this.step(-1));
			button("[次]", () => this.step(1));
		}
		button("[拡大]", () => { void this.open(); });
		if (visibleWidth(header) + 7 <= width) header += "  Alt+O";
		return [truncateToWidth(this.theme.fg("dim", header), width), ...this.drawPicture(width, false)];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.selected || event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
		const action = event.y === 0 ? this.buttons.find(({ from, to }) => event.x >= from && event.x < to)?.action : () => { void this.open(); };
		if (!action) return undefined;
		if (event.type === "press") return { handled: true, render: false };
		if (event.type !== "click") return undefined;
		action();
		return { handled: true, render: true };
	}

	async open(): Promise<void> {
		this.sync();
		if (this.disposed || this.zoomOpen) return;
		if (!this.selected) {
			this.ctx.ui.notify("Alt+Vで画像を貼り付けるとプレビューできます", "info");
			return;
		}
		this.zoomOpen = true;
		try {
			await this.ctx.ui.custom<void>((_tui, _theme, _keys, done) => {
				this.closeZoom = () => done();
				return {
					render: (width) => {
						this.sync();
						if (!this.selected) return [truncateToWidth("画像は入力欄から取り除かれました。Escで戻る", width)];
						return [
							truncateToWidth(this.theme.fg("accent", this.title()), width),
							truncateToWidth(this.theme.fg("dim", "← →: 前後の画像  Esc / Enter: 閉じる"), width),
							...this.drawPicture(width, true),
						];
					},
					handleInput: (data) => {
						// 拡大中のEnterは確認終了であり、下にある入力欄へ送信キーを通さない。
						if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "ctrl+c") || matchesKey(data, "alt+o")) done();
						else if (matchesKey(data, "left")) this.step(-1);
						else if (matchesKey(data, "right")) this.step(1);
					},
					invalidate: () => this.images.get("zoom")?.image.invalidate(),
				};
			}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } });
		} catch {
			if (!this.disposed) this.ctx.ui.notify("画像プレビューを開けませんでした", "error");
		} finally {
			this.closeZoom = undefined;
			this.zoomOpen = false;
			if (!this.disposed) {
				this.invalidate();
				this.tui.requestRender(true);
			}
		}
	}

	invalidate(): void {
		for (const { image } of this.images.values()) image.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.loading?.abort();
		this.loading = undefined;
		clearTimeout(this.resizeTimer);
		process.stdout.off("resize", this.onResize);
		this.closeZoom?.();
		this.closeZoom = undefined;
		this.images.clear();
		this.picture = undefined;
	}
}

export default function (pi: ExtensionAPI): void {
	let widget: DraftImagePreview | undefined;
	pi.on("session_start", (_event, ctx) => {
		widget?.dispose();
		widget = undefined;
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET, (tui, theme) => {
			widget = new DraftImagePreview(ctx, tui, theme);
			return widget;
		}, { placement: "aboveEditor" });
	});
	pi.on("session_shutdown", () => {
		widget?.dispose();
		widget = undefined;
	});
	pi.registerShortcut("alt+o", {
		description: "貼り付けた画像を送信前に拡大する（← →で切替、Escで戻る）",
		handler: async () => { await widget?.open(); },
	});
}

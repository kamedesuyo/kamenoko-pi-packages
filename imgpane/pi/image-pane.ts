/**
 * image-pane: pi が読んだ・作った画像を、横の画像ビューア（同じパッケージの viewer/imgpane.py、Windows Terminal に Sixel で描く）へ送る。
 *
 * pi は kitty と iTerm2 の方式でしか画像を描けず、Windows Terminal は Sixel にしか対応していないので、会話の中ではなく
 * 横の枠に出す。送るのは %LOCALAPPDATA%\imgpane\queue.txt への 1 行の追記だけで、ビューアが開いていなくても失敗しない。
 *
 * - read で画像ファイルを読んだ時、そのパスを送る
 * - 名前に image が付くツール（generate_image など）の結果に画像のパスがあれば、それを送り、会話の中にも描く
 * - /imgshow <パス> で、その画像を会話の中に描く
 * - /imgpane で、今の Windows Terminal のタブを左右に割ってビューアを開く
 *
 * 会話の中に描く画像は、LLM には渡さない記録（appendEntry）として残す。描けるのは pi が画像に対応した端末
 * （WezTerm・kitty・Ghostty や、それらの中の Herdr）だけで、Windows Terminal ではファイル名の 1 行になる。
 *
 * 描いた画像は 1 行に畳める。alt+i で全部をまとめて開閉する。fullscreen モードなら 1 枚ずつマウスで操作できる:
 * 1 回クリックで普通の大きさとペインいっぱいの拡大を切り替え、ダブルクリックで畳み、畳んだ行のクリックで開く。
 * Alt＋左クリックで、エクスプローラーに画像ファイルを選択して表示する。
 * regular モードではマウスをターミナルが使う（スクロールや選択）ので、クリックは pi に届かない。
 *
 * ツールの結果に入った画像（read の画像、vision の添付、MCP のスクリーンショット）は pi 本体がツールの枠の中で描き、
 * 拡張からは畳めない。pi の設定 terminal.showImages を false にすると本体は描かなくなる（LLM には今までどおり渡る）ので、
 * その時はこちらが代わりに描く。true の時は本体に任せ、二重に描かない。
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Image,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@earendil-works/pi-tui";

const QUEUE = join(process.env.LOCALAPPDATA ?? "", "imgpane", "queue.txt");
const VIEWER_BAT = join(dirname(fileURLToPath(import.meta.url)), "..", "viewer", "imgpane.bat");
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);
// 構造化されたパスのないツールもあるので、本文からの抽出も残す。
const IMAGE_PATH = /[A-Za-z]:[\\/][^\r\n"'<>|*?]+?\.(?:png|jpe?g|webp|gif|bmp|tiff?)(?=$|[\s"'<>|*?（）)\]`,])/gi;

// 会話の中に描く画像。pi の描画部が寸法を読めるのはこの 4 種類だけ
const INLINE_ENTRY = "image-inline";
const INLINE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};
const INLINE_MAX_BYTES = 20 * 1024 * 1024;
const INLINE_CACHE_MAX = 16;
const inlineCache = new Map<string, { fingerprint: string; data: string }>();

interface InlineImage {
	path: string;
}

// 表示の状態（記録の id ごと）。normal＝普通の大きさ、large＝ペインいっぱいの拡大、folded＝1 行に畳む。
// foldAll は alt+i で全部を畳む・開く切り替えで、viewOverride はクリックした画像ごとの上書き
type ViewMode = "normal" | "large" | "folded";
let foldAll = false;
const viewOverride = new Map<string, ViewMode>();

function viewMode(key: string): ViewMode {
	return viewOverride.get(key) ?? (foldAll ? "folded" : "normal");
}

// 1 回クリックの拡大を待っている画像（記録の id ごと）
const pendingClicks = new Map<string, ReturnType<typeof setTimeout>>();

// 動作確認用（e2e/check-inline-image.ps1）。環境変数 IMAGE_PANE_DEBUG_LOG にファイルのパスがある時だけ、
// 画像ごとの表示の状態（状態と行数）が変わるたびに 1 行書く。普段は何も書かない
const DEBUG_LOG = process.env.IMAGE_PANE_DEBUG_LOG;
const lastLogged = new Map<string, string>();

// key を渡すと、その key で前回と同じ内容なら書かない（毎フレームの描画で同じ行が並ばないように）
function debugLog(key: string | undefined, text: string): void {
	if (!DEBUG_LOG) return;
	if (key !== undefined) {
		if (lastLogged.get(key) === text) return;
		lastLogged.set(key, text);
	}
	try {
		appendFileSync(DEBUG_LOG, `${Date.now()} ${text}\n`, "utf8");
	} catch {
		// 確認用の記録が書けなくても表示には影響させない
	}
}

const NORMAL_WIDTH_CELLS = 60;
// 拡大した時に、入力欄・下の欄・前後の余白のために残す行数
const LARGE_RESERVED_ROWS = 8;
// 1 回クリックの拡大・縮小は少しだけ待つ。素早いダブルクリックなら、大きさが変わる前に畳める。
// 待ちを過ぎてから 2 回目が来ても、pi は 500 ms 以内で同じ部品の上ならダブルクリックとして数えるので畳める
const SINGLE_CLICK_DELAY_MS = 150;
// 拡大から縮めた直後だけ、拡大していた時の行数まで空行で埋めておく（画面をずらさない）。縮めると画像が動き、
// 遅めのダブルクリックの 2 回目が画像の外に当たって畳めなくなるため。ダブルクリックの間隔（500 ms）が過ぎたら詰める
const SHRINK_HOLD_MS = 500;
const shrinkHold = new Map<string, { rows: number; until: number }>();
// 待った後に画面を描き直す口。session_start で、何も描かない部品を入力欄の下に置いて受け取る
let requestRender: ((force?: boolean) => void) | undefined;
let detachRender: (() => void) | undefined;
let notifyOpenError: ((message: string) => void) | undefined;
let imageGeneration = 0;
const RESIZE_SETTLE_MS = 120;

type ImageFactory = (maxWidthCells: number, maxHeightCells?: number) => Image;

function revealImage(path: string): void {
	const failed = (error: unknown) => {
		const message = `画像の保存場所を開けません: ${error instanceof Error ? error.message : String(error)}`;
		notifyOpenError?.(message);
		debugLog(undefined, message);
	};
	try {
		const absolute = resolve(path);
		if (!statSync(absolute).isFile()) throw new Error("画像ファイルが見つかりません");
		// 空白・日本語・記号を含むパスをシェルの構文として解釈させない。
		const child = spawn("explorer.exe", ["/select,", absolute], { detached: true, stdio: "ignore", windowsHide: false });
		child.on("error", failed);
		child.unref();
	} catch (error) {
		failed(error);
	}
}

class InlineImageView implements Component {
	private readonly image: Image | undefined;
	private renderGeneration = imageGeneration;
	private large: Image | undefined;
	private largeRows = 0;
	// 拡大して描いた時の行数（縮めた直後に空行で保つ高さ）
	private largeHeight = 0;

	constructor(
		private readonly key: string,
		private readonly path: string,
		private readonly makeImage: ImageFactory | undefined,
		private readonly dim: (text: string) => string,
		// 畳んだ行を周りの文章と見分けやすくする色（テーマの warning＝黄色の太字）
		private readonly accent: (text: string) => string,
	) {
		this.image = makeImage?.(NORMAL_WIDTH_CELLS);
	}

	render(width: number): string[] {
		if (this.renderGeneration !== imageGeneration) {
			this.invalidate();
			this.renderGeneration = imageGeneration;
		}
		const lines = this.renderLines(width);
		const mode = this.image ? viewMode(this.key) : "unreadable";
		debugLog(this.key, `view ${basename(this.path)} mode=${mode} lines=${lines.length}`);
		return lines;
	}

	private renderLines(width: number): string[] {
		if (!this.image) return [truncateToWidth(this.dim(`[画像を読めない: ${this.path}]`), width)];
		const mode = viewMode(this.key);
		if (mode === "folded") {
			const label = this.accent(`▸ 画像 ${basename(this.path)}`);
			return [truncateToWidth(`${label}${this.dim("（クリックか alt+i で開く）")}`, width)];
		}
		if (mode === "large") {
			const lines = this.largeImage().render(width);
			this.largeHeight = lines.length;
			return lines;
		}
		const lines = this.image.render(width);
		const hold = shrinkHold.get(this.key);
		if (hold && Date.now() < hold.until && lines.length < hold.rows) {
			return [...lines, ...new Array<string>(hold.rows - lines.length).fill("")];
		}
		return lines;
	}

	// 拡大はペインの幅いっぱい、高さは端末の行数に収まる大きさ。行数が変わったら作り直す
	private largeImage(): Image {
		const rows = Math.max(10, (process.stdout.rows ?? 40) - LARGE_RESERVED_ROWS);
		if (!this.large || this.largeRows !== rows) {
			this.large = this.makeImage?.(10_000, rows);
			this.largeRows = rows;
		}
		return this.large ?? (this.image as Image);
	}

	// 1 回クリックで普通 ⇄ 拡大、ダブルクリックで畳む、畳んだ行のクリックで普通の大きさに開く
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left") return undefined;
		if (event.alt && (event.type === "press" || event.type === "click")) {
			// 直前の通常クリックの遅延処理が、フォルダーを開いた後に画像を拡大しないようにする。
			clearTimeout(pendingClicks.get(this.key));
			pendingClicks.delete(this.key);
			if (event.type === "click") revealImage(this.path);
			return { handled: true, render: false };
		}
		if (!this.image) return undefined;
		// 押した時点で受け取っておく。受け取らないと pi は文字選択として扱い、連続クリックを単語の上でしか数えない
		// （文字の無い画像の上では、ダブルクリックが毎回 1 回目になる）
		if (event.type === "press") return { handled: true, render: false };
		if (event.type !== "click") return undefined;
		debugLog(undefined, `click ${basename(this.path)} count=${event.clickCount ?? 1}`);
		clearTimeout(pendingClicks.get(this.key));
		pendingClicks.delete(this.key);
		if (viewMode(this.key) === "folded") {
			viewOverride.set(this.key, "normal");
			return { handled: true, render: true };
		}
		if ((event.clickCount ?? 1) >= 2) {
			shrinkHold.delete(this.key);
			viewOverride.set(this.key, "folded");
			return { handled: true, render: true };
		}
		const render = requestRender;
		const key = this.key;
		const toggleSize = () => {
			if (viewMode(key) !== "large") {
				viewOverride.set(key, "large");
				return;
			}
			viewOverride.set(key, "normal");
			if (!render || this.largeHeight === 0) return;
			shrinkHold.set(key, { rows: this.largeHeight, until: Date.now() + SHRINK_HOLD_MS });
			setTimeout(() => {
				shrinkHold.delete(key);
				render();
			}, SHRINK_HOLD_MS + 20);
		};
		if (!render) {
			toggleSize();
			return { handled: true, render: true };
		}
		pendingClicks.set(
			key,
			setTimeout(() => {
				pendingClicks.delete(key);
				toggleSize();
				render();
			}, SINGLE_CLICK_DELAY_MS),
		);
		return { handled: true, render: false };
	}

	invalidate(): void {
		this.image?.invalidate();
		this.large?.invalidate();
	}
}

function existingImages(paths: string[]): string[] {
	return paths.filter((p) => {
		try {
			return IMAGE_EXTS.has(extname(p).toLowerCase()) && existsSync(p) && statSync(p).isFile();
		} catch {
			return false;
		}
	});
}

function send(paths: string[]): void {
	if (paths.length === 0) return;
	try {
		mkdirSync(dirname(QUEUE), { recursive: true });
		appendFileSync(QUEUE, paths.map((p) => `${p}\n`).join(""), "utf8");
	} catch (error) {
		// 外部ビューアの故障で、独立している会話内の表示まで止めない。
		debugLog(undefined, `queue failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

const TOOL_IMAGE_DIR = join(process.env.LOCALAPPDATA ?? "", "imgpane", "tool-images");
const MIME_EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

// ファイルの無い画像（MCP のスクリーンショットなど）は、会話に描くために一度ファイルへ書き出す。名前はツール呼び出しの id から決める
function saveToolImages(toolCallId: string, blocks: ImageBlock[]): string[] {
	const saved: string[] = [];
	blocks.forEach((block, i) => {
		const ext = MIME_EXT[block.mimeType];
		if (!ext || !block.data || block.data.length > (INLINE_MAX_BYTES * 4) / 3) return;
		const path = join(TOOL_IMAGE_DIR, `${toolCallId.replace(/[^A-Za-z0-9_-]/g, "_")}-${i}${ext}`);
		mkdirSync(TOOL_IMAGE_DIR, { recursive: true });
		writeFileSync(path, Buffer.from(block.data, "base64"));
		saved.push(path);
	});
	return saved;
}

// pi 本体がツールの結果の画像を描くか（terminal.showImages、既定 true）。プロジェクトの .pi/settings.json が優先
function piDrawsToolImages(cwd: string): boolean {
	let show = true;
	for (const file of [join(process.env.USERPROFILE ?? "", ".pi", "agent", "settings.json"), join(cwd, ".pi", "settings.json")]) {
		try {
			const value = JSON.parse(readFileSync(file, "utf8"))?.terminal?.showImages;
			if (typeof value === "boolean") show = value;
		} catch {
			// 無い・読めない設定は飛ばす
		}
	}
	return show;
}

function loadBase64(path: string): string | null {
	try {
		const stat = statSync(path, { bigint: true });
		if (!stat.isFile() || stat.size > BigInt(INLINE_MAX_BYTES)) {
			inlineCache.delete(path);
			return null;
		}
		const fingerprint = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;
		const cached = inlineCache.get(path);
		if (cached?.fingerprint === fingerprint) return cached.data;
		const data = readFileSync(path).toString("base64");
		inlineCache.delete(path);
		inlineCache.set(path, { fingerprint, data });
		if (inlineCache.size > INLINE_CACHE_MAX) inlineCache.delete(inlineCache.keys().next().value as string);
		return data;
	} catch {
		// 一時的な欠損・ロックから復帰できなくなるので、失敗はキャッシュしない。
		inlineCache.delete(path);
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	const showInline = (paths: string[]) => {
		for (const path of paths) {
			if (!INLINE_MIME[extname(path).toLowerCase()]) continue;
			pi.appendEntry<InlineImage>(INLINE_ENTRY, { path });
			debugLog(undefined, `entry ${path}`);
		}
	};

	pi.registerEntryRenderer<InlineImage>(INLINE_ENTRY, (entry, _options, theme) => {
		const path = entry.data?.path ?? "";
		const mime = INLINE_MIME[extname(path).toLowerCase()];
		const data = mime ? loadBase64(path) : null;
		const dim = (s: string) => theme.fg("dim", s);
		const makeImage: ImageFactory | undefined =
			mime && data
				? (maxWidthCells, maxHeightCells) =>
						new Image(data, mime, { fallbackColor: dim }, { maxWidthCells, maxHeightCells, filename: path })
				: undefined;
		const accent = (s: string) => theme.fg("warning", theme.bold(s));
		return new InlineImageView(entry.id ?? path, path, makeImage, dim, accent);
	});

	pi.on("session_start", (_event, ctx) => {
		detachRender?.();
		notifyOpenError = (message) => ctx.ui.notify(message, "error");
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(
			"image-pane-render",
			(tui) => {
				const render = (force = false) => tui.requestRender(force);
				requestRender = render;
				let resizeTimer: ReturnType<typeof setTimeout> | undefined;
				const onResize = () => {
					clearTimeout(resizeTimer);
					resizeTimer = setTimeout(() => {
						resizeTimer = undefined;
						// 高さだけの変更では本体が配置だけを再送する。端末の画像が消えていても復帰できるよう本体データも送り直す。
						imageGeneration++;
						render(true);
					}, RESIZE_SETTLE_MS);
				};
				process.stdout.on("resize", onResize);
				const dispose = () => {
					process.stdout.off("resize", onResize);
					clearTimeout(resizeTimer);
					if (requestRender === render) requestRender = undefined;
					if (detachRender === dispose) detachRender = undefined;
				};
				detachRender = dispose;
				return {
					render: () => [],
					invalidate: () => {},
					dispose,
				};
			},
			{ placement: "belowEditor" },
		);
	});
	pi.on("session_shutdown", () => {
		detachRender?.();
		notifyOpenError = undefined;
	});

	pi.registerShortcut("alt+i", {
		description: "Fold or unfold all inline images",
		handler: (ctx) => {
			foldAll = !foldAll;
			viewOverride.clear();
			for (const timer of pendingClicks.values()) clearTimeout(timer);
			pendingClicks.clear();
			// 状態表示を変えると描き直しが走り、画像の開閉も反映される
			ctx.ui.setStatus("image-pane", foldAll ? ctx.ui.theme.fg("dim", "画像: 畳み中（alt+i で開く）") : undefined);
		},
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			if (event.isError) return;
			const imageBlocks = event.content.filter((c) => c.type === "image") as ImageBlock[];
			// pi 本体がツールの結果の画像を描く設定（terminal.showImages）なら、その画像は本体に任せて二重に描かない。
			// 切ってある時は、本体の代わりにこちらで描く（こちらの画像はクリックや alt+i で畳める）
			const piDraws = piDrawsToolImages(ctx.cwd);
			if (event.toolName === "read") {
				const p = String(event.input?.path ?? "");
				const paths = p ? existingImages([isAbsolute(p) ? p : resolve(ctx.cwd, p)]) : [];
				send(paths);
				if (!piDraws && imageBlocks.length > 0) showInline(paths.length > 0 ? paths : saveToolImages(event.toolCallId, imageBlocks));
				return;
			}
			if (/image/i.test(event.toolName)) {
				const text = event.content
					.filter((c) => c.type === "text")
					.map((c) => (c as { text: string }).text)
					.join("\n");
				const generated = (event.details as { generatedImages?: { path?: unknown }[] } | undefined)?.generatedImages;
				const structuredPaths = Array.isArray(generated)
					? generated.flatMap((image) => typeof image?.path === "string" ? [image.path] : [])
					: [];
				const paths = existingImages([...structuredPaths, ...[...text.matchAll(IMAGE_PATH)].map((m) => m[0])]);
				const uniquePaths = [...new Set(paths)];
				send(uniquePaths);
				if (piDraws) {
					// 画像添付はpi本体も描画するため、同じ絵を追加エントリーで二重に表示しない。
					const attached = (event.details as { vision?: { attachedPaths?: string[] } } | undefined)?.vision?.attachedPaths ?? [];
					showInline(uniquePaths.filter((path) => !attached.includes(path)));
				} else {
					showInline(uniquePaths.length > 0 ? uniquePaths : saveToolImages(event.toolCallId, imageBlocks));
				}
				return;
			}
			if (!piDraws && imageBlocks.length > 0) showInline(saveToolImages(event.toolCallId, imageBlocks));
		} catch {
			// ビューアへ送るのと会話に描くのはおまけ。失敗してもツールの結果には影響させない
		}
	});

	pi.registerCommand("imgshow", {
		description: "Draw an image file inline in the conversation (display only; not sent to the model)",
		handler: async (args, ctx) => {
			const raw = args.trim().replace(/^"(.*)"$/, "$1");
			const paths = existingImages(raw ? [isAbsolute(raw) ? raw : resolve(ctx.cwd, raw)] : []);
			if (paths.length === 0 || !INLINE_MIME[extname(paths[0]).toLowerCase()]) {
				ctx.ui.notify("画像が見つからない（png / jpg / gif / webp のパスを指定）", "error");
				return;
			}
			showInline(paths);
		},
	});

	pi.registerCommand("imgpane", {
		description: "Open the image viewer pane beside pi (splits the current Windows Terminal tab)",
		handler: async (_args, ctx) => {
			const child = spawn(
				"wt.exe",
				["-w", "0", "split-pane", "-V", "--size", "0.4", "--title", "imgpane", "cmd", "/c", VIEWER_BAT, "view"],
				{ detached: true, stdio: "ignore", windowsHide: true },
			);
			child.on("error", () => ctx.ui.notify("Windows Terminal（wt.exe）が見つからない", "error"));
			child.unref();
			ctx.ui.notify("画像ビューアを横に開いた（imgpane）", "info");
		},
	});
}

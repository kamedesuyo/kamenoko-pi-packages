// ツール結果へ画像ブロックを足すとモデルの文脈とセッションファイルが膨らむため、表示側だけで差し替える。
const IMAGE_LINE = /^画像:\s+([A-Za-z]:[\\/][^\n]*?\.png)\s*[（(]seed/gm;
const MARK = "data-inline-images";

function fileUrl(path) {
	const url = new URL("api/file", document.baseURI);
	url.searchParams.set("path", path.replace(/\\/g, "/"));
	return url.href;
}

function decorate(output) {
	const pre = output.querySelector(":scope > pre");
	if (!pre) return;
	const paths = [...pre.textContent.matchAll(IMAGE_LINE)].map((match) => match[1]);
	const key = paths.join("|");
	const current = output.querySelector(`:scope > [${MARK}]`);
	if (current?.getAttribute(MARK) === key) return;
	current?.remove();
	if (paths.length === 0) return;

	const box = document.createElement("div");
	box.setAttribute(MARK, key);
	box.style.cssText = "display:flex;flex-direction:column;gap:8px;margin-top:8px";
	for (const path of paths) {
		const src = fileUrl(path);
		const link = document.createElement("a");
		link.href = src;
		link.target = "_blank";
		link.rel = "noopener";
		const img = document.createElement("img");
		img.src = src;
		img.alt = path;
		img.loading = "lazy";
		img.style.cssText = "display:block;max-width:100%;height:auto;border-radius:8px";
		link.append(img);
		box.append(link);
	}
	output.append(box);
}

function scan() {
	for (const output of document.querySelectorAll(".toolcall-output")) decorate(output);
}

// プラグイン再読み込みで同じmoduleが再importされても監視を重ねない。
window.__inlineImagesObserver?.disconnect();
let queued = false;
window.__inlineImagesObserver = new MutationObserver(() => {
	if (queued) return;
	queued = true;
	// requestAnimationFrameは裏に回ったタブで止まり、戻るまで画像が出ない。
	setTimeout(() => {
		queued = false;
		scan();
	}, 50);
});
window.__inlineImagesObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
scan();

export default {};

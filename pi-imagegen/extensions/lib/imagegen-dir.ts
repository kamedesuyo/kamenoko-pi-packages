import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// imagegen（画像生成のスクリプト一式）の置き場所。
// 環境変数 IMAGEGEN_DIR > pi の設定 imagegen.dir > このリポジトリで隣にある packages/imagegen。
export function imagegenDir(): string {
	if (process.env.IMAGEGEN_DIR) return process.env.IMAGEGEN_DIR;
	try {
		const settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
		if (typeof settings?.imagegen?.dir === "string" && settings.imagegen.dir) return settings.imagegen.dir;
	} catch {}
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "imagegen");
}

export function imagegenScript(name: string): string {
	const path = join(imagegenDir(), name);
	if (!existsSync(path)) throw new Error(`imagegen のスクリプトが見つからない: ${path}（設定 imagegen.dir か環境変数 IMAGEGEN_DIR で場所を指定する）`);
	return path;
}

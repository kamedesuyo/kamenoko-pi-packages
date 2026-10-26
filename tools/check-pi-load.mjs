// 実際の ~/.pi/agent 設定で、piが読み込む拡張の一覧と読み込みエラーを出す。モデルには接続しない。
// 使い方: node check-pi-load.mjs [作業フォルダ]
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.argv[2] ?? process.cwd();
const npmRoot = process.env.APPDATA
	? join(process.env.APPDATA, "npm", "node_modules")
	: execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const sdk = await import(pathToFileURL(join(npmRoot, "@earendil-works", "pi-coding-agent", "dist", "index.js")));

const settingsManager = sdk.SettingsManager.create(cwd);
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: sdk.getAgentDir(), settingsManager });
await loader.reload();
const { extensions, errors } = loader.getExtensions();
for (const extension of extensions) console.log(`ok    ${extension.path}`);
for (const error of errors) console.log(`ERROR ${error.path}: ${error.error}`);
console.log(`extensions: ${extensions.length}  errors: ${errors.length}`);
process.exitCode = errors.length ? 1 : 0;

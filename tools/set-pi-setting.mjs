// ~/.pi/agent/settings.json の1つのキーをJSONで上書きする。他のキーには触らない。
// 使い方: node set-pi-setting.mjs <key> '<json>'
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [key, raw] = process.argv.slice(2);
if (!key || raw === undefined) throw new Error("usage: node set-pi-setting.mjs <key> '<json>'");
const path = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
const text = readFileSync(path, "utf8").replace(/^﻿/, "");
const settings = JSON.parse(text);
settings[key] = JSON.parse(raw);
const temporary = `${path}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
renameSync(temporary, path);
console.log(`${key} = ${JSON.stringify(settings[key])}`);

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compact, convertToLlm, getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// providerの名前は環境ごとに違うので、決め打ちせず設定で受け取る。未設定なら何もしない。
function targetProviders(): Set<string> {
	const fromEnv = process.env.PI_LOCAL_COMPACT_PROVIDERS;
	if (fromEnv) return new Set(fromEnv.split(",").map(name => name.trim()).filter(Boolean));
	try {
		const settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
		const list = settings?.localCompact?.providers;
		if (Array.isArray(list)) return new Set(list.filter((name: unknown): name is string => typeof name === "string"));
	} catch {}
	return new Set();
}

type Messages = ReturnType<typeof convertToLlm>;
type Preparation = Parameters<typeof compact>[0];
type Wire = Record<string, any>;
type Snapshot = { key: string; messages: Messages; wire?: Wire; reply?: Messages[number] };

const INSTRUCTION = `Create a structured context checkpoint of the conversation ABOVE. Recent messages will also be retained verbatim after the checkpoint. Prioritize older information, keep the checkpoint consistent with the latest visible state, and avoid repeating the recent messages in detail. Do not continue the task or call tools. Output only the checkpoint.

Use these sections:
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

Use concise bullets. Preserve user corrections, explicit constraints, exact paths and identifiers, decisions and their reasons, failed approaches, verification results, and unfinished work. Merge any previous checkpoint with the newer information; remove obsolete or duplicated details. Do not invent events. Keep concrete facts needed to resume; omit long logs, repeated narration, and redundant code listings.`;

function key(ctx: any): string {
	return `${ctx.sessionManager.getSessionId()}:${ctx.model?.provider}:${ctx.model?.id}`;
}

function signature(message: Messages[number]): string {
	const m = message as any;
	return JSON.stringify({ role: m.role, content: m.content, toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError });
}

function selectPrefix(snapshot: Snapshot, preparation: Preparation): Messages | undefined {
	const targets = convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);
	if (!targets.length) return;
	let cursor = 0;
	for (const target of targets) {
		const wanted = signature(target);
		while (cursor < snapshot.messages.length && signature(snapshot.messages[cursor]) !== wanted) cursor++;
		if (cursor === snapshot.messages.length) return;
		cursor++;
	}
	const prefix = snapshot.messages.slice(0, cursor);
	const pending = new Set<string>();
	for (const m of prefix as any[]) {
		if (m.role === "assistant") for (const block of m.content) if (block.type === "toolCall") pending.add(block.id);
		if (m.role === "toolResult") pending.delete(m.toolCallId);
	}
	return pending.size ? undefined : prefix;
}

function forceOff(value: unknown, wire?: Wire): Wire {
	const payload = value as Wire;
	return {
		...payload,
		...(wire?.tools ? { tools: wire.tools } : {}),
		cache_prompt: true,
		// 現行テンプレートはreasoning_effort=noneだけでは思考を止めない。
		chat_template_kwargs: { ...wire?.chat_template_kwargs, ...payload.chat_template_kwargs, enable_thinking: false },
	};
}

function validate(response: any): void {
	if (response.stopReason === "aborted") throw new Error("Compact aborted");
	if (response.content.some((b: any) => b.type === "thinking" && b.thinking?.trim())) throw new Error("Compact unexpectedly generated thinking");
	if (!response.content.some((b: any) => b.type === "text" && b.text.trim())) throw new Error(response.errorMessage || "Compact returned no summary");
}

export default function (pi: ExtensionAPI) {
	const providers = targetProviders();
	let snapshot: Snapshot | undefined;
	pi.on("context_with_system", (event, ctx) => {
		if (!providers.has(ctx.model?.provider)) return;
		snapshot = { key: key(ctx), messages: structuredClone(convertToLlm(event.messages)) };
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (snapshot?.key === key(ctx)) snapshot.wire = structuredClone(event.payload as Wire);
	});
	pi.on("turn_end", (event, ctx) => {
		if (snapshot?.key !== key(ctx) || event.message.role !== "assistant" || event.message.stopReason !== "stop") return;
		snapshot.reply = structuredClone(convertToLlm([event.message])[0]);
	});
	pi.on("session_shutdown", () => { snapshot = undefined; });
	pi.on("session_compact", () => { snapshot = undefined; });
	pi.on("session_before_compact", async (event, ctx) => {
		if (!providers.has(ctx.model?.provider)) return;
		const saved = snapshot?.key === key(ctx) && Array.isArray(snapshot.wire?.messages) ? snapshot : undefined;
		const hasImages = saved?.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "image"));
		// 画像直後に戻れるcheckpointがない場合でも、生成済みの返答まで保てば画像の手前へ戻らずに済む。
		const replay = saved && hasImages && saved.reply ? { ...saved, messages: [...saved.messages, saved.reply] } : saved;
		const prefix = replay && event.reason !== "overflow" ? selectPrefix(replay, event.preparation) : undefined;
		const preparation = prefix ? {
			...event.preparation,
			messagesToSummarize: [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages],
			turnPrefixMessages: [],
			isSplitTurn: false,
		} : { ...event.preparation };
		const previous = [...event.branchEntries].reverse().find((e: any) => e.type === "compaction") as any;
		const previousRead = Array.isArray(previous?.details?.readFiles) ? previous.details.readFiles : [];
		const previousModified = Array.isArray(previous?.details?.modifiedFiles) ? previous.details.modifiedFiles : [];
		const fileOps = preparation.fileOps;
		preparation.fileOps = {
			read: new Set([...fileOps.read, ...previousRead]),
			written: new Set([...fileOps.written, ...previousModified]),
			edited: new Set(fileOps.edited),
		};
		if (!prefix) {
			const reason = event.reason === "overflow" ? "入力超過の復旧" : "再利用できる送信履歴が未取得";
			ctx.ui.notify(`Compact: ${reason}のため標準方式（thinking OFF）を使用`, "info");
		}
		const stream: NonNullable<Parameters<typeof compact>[7]> = (model, context, options) => {
			// ハイブリッドモデルは古い位置へ戻せないことがあるため、送信済みの末尾まで維持する。
			const input = prefix ? { messages: [...replay!.messages, {
				role: "user" as const,
				content: `${INSTRUCTION}${event.customInstructions ? `\n\nAdditional focus:\n${event.customInstructions}` : ""}`,
				timestamp: Date.now(),
			}] } : context;
			const pending = ctx.modelRegistry.streamSimple(model, input, {
				...options,
				reasoning: "off",
				onPayload: value => {
					const payload = forceOff(value, prefix ? saved?.wire : undefined);
					if (prefix) {
						const isHead = (m: any) => m.role === "system" || m.role === "developer";
						let capturedHead = 0, generatedHead = 0;
						while (isHead(saved!.wire!.messages[capturedHead] ?? {})) capturedHead++;
						while (isHead(payload.messages[generatedHead] ?? {})) generatedHead++;
						// 後から記録されたsystem状態も通常要求では先頭に投影されるため、送信済みの先頭を使う。
						payload.messages = [...saved!.wire!.messages.slice(0, capturedHead), ...payload.messages.slice(generatedHead)];
						const history = payload.messages.slice(0, -1);
						// 別拡張の変換やSDK更新で履歴が変わった場合は、そのまま置換しない。
						const captured = saved!.wire!.messages;
						const appendedReply = replay !== saved ? 1 : 0;
						if (history.length !== captured.length + appendedReply || JSON.stringify(history.slice(0, captured.length)) !== JSON.stringify(captured)) {
							throw new Error("Compact prefix differs from the previous provider request");
						}
					}
					return payload;
				},
			});
			return { result: async () => { const response = await pending.result(); validate(response); return response; } } as ReturnType<NonNullable<Parameters<typeof compact>[7]>>;
		};
		try {
			const retry = SettingsManager.create(ctx.cwd).getRetrySettings();
			const result = await compact(preparation, ctx.model, undefined, undefined,
				event.customInstructions, event.signal, "off", stream, undefined, retry, undefined, ctx.sessionManager.getSessionId());
			if (event.signal.aborted) return { cancel: true };
			return { compaction: { ...result, details: { ...result.details, localCompact: { version: 3, method: prefix ? "native-full" : "standard", thinking: false, images: !!hasImages } } } };
		} catch (error) {
			// 不完全な要約を保存したり、思考ありへ黙って再試行したりしない。
			if (!event.signal.aborted) ctx.ui.notify(`Compact失敗（元の会話は保持）: ${error instanceof Error ? error.message : String(error)}`, "error");
			return { cancel: true };
		}
	});
}

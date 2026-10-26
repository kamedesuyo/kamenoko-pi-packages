import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerHealthWatch } from '../src/local-compact-health.mjs';

export default function (pi: ExtensionAPI) {
	// compact本体が読み込めない更新でも通知できるよう、監視側はSDKの実行時exportに依存しない。
	registerHealthWatch(pi);
}

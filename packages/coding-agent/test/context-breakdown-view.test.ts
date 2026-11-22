import { describe, expect, it } from "bun:test";
import type { ContextBreakdown } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { toContextBreakdownView } from "../src/session/context-usage-runtime";

const breakdown = {
	model: { provider: "anthropic", id: "claude-x", name: "Claude X", contextWindow: 200_000 },
	contextWindow: 200_000,
	categories: [
		{ id: "systemPrompt", label: "System prompt", tokens: 3_000, extra: "dropped" },
		{ id: "messages", label: "Messages", tokens: 40_000 },
	],
	usedTokens: 43_000,
	autoCompactBufferTokens: 20_000,
	freeTokens: 137_000,
	thresholdTokens: 180_000,
	snapcompact: { visionCapable: true, savedTokens: 1_500 },
} as unknown as ContextBreakdown;

describe("toContextBreakdownView", () => {
	it("projects numbers and ids only, leaving the model object and snapcompact detail behind", () => {
		const view = toContextBreakdownView(breakdown);
		expect(view).toEqual({
			model: { provider: "anthropic", modelId: "claude-x" },
			contextWindow: 200_000,
			categories: [
				{ id: "systemPrompt", label: "System prompt", tokens: 3_000 },
				{ id: "messages", label: "Messages", tokens: 40_000 },
			],
			usedTokens: 43_000,
			autoCompactBufferTokens: 20_000,
			freeTokens: 137_000,
			thresholdTokens: 180_000,
			snapcompactSavedTokens: 1_500,
		});
	});

	it("omits the threshold and savings when compaction is off and snapcompact inactive", () => {
		const view = toContextBreakdownView({ ...breakdown, thresholdTokens: undefined, snapcompact: undefined });
		expect("thresholdTokens" in view).toBe(false);
		expect("snapcompactSavedTokens" in view).toBe(false);
	});
});

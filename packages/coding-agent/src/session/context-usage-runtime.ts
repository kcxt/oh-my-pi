import { type CompactionSettings, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	computeCompactionBoundaries,
	computeContextBreakdown,
	type CompactionBoundaries,
	type ContextBreakdown,
	type ContextSavingsEstimate,
} from "@oh-my-pi/pi-tui/status-line/context-usage";
import type { ScopeLike } from "../config/registry";
import type { AgentSession } from "./agent-session";
import { resolveSpeculationMethod } from "./compaction-methods";
import { estimateInlineSavings } from "./snapcompact-inline";
import { resolveModelCompactionSettings } from "./model-compaction-threshold";
import { resolveSpeculationLeadTokens } from "./speculation-lead";

import { cfgSnapcompactShape, cfgSnapcompactSystemPrompt, cfgSnapcompactToolResults } from "./context-settings";

/** Resolve session policy before handing pure boundary arithmetic to the UI. */
export function getSessionCompactionBoundaries(
	settings: ScopeLike,
	contextWindow: number,
	model?: Model | null,
): CompactionBoundaries | null {
	if (!(contextWindow > 0)) return null;
	const configured = resolveModelCompactionSettings(settings, model);
	const compaction: CompactionSettings = configured;
	if (!compaction.enabled || compaction.strategy === "off") return null;
	const threshold = resolveThresholdTokens(contextWindow, compaction);
	if (!(threshold > 0) || threshold > contextWindow) return null;
	const speculates = configured.asyncEnabled !== false && resolveSpeculationMethod(model, configured) !== undefined;
	return computeCompactionBoundaries(
		compaction,
		contextWindow,
		speculates ? resolveSpeculationLeadTokens(threshold) : undefined,
	);
}

/** Read host settings and optionally run the provider's inline-image planner. */
export function computeSessionContextBreakdown(
	session: AgentSession,
	options?: { snapcompactSavings?: boolean },
): ContextBreakdown {
	let snapcompact: ContextSavingsEstimate | undefined;
	if (options?.snapcompactSavings) {
		const renderSystemPrompt = cfgSnapcompactSystemPrompt.get(session.settings);
		const renderToolResults = cfgSnapcompactToolResults.get(session.settings);
		if (renderSystemPrompt !== "none" || renderToolResults) {
			snapcompact = estimateInlineSavings({
				options: { renderSystemPrompt, renderToolResults, shape: cfgSnapcompactShape.get(session.settings) },
				model: session.model,
				systemPrompt: session.systemPrompt ?? [],
				messages: session.messages ?? [],
			});
		}
	}
	return computeContextBreakdown(session, {
		compaction: resolveModelCompactionSettings(session.settings, session.model),
		sourceRevision: session.settings.revision,
		snapcompact,
	});
}

/** `get_context_breakdown` result: the `/context` categories, without per-item entries or transcript text. */
export interface ContextBreakdownView {
	model?: { provider: string; modelId: string };
	contextWindow: number;
	categories: { id: string; label: string; tokens: number }[];
	usedTokens: number;
	autoCompactBufferTokens: number;
	freeTokens: number;
	/** Where auto-compaction fires; absent when compaction is off. */
	thresholdTokens?: number;
	/** Estimated wire tokens snapcompact saves; absent when no `snapcompact.*` setting is enabled. */
	snapcompactSavedTokens?: number;
}

/** The wire projection of a breakdown for `get_context_breakdown`: numbers only, no model object or snapcompact detail. */
export function toContextBreakdownView(breakdown: ContextBreakdown): ContextBreakdownView {
	return {
		...(breakdown.model ? { model: { provider: breakdown.model.provider, modelId: breakdown.model.id } } : {}),
		contextWindow: breakdown.contextWindow,
		categories: breakdown.categories.map(({ id, label, tokens }) => ({ id, label, tokens })),
		usedTokens: breakdown.usedTokens,
		autoCompactBufferTokens: breakdown.autoCompactBufferTokens,
		freeTokens: breakdown.freeTokens,
		...(breakdown.thresholdTokens !== undefined ? { thresholdTokens: breakdown.thresholdTokens } : {}),
		...(breakdown.snapcompact ? { snapcompactSavedTokens: breakdown.snapcompact.savedTokens } : {}),
	};
}

/**
 * The `/context` view of `session`, or why there is none: no model is selected, or its context window is
 * unknown. Shared by RPC `get_context_breakdown` and `omp session inspect`.
 */
export function tryContextBreakdownView(session: AgentSession): { view: ContextBreakdownView } | { reason: string } {
	if (!session.model) return { reason: "no model is selected for this session" };
	const breakdown = computeSessionContextBreakdown(session, { snapcompactSavings: true });
	if (!(breakdown.contextWindow > 0) || !Number.isFinite(breakdown.contextWindow)) {
		return { reason: "the model's context window is unknown or invalid" };
	}
	return { view: toContextBreakdownView(breakdown) };
}

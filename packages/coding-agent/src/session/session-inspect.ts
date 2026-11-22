/**
 * `omp session inspect`: what a live session on this transcript would report, without
 * owning it. omp starts up as it normally would for the session's cwd (model registry,
 * tools, skills, extensions, instruction files), but the transcript is opened through a
 * read-only session manager ({@link SessionManager.openReadOnly}): no ownership lease is
 * claimed and nothing is ever written to the session, its artifacts, or its title. Idle
 * maintenance and goal continuation are owned by interactive hosts and never started here.
 */
import type { GoalModeState } from "../goals/state";
import { createAgentSession } from "../sdk";
import type { RpcAvailableSlashCommand } from "../modes/rpc/rpc-types";
import { buildAvailableSlashCommands } from "../slash-commands/available-commands";
import { type ContextBreakdownView, tryContextBreakdownView } from "./context-usage-runtime";
import { SessionManager } from "./session-manager";
import { isSessionLeaseHeld } from "./session-storage";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

export interface SessionInspection {
	sessionId: string;
	title: string | null;
	model: { provider: string; modelId: string } | null;
	thinkingLevel: string | null;
	/** `null` with {@link contextBreakdownReason} when no model is selected or its window is unknown. */
	contextBreakdown: ContextBreakdownView | null;
	contextBreakdownReason?: string;
	/** Same shape as RPC `get_available_commands`. */
	availableCommands: RpcAvailableSlashCommand[];
	todoPhases: TodoPhase[];
	goal: GoalModeState | null;
	/** Whether a running omp owns the session, probed without taking the lease; `null` when it cannot be probed. */
	leaseHeld: boolean | null;
}

/**
 * Inspect the session stored at `sessionPath`.
 * @throws Error when the file is missing or holds no valid session header.
 */
export async function inspectSession(sessionPath: string): Promise<SessionInspection> {
	const manager = await SessionManager.openReadOnly(sessionPath);
	const sessionId = manager.getSessionId();
	// Probed before startup so the answer never reflects anything this process did.
	const leaseHeld = isSessionLeaseHeld(sessionId);
	const { session } = await createAgentSession({
		cwd: manager.getCwd(),
		sessionManager: manager,
		hasUI: false,
		skipPythonPreflight: true,
	});
	try {
		const breakdown = tryContextBreakdownView(session);
		const model = session.model;
		return {
			sessionId,
			title: manager.getSessionName() ?? null,
			model: model ? { provider: model.provider, modelId: model.id } : null,
			thinkingLevel: session.thinkingLevel ?? null,
			contextBreakdown: "view" in breakdown ? breakdown.view : null,
			...("reason" in breakdown ? { contextBreakdownReason: breakdown.reason } : {}),
			availableCommands: await buildAvailableSlashCommands(session),
			todoPhases: session.getTodoPhases(),
			goal: session.getGoalModeState() ?? null,
			leaseHeld,
		};
	} finally {
		await session.dispose();
	}
}

/**
 * `omp session inspect`: what a live session on this transcript would report, without
 * owning it. omp starts up as it normally would for the session's cwd (model registry,
 * tools, skills, extensions, instruction files), but the transcript is opened through a
 * read-only session manager ({@link SessionManager.openReadOnly}): no ownership lease is
 * claimed and nothing is ever written to the session, its artifacts, or its title. Idle
 * maintenance and goal continuation are owned by interactive hosts and never started here.
 */
import type { GoalModeState } from "../goals/state";
import type { RpcAvailableSlashCommand } from "../modes/rpc/rpc-types";
import { createAgentSession, SessionModelRestoreError } from "../sdk";
import { buildAvailableSlashCommands } from "../slash-commands/available-commands";
import { type ContextBreakdownView, tryContextBreakdownView } from "./context-usage-runtime";
import { SessionManager } from "./session-manager";
import { isSessionLeaseHeld } from "./session-storage";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

export interface SessionInspection {
	sessionId: string;
	title: string | null;
	model: { provider: string; modelId: string } | null;
	/**
	 * Present when the saved model could not be restored or no model could be selected: `requested` is the
	 * saved `provider/id` (null when the session saved none), `reason` omp's own message.
	 */
	modelFallback?: { requested: string | null; reason: string };
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
 * Inspect the session stored at `sessionPath`. A saved model that cannot be restored does not fail it:
 * the model actually selected is reported with {@link SessionInspection.modelFallback}.
 * @throws Error when the file is missing or holds no valid session header.
 */
export async function inspectSession(sessionPath: string): Promise<SessionInspection> {
	const manager = await SessionManager.openReadOnly(sessionPath);
	const sessionId = manager.getSessionId();
	// Probed before startup so the answer never reflects anything this process did.
	const leaseHeld = isSessionLeaseHeld(sessionId);
	const options = { cwd: manager.getCwd(), sessionManager: manager, skipPythonPreflight: true };
	let started: Awaited<ReturnType<typeof createAgentSession>>;
	// The saved `provider/id` the first start could not restore; the message the SDK then reports can
	// drop it (no model at all), so it is taken from the error.
	let requested: string | null = null;
	let restoreFailure: string | undefined;
	try {
		started = await createAgentSession({ ...options, hasUI: false });
	} catch (error) {
		if (!(error instanceof SessionModelRestoreError)) throw error;
		restoreFailure = error.message;
		requested = error.message.slice("Could not restore model ".length);
		// The saved model cannot be restored (a local provider that is down, a removed model). Start as an
		// interactive resume does: a UI host may continue on another model and report why.
		started = await createAgentSession({ ...options, hasUI: true });
	}
	const { session, modelFallbackMessage } = started;
	try {
		const breakdown = tryContextBreakdownView(session);
		const model = session.model;
		return {
			sessionId,
			title: manager.getSessionName() ?? null,
			model: model ? { provider: model.provider, modelId: model.id } : null,
			...(modelFallbackMessage || restoreFailure
				? {
						modelFallback: {
							requested,
							reason:
								restoreFailure && modelFallbackMessage && !modelFallbackMessage.includes(restoreFailure)
									? `${restoreFailure}. ${modelFallbackMessage}`
									: (modelFallbackMessage ?? restoreFailure ?? ""),
						},
					}
				: {}),
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

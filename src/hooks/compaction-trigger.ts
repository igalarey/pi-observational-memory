import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rawTokensSinceLastCompaction, type Entry } from "../ledger/index.js";
import type { Runtime } from "../runtime.js";

function contextPressureTokens(
	ctx: { getContextUsage?: () => { tokens: number | null } | undefined; sessionManager: { getBranch: () => Entry[] } },
	threshold: number,
): { tokens: number; due: boolean } {
	const live = ctx.getContextUsage?.()?.tokens;
	if (live != null) return { tokens: live, due: live >= threshold };
	const raw = rawTokensSinceLastCompaction(ctx.sessionManager.getBranch());
	return { tokens: raw, due: raw >= threshold };
}

function recordCompactionFailure(runtime: Runtime, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	if (message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError")) return;
	runtime.lastWorkerError = `compaction failed: ${message}`;
}

/**
 * Trigger compaction after the agent run has completely settled and live context usage crosses
 * `compactAtContextTokens`.
 *
 * `ctx.compact()` is the manual-compaction entry point in pi. It calls `AgentSession.abort()`
 * before doing any work. Calling it from `turn_end` therefore aborts the still-running agent
 * loop; when a tool turn is in progress, pi records that intentional cancellation as an
 * assistant error (usually "The operation was aborted."). The public `agent_settled` event is
 * emitted only after retries, automatic compaction, queued messages, and the agent loop have
 * finished, so it is the safe point at which to invoke `ctx.compact()` without manufacturing an
 * error message.
 *
 * Deferring to settled means a long tool chain may finish before observational-memory's lower
 * threshold is applied. Pi's native overflow/automatic compaction remains responsible for
 * protecting the model while a run is still in progress.
 */
export type CompactionTriggerContext = {
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: { getBranch: () => Entry[] };
	getContextUsage?: () => { tokens: number | null } | undefined;
	compact: (options?: {
		onComplete?: () => void;
		onError?: (error: Error) => void;
	}) => void;
};

export function evaluateCompactionTrigger(runtime: Runtime, ctx: CompactionTriggerContext): void {
	if (!runtime.enabled || runtime.config.passive) return;
	if (runtime.compactInFlight) return;
	if (!contextPressureTokens(ctx, runtime.config.compactAtContextTokens).due) return;

	const hasUI = ctx.hasUI;
	const ui = ctx.ui;
	runtime.compactInFlight = true;
	if (hasUI) ui?.notify("om: context threshold reached — compacting (waiting for in-flight observers)…", "info");

	// Fire-and-forget. The before-compact hook waits for observers and renders the block.
	try {
		ctx.compact({
			onComplete: () => {
				runtime.compactInFlight = false;
				if (hasUI) ui?.notify("om: compaction complete", "info");
			},
			onError: (error) => {
				runtime.compactInFlight = false;
				// Compaction can legitimately lose a race with the agent/session lifecycle. Keep the
				// detail available to /om:status, but do not turn it into a red toast.
				recordCompactionFailure(runtime, error);
			},
		});
	} catch (error) {
		runtime.compactInFlight = false;
		recordCompactionFailure(runtime, error);
	}
}

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const handler = (_event: unknown, ctx: CompactionTriggerContext) => evaluateCompactionTrigger(runtime, ctx);
	pi.on("agent_settled", handler as never);
}

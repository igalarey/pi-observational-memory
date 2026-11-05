/**
 * Observational memory — ORCHESTRATOR (master-side, in-process).
 *
 * The conductor: owns the clocks/triggers, spawns subprocess workers, commits their output to
 * the ledger (observations) or files (long-term, Phase B), renders compaction, and drives the
 * TUI. Event-driven only — no daemon.
 *
 * Enabled by default per session (A2a). When explicitly gated off, every handler returns at
 * its first line and the extension is completely invisible.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactCommand } from "./commands/compact.js";
import { registerConsolidateCommand } from "./commands/consolidate.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerCompactionHook } from "./hooks/compaction-hook.js";
import { registerCompactionTrigger } from "./hooks/compaction-trigger.js";
import { registerConsolidatorTrigger } from "./hooks/consolidator-trigger.js";
import { registerObserverTrigger } from "./hooks/observer-trigger.js";
import { OM_ENABLED, type Entry } from "./ledger/index.js";
import { OM_MEMORY_SCOPE, selectMemoryScope } from "./memory/session.js";
import { DATA_POLICY } from "./privacy.js";
import { modelArg } from "./spawn/launch.js";
import { Runtime } from "./runtime.js";

export function readGateFromLedger(branch: Entry[]): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === OM_ENABLED) {
			return (entry.data as { enabled?: boolean } | undefined)?.enabled ?? true;
		}
	}
	return true;
}

export default function observationalMemory(pi: ExtensionAPI): void {
	const runtime = new Runtime();

	function attachIfEnabled(ctx: any): void {
		if (runtime.enabled && ctx.mode === "tui" && ctx.hasUI && ctx.ui) {
			runtime.status.attach(ctx.ui);
		} else {
			runtime.status.detach();
		}
	}

	function setMemoryScope(ctx: any, forceNew = false): void {
		const sessionId = ctx.sessionManager.getSessionId();
		const scope = selectMemoryScope(ctx.cwd, sessionId, ctx.sessionManager.getBranch(), forceNew);
		runtime.sessionId = sessionId;
		runtime.branchId = scope.scopeId;
		runtime.memoryRoot = scope.root;
		if (scope.fresh) pi.appendEntry(OM_MEMORY_SCOPE, { scopeId: scope.scopeId });
	}

	function announcePolicy(ctx: any): void {
		pi.appendEntry("om.data-policy", { version: 1, models: runtime.config.models, thinkingCapture: false, credentialRedaction: "best-effort" });
		if (ctx.hasUI) ctx.ui.notify(`om: observer ${modelArg(runtime.config.models.observer)}; consolidator ${modelArg(runtime.config.models.consolidator)}. ${DATA_POLICY}`, "info");
	}

	pi.on("session_start", (_event: unknown, ctx: any) => {
		runtime.abortAllWorkers();
		runtime.configLoaded = false;
		runtime.ensureConfig(ctx.cwd);
		const branch = ctx.sessionManager.getBranch() as Entry[];
		runtime.enabled = readGateFromLedger(branch);
		if (runtime.enabled) { setMemoryScope(ctx); announcePolicy(ctx); }
		attachIfEnabled(ctx);
		runtime.refreshFooterGauges(branch, ctx.getContextUsage?.()?.tokens ?? null);
		runtime.refreshCost(ctx.sessionManager.getEntries() as Entry[]);
	});

	const invalidate = async () => { runtime.abortAllWorkers(); await runtime.whenWorkersIdle(); };
	pi.on("session_before_tree", invalidate);
	pi.on("session_before_fork", invalidate);
	pi.on("session_before_switch", invalidate);
	pi.on("session_tree", (_event, ctx) => {
		runtime.abortAllWorkers();
		const branch = ctx.sessionManager.getBranch() as Entry[];
		runtime.enabled = readGateFromLedger(branch);
		if (runtime.enabled) setMemoryScope(ctx, true);
		attachIfEnabled(ctx);
		runtime.refreshFooterGauges(branch, ctx.getContextUsage?.()?.tokens ?? null);
	});

	pi.on("session_shutdown", async () => {
		runtime.status.detach();
		runtime.abortAllWorkers();
		await runtime.whenWorkersIdle();
	});

	pi.registerCommand("om", {
		description: "Toggle observational memory for this session (/om on, /om off)",
		handler: async (args: string, ctx: any) => {
			const arg = (args ?? "").trim().toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !runtime.enabled;
			if (next === runtime.enabled) {
				if (ctx.hasUI) ctx.ui.notify(`om already ${next ? "on" : "off"}`, "info");
				return;
			}
			runtime.enabled = next;
			pi.appendEntry(OM_ENABLED, { enabled: next });
			if (next) {
				setMemoryScope(ctx);
				announcePolicy(ctx);
				attachIfEnabled(ctx);
				runtime.refreshFooterGauges(ctx.sessionManager.getBranch() as Entry[], ctx.getContextUsage?.()?.tokens ?? null);
				runtime.refreshCost(ctx.sessionManager.getEntries() as Entry[]);
			} else {
				runtime.abortAllWorkers();
				runtime.status.detach();
			}
			if (ctx.hasUI) ctx.ui.notify(`om ${next ? "enabled" : "disabled"}`, "info");
		},
	});

	// Triggers + hook self-gate on runtime.enabled / passive at their first line.
	registerObserverTrigger(pi, runtime);
	registerConsolidatorTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerCompactCommand(pi, runtime);
	registerConsolidateCommand(pi, runtime);
}

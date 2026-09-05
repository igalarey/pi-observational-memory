import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";

export function registerCompactCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:compact", {
		description: "Force an observational-memory compaction now (ignores threshold)",
		handler: async (_args: string, ctx: any) => {
			if (!runtime.enabled) {
				if (ctx.hasUI) ctx.ui.notify("om is off (use /om on to enable)", "info");
				return;
			}
			if (runtime.compactInFlight) {
				if (ctx.hasUI) ctx.ui.notify("om: compaction already in progress", "warning");
				return;
			}

			// AgentSession.compact() aborts an active run before compacting. Wait for a user
			// command issued during streaming instead, otherwise the intentional abort is
			// persisted and shown as an assistant error ("The operation was aborted.").
			if (ctx.isIdle?.() === false && !ctx.waitForIdle) return;
			if (ctx.waitForIdle) {
				if (ctx.isIdle?.() === false && ctx.hasUI) {
					ctx.ui.notify("om: waiting for the current turn to finish…", "info");
				}
				await ctx.waitForIdle();
				if (ctx.isIdle?.() === false) return;
			}
			if (!runtime.enabled) return;
			if (runtime.compactInFlight) {
				if (ctx.hasUI) ctx.ui.notify("om: compaction already in progress", "warning");
				return;
			}

			runtime.compactInFlight = true;
			// The before-compact hook waits for in-flight observers before folding (design R5),
			// so we trigger compaction straight away here too.
			if (ctx.hasUI) ctx.ui.notify("om: compacting (waiting for in-flight observers)…", "info");
			try {
				ctx.compact({
					onComplete: () => {
						runtime.compactInFlight = false;
						if (ctx.hasUI) ctx.ui.notify("om: compaction complete", "info");
					},
					onError: (error: Error) => {
						runtime.compactInFlight = false;
						if (error.message !== "Compaction cancelled" && error.name !== "AbortError") {
							runtime.lastWorkerError = `compaction failed: ${error.message}`;
						}
					},
				});
			} catch (error) {
				runtime.compactInFlight = false;
				const message = error instanceof Error ? error.message : String(error);
				runtime.lastWorkerError = `compaction failed: ${message}`;
			}
		},
	});
}

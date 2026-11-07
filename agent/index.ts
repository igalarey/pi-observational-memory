/**
 * Shared worker agent extension (L4), loaded into a subprocess `pi` via `-e`. Branches on
 * the OM_WORKER env var. Phase A implements the `observer` role only; `consolidator` arrives
 * in Phase B.
 *
 * The worker is headless (`pi -p`): builtin tools are disabled (`--no-builtin-tools`), the
 * system prompt is fully replaced with the role prompt, and the role registers only the tools
 * it needs. Output is handed back to the orchestrator via the result file (see src/spawn/runs.ts).
 *
 * Chunk delivery: the orchestrator passes the conversation chunk as the `pi -p` prompt, so it
 * is recorded as a real user message. We deliberately do NOT inject it via the `context` hook
 * — that is non-destructive and never persists to the session, which would leave the chunk
 * invisible when inspecting/resuming the observer run and defeat the observability goal
 * (decision 11). The system prompt carries role + rules only.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trackWorkerCost } from "./cost.js";
import { redactPayload } from "../src/privacy.js";
import { safeRead } from "../src/memory/paths.js";
import { CONSOLIDATOR_SYSTEM } from "./consolidator/prompt.js";
import { registerConsolidatorTools } from "./consolidator/tools.js";
import { OBSERVER_SYSTEM } from "./observer/prompt.js";
import { registerObserverTool } from "./observer/tool.js";

export default function omWorker(pi: ExtensionAPI): void {
	const role = process.env.OM_WORKER;
	const resultPath = process.env.OM_RESULT_PATH;

	// Shared across roles: pull pi's built-in cost and hand it back via the cost file.
	// Registered first so it writes the cost file before each role's agent_end shutdown.
	trackWorkerCost(pi);
	pi.on("before_provider_request", event => redactPayload(event.payload));

	if (role === "observer") {
		if (!resultPath) throw new Error("OM_RESULT_PATH not set for observer worker");
		registerObserverTool(pi, resultPath);

		pi.on("before_agent_start", async () => {
			return { systemPrompt: OBSERVER_SYSTEM };
		});

		// Headless `pi -p` exits when the agent loop ends; shutdown is a belt-and-suspenders.
		pi.on("agent_end", async (_event: unknown, ctx: { shutdown: () => void }) => {
			ctx.shutdown();
		});
		return;
	}

	if (role === "consolidator") {
		const memoryRoot = process.env.OM_MEMORY_DIR;
		if (!memoryRoot) throw new Error("OM_MEMORY_DIR not set for consolidator worker");
		if (!resultPath) throw new Error("OM_RESULT_PATH not set for consolidator worker");
		const batchIdsPath = process.env.OM_BATCH_IDS_PATH;
		if (!batchIdsPath) throw new Error("OM_BATCH_IDS_PATH not set for consolidator worker");
		let batchIds: unknown;
		try { batchIds = JSON.parse(safeRead(batchIdsPath)); } catch { throw new Error("Missing or invalid consolidation batch ID manifest"); }
		if (!Array.isArray(batchIds) || !batchIds.every(id => typeof id === "string" && id.length > 0)) {
			throw new Error("Invalid consolidation batch ID manifest");
		}
		registerConsolidatorTools(pi, memoryRoot, resultPath, new Set(batchIds));

		pi.on("before_agent_start", async () => {
			return { systemPrompt: CONSOLIDATOR_SYSTEM };
		});

		pi.on("agent_end", async (_event: unknown, ctx: { shutdown: () => void }) => {
			ctx.shutdown();
		});
		return;
	}
}

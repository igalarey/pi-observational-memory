import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { safeRead, sessionMemoryRoot } from "./paths.js";
import type { Entry } from "../ledger/types.js";

export const OM_MEMORY_SCOPE = "om.memory.scope";

export function selectMemoryScope(cwd: string, sessionId: string, branch: Entry[], forceNew = false): { root: string; scopeId: string; fresh: boolean } {
	const previous = [...branch].reverse().find(entry => entry.type === "custom" && entry.customType === OM_MEMORY_SCOPE);
	const scopeId = (previous?.data as { scopeId?: string } | undefined)?.scopeId;
	if (!forceNew && scopeId && /^[a-zA-Z0-9-]+$/.test(scopeId)) {
		const root = sessionMemoryRoot(cwd, `${sessionId}-${scopeId}`);
		if (!existsSync(root)) return { root, scopeId, fresh: false };
		try {
			const provenance: unknown = JSON.parse(safeRead(join(root, ".branch.json")));
			const current = new Set(branch.map(entry => entry.id));
			if (Array.isArray(provenance) && provenance.length && provenance.every(id => typeof id === "string" && current.has(id))) {
				return { root, scopeId, fresh: false };
			}
		} catch {}
	}
	const next = randomUUID();
	return { root: sessionMemoryRoot(cwd, `${sessionId}-${next}`), scopeId: next, fresh: true };
}

type SessionCtx = {
	cwd: string;
	sessionManager: {
		getSessionId: () => string;
		getHeader?: () => { id?: string; cwd?: string; parentSession?: string } | null | undefined;
	};
};

export function ensureSessionMemory(ctx: SessionCtx): string {
	// A parent's current files are not a snapshot of the historical fork point.
	return sessionMemoryRoot(ctx.cwd, ctx.sessionManager.getSessionId());
}

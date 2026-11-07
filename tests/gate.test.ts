import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import observationalMemory, { readGateFromLedger } from "../src/index.js";
import * as launch from "../src/spawn/launch.js";
import { rawMessage } from "./fixtures/session.js";
import { OM_ENABLED, type Entry } from "../src/ledger/index.js";
import { Runtime } from "../src/runtime.js";

function gateEntry(id: string, enabled: boolean): Entry {
	return {
		type: "custom",
		id,
		customType: OM_ENABLED,
		data: { enabled },
	};
}

describe("per-session gate", () => {
	it("is enabled when the session has no persisted gate state", () => {
		expect(new Runtime().enabled).toBe(true);
		expect(readGateFromLedger([])).toBe(true);
	});

	it("honors the latest explicit gate state", () => {
		expect(readGateFromLedger([gateEntry("off", false)])).toBe(false);
		expect(readGateFromLedger([gateEntry("off", false), gateEntry("on", true)])).toBe(true);
		expect(readGateFromLedger([gateEntry("on", true), gateEntry("off", false)])).toBe(false);
	});

	it.each([true, false])("preserves memory and commands through lifecycle events (hidden=%s)", async (hidden) => {
		const root = mkdtempSync(join(tmpdir(), "om-status-gate-"));
		const handlers = new Map<string, any>();
		const commands = new Map<string, any>();
		const branch: Entry[] = [rawMessage("a", "Synthetic conversation text")];
		const ui = {
			setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(),
			theme: { fg: (_color: string, text: string) => text },
		};
		try {
			const agent = join(root, "agent"); mkdirSync(agent);
			vi.stubEnv("PI_CODING_AGENT_DIR", agent);
			vi.stubEnv("PI_OM_PASSIVE", "0");
			writeFileSync(join(agent, "settings.json"), JSON.stringify({ "observational-memory": {
				...(hidden ? { showStatus: false } : {}), chunkTokens: 1, observerConcurrency: 1,
			} }));
			const spawn = vi.spyOn(launch, "spawnWorker").mockImplementation(async opts => {
				mkdirSync(dirname(opts.env.OM_COST_PATH!), { recursive: true });
				writeFileSync(opts.env.OM_COST_PATH!, JSON.stringify({ costUsd: 0.25 }));
				return { code: 1, signal: null, stderr: "synthetic failure" };
			});
			observationalMemory({
				on: (name: string, handler: any) => handlers.set(name, handler),
				registerCommand: (name: string, command: any) => commands.set(name, command),
				appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", id: `entry-${branch.length}`, customType, data }),
			} as any);
			const ctx = {
				cwd: root, mode: "tui", hasUI: true, ui,
				sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionId: () => "synthetic-session" },
			};
			await handlers.get("session_start")({}, ctx);
			expect(branch.some(entry => entry.type === "custom" && entry.customType === "om.data-policy")).toBe(true);
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("om: observer"), "info");
			await handlers.get("agent_start")({}, ctx);
			await vi.waitFor(() => expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("observer failed"), "error"));
			expect(spawn).toHaveBeenCalledTimes(1);
			await commands.get("om:status").handler("", ctx);
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("session cost: $0.2500 (1 run)"), "info");
			for (const arg of ["off", "on", "", ""]) await commands.get("om").handler(arg, ctx);
			await handlers.get("session_before_tree")({}, ctx);
			await handlers.get("session_tree")({}, ctx);
			await commands.get("om:status").handler("", ctx);
			expect(ui.notify.mock.calls.at(-1)?.[0]).toContain("om status");
			expect(branch.filter(entry => entry.type === "custom" && entry.customType === OM_ENABLED).map(entry => entry.data)).toEqual([
				{ enabled: false }, { enabled: true }, { enabled: false }, { enabled: true },
			]);
			if (hidden) {
				expect(ui.setStatus).not.toHaveBeenCalled();
				expect(ui.setWidget).not.toHaveBeenCalled();
			} else {
				expect(ui.setStatus).toHaveBeenCalledWith("om", expect.any(String));
				expect(ui.setWidget).toHaveBeenCalledWith("om-workers", expect.any(Function));
			}
		} finally {
			await handlers.get("session_shutdown")?.();
			vi.restoreAllMocks(); vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

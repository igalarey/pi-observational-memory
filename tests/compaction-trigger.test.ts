import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactCommand } from "../src/commands/compact.js";
import { registerCompactionTrigger, type CompactionTriggerContext } from "../src/hooks/compaction-trigger.js";
import { Runtime } from "../src/runtime.js";

type Handler = (event: unknown, ctx: CompactionTriggerContext) => void;

function setup() {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: unknown) => handlers.set(event, handler as Handler),
	} as unknown as ExtensionAPI;
	const runtime = new Runtime();
	runtime.config = { ...runtime.config, compactAtContextTokens: 100 };
	const compact = vi.fn();
	const ctx: CompactionTriggerContext = {
		hasUI: false,
		sessionManager: { getBranch: () => [] },
		getContextUsage: () => ({ tokens: 100 }),
		compact,
	};
	return { handlers, runtime, ctx, compact, pi };
}

describe("compaction trigger", () => {
	it("waits for agent_settled instead of aborting a turn at turn_end", () => {
		const { handlers, runtime, ctx, compact, pi } = setup();
		registerCompactionTrigger(pi, runtime);

		expect(handlers.has("turn_end")).toBe(false);
		expect(handlers.has("agent_settled")).toBe(true);
		handlers.get("agent_settled")!({}, ctx);

		expect(compact).toHaveBeenCalledOnce();
		expect(runtime.compactInFlight).toBe(true);
	});

	it("does not compact below the configured threshold", () => {
		const { handlers, runtime, ctx, compact, pi } = setup();
		ctx.getContextUsage = () => ({ tokens: 99 });
		registerCompactionTrigger(pi, runtime);
		handlers.get("agent_settled")!({}, ctx);

		expect(compact).not.toHaveBeenCalled();
	});

	it("does not show compaction failures as red toasts", () => {
		const { handlers, runtime, ctx, compact, pi } = setup();
		const notify = vi.fn();
		ctx.hasUI = true;
		ctx.ui = { notify };
		registerCompactionTrigger(pi, runtime);
		handlers.get("agent_settled")!({}, ctx);

		const options = compact.mock.calls[0][0] as { onError?: (error: Error) => void };
		options.onError?.(new Error("Nothing to compact (session too small)"));

		expect(notify.mock.calls.some(([, level]) => level === "error")).toBe(false);
		expect(runtime.compactInFlight).toBe(false);
	});

	it("waits for an active run before manual compaction", async () => {
		const runtime = new Runtime();
		let command: ((args: string, ctx: any) => Promise<void>) | undefined;
		const pi = {
			registerCommand: (_name: string, definition: { handler: typeof command }) => {
				command = definition.handler;
			},
		} as unknown as ExtensionAPI;
		const compact = vi.fn();
		let active = true;
		const waitForIdle = vi.fn(async () => {
			active = false;
		});
		registerCompactCommand(pi, runtime);

		await command!("", {
			hasUI: false,
			isIdle: () => !active,
			waitForIdle,
			compact,
		});

		expect(waitForIdle).toHaveBeenCalledOnce();
		expect(compact).toHaveBeenCalledOnce();
	});

	it("does not compact an active run when no idle waiter is available", async () => {
		const runtime = new Runtime();
		let command: ((args: string, ctx: any) => Promise<void>) | undefined;
		const pi = {
			registerCommand: (_name: string, definition: { handler: typeof command }) => {
				command = definition.handler;
			},
		} as unknown as ExtensionAPI;
		const compact = vi.fn();
		registerCompactCommand(pi, runtime);

		await command!("", {
			hasUI: false,
			isIdle: () => false,
			compact,
		});

		expect(compact).not.toHaveBeenCalled();
	});

	it("does not show manual compaction failures as red toasts", async () => {
		const runtime = new Runtime();
		let command: ((args: string, ctx: any) => Promise<void>) | undefined;
		const pi = {
			registerCommand: (_name: string, definition: { handler: typeof command }) => {
				command = definition.handler;
			},
		} as unknown as ExtensionAPI;
		const compact = vi.fn();
		const notify = vi.fn();
		registerCompactCommand(pi, runtime);

		await command!("", {
			hasUI: true,
			ui: { notify },
			isIdle: () => true,
			compact,
		});

		const options = compact.mock.calls[0][0] as { onError?: (error: Error) => void };
		options.onError?.(new Error("Nothing to compact (session too small)"));

		expect(notify.mock.calls.some(([, level]) => level === "error")).toBe(false);
		expect(runtime.compactInFlight).toBe(false);
	});

	it("swallows synchronous compact failures without a red toast", async () => {
		const runtime = new Runtime();
		let command: ((args: string, ctx: any) => Promise<void>) | undefined;
		const pi = {
			registerCommand: (_name: string, definition: { handler: typeof command }) => {
				command = definition.handler;
			},
		} as unknown as ExtensionAPI;
		const notify = vi.fn();
		const compact = vi.fn(() => {
			throw new Error("compaction unavailable");
		});
		registerCompactCommand(pi, runtime);

		await command!("", {
			hasUI: true,
			ui: { notify },
			isIdle: () => true,
			compact,
		});

		expect(notify.mock.calls.some(([, level]) => level === "error")).toBe(false);
		expect(runtime.compactInFlight).toBe(false);
	});
});

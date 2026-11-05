/**
 * Subprocess worker launch — the yt-edit `pi -e <ext> -p` pattern (L2).
 *
 * NOT the subagents extension: that uses `--no-session --mode json`, which would defeat
 * decision 11's requirement that every worker be an ordinary recorded GLOBAL session. We
 * spawn a plain headless `pi` with no `--session-dir`, so the run is recorded under the
 * project path in `~/.pi/agent/sessions` and is openable in the session browser.
 */
import spawn from "cross-spawn";
import { mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { ConfiguredModel } from "../config.js";
import { runCostPath, runResultPath } from "./runs.js";
import { assertNoSymlinks } from "../memory/paths.js";
import { redactCredentials } from "../privacy.js";

/** Repo root = two levels up from src/spawn/. The shared agent extension lives at agent/index.ts. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const AGENT_EXTENSION_PATH = join(REPO_ROOT, "agent", "index.ts");

export function modelArg(model: ConfiguredModel): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Resolve the active `pi` entry point (subagents' trick). The PATH fallback is launched through
 * cross-spawn so npm's `pi.cmd` shim works on Windows as well as the native executable/shebang
 * used by Unix shells; no interactive shell, terminal multiplexer, or TTY is required.
 */
export function resolvePiBinary(): { command: string; baseArgs: string[] } {
	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry] };
			}
		} catch {
			// fall through
		}
	}
	return { command: "pi", baseArgs: [] };
}

export function buildWorkerArgv(opts: {
	model: ConfiguredModel;
	sessionName: string;
	agentExtensionPath?: string;
}): string[] {
	const pi = resolvePiBinary();
	const args = [
		...pi.baseArgs,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-builtin-tools",
		"--model",
		modelArg(opts.model),
	];
	if (opts.model.thinking) args.push("--thinking", opts.model.thinking);
	args.push("-e", opts.agentExtensionPath ?? AGENT_EXTENSION_PATH);
	args.push("-n", opts.sessionName);
	// The prompt is streamed through stdin by spawnWorker. Keeping it out of argv avoids the
	// Windows CreateProcess command-line limit for normal multi-thousand-token chunks.
	args.push("-p");
	return [pi.command, ...args];
}

export type WorkerExit = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

/**
 * Spawn a headless worker; resolve when it exits. Workers run in their master session's
 * `.memory/<sessionId>/` root (not the project cwd) so pi keys the run into a distinct global
 * session bucket and it never clutters the project's `/resume` picker. The root is ensured to
 * exist before spawn — `spawn()` would ENOENT otherwise (the memory root is created lazily on
 * first durable write when there is no parent to seed).
 */
export function spawnWorker(opts: {
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	input?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	killGraceMs?: number;
}): Promise<WorkerExit> {
	if (opts.signal?.aborted) return Promise.resolve({ code: null, signal: "SIGTERM", stderr: "Cancelled before spawn" });
	const [command, ...rest] = opts.argv;
	assertNoSymlinks(opts.cwd);
	mkdirSync(opts.cwd, { recursive: true, mode: 0o700 });
	return new Promise<WorkerExit>((resolvePromise) => {
		const proc = spawn(command, rest, {
			cwd: opts.cwd,
			env: opts.env,
			detached: process.platform !== "win32",
			stdio: [opts.input === undefined ? "ignore" : "pipe", "ignore", "pipe"],
		});
		let stderr = "";
		let closed = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const signalProcess = (signal: NodeJS.Signals) => {
			if (closed) return;
			try {
				if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
				else proc.kill(signal);
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") proc.kill(signal); }
		};
		const kill = () => {
			if (closed || killTimer) return;
			signalProcess("SIGTERM");
			killTimer = setTimeout(() => signalProcess("SIGKILL"), opts.killGraceMs ?? 3000);
		};
		const deadline = setTimeout(kill, Math.min(opts.timeoutMs ?? 600_000, 1_800_000));
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (closed) return;
			closed = true;
			clearTimeout(deadline);
			clearTimeout(killTimer);
			opts.signal?.removeEventListener("abort", kill);
			resolvePromise({ code, signal, stderr: redactCredentials(stderr) });
		};
		proc.stderr?.on("data", (d: Buffer) => {
			stderr = (stderr + d.toString()).slice(-16_384);
		});
		proc.stdin?.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") stderr += `${stderr ? "\n" : ""}stdin error: ${error.message}`;
		});
		if (opts.input !== undefined) proc.stdin?.end(redactCredentials(opts.input));
		proc.on("error", error => { stderr = `spawn error: ${error.message}`; if (!proc.pid) finish(1, null); });
		proc.on("close", finish);
		if (opts.signal?.aborted) kill();
		else opts.signal?.addEventListener("abort", kill, { once: true });
	});
}

export type ObserverLaunchEnv = {
	/** Absolute `.memory/<sessionId>/` root — IPC files and the consolidator sandbox live here. */
	memoryRoot: string;
	runId: string;
};

/**
 * Build the env a worker subprocess needs to write its result file. The chunk itself is NOT
 * passed via env/file — it is the `pi -p` prompt (recorded user message) so the run stays
 * faithfully inspectable on resume.
 */
export function buildWorkerEnv(role: "observer" | "consolidator", opts: ObserverLaunchEnv): NodeJS.ProcessEnv {
	return {
		...process.env,
		OM_WORKER: role,
		OM_RUN_ID: opts.runId,
		OM_RESULT_PATH: runResultPath(opts.memoryRoot, opts.runId),
		// Per-run cost handoff: the worker extension writes pi's built-in usage.cost.total here.
		OM_COST_PATH: runCostPath(opts.memoryRoot, opts.runId),
		// Sandbox root for the consolidator's scoped file tools (design risk 6).
		OM_MEMORY_DIR: opts.memoryRoot,
	};
}

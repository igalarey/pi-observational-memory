import { type Config, DEFAULTS, loadConfig } from "./config.js";
import { foldLedger, poolTokens, rawTokensSinceObservationCoverage, sumSessionCost, type Entry } from "./ledger/index.js";
import { StatusController } from "./ui/status-controller.js";

/**
 * In-process orchestrator state. Event-driven only — no daemon/timer beyond the status
 * spinner. Ephemeral: rebuilt on session_start, cleared on session_shutdown.
 */
export class Runtime {
	config: Config = { ...DEFAULTS };
	configLoaded = false;
	generation = 0;
	sessionId = "";
	branchId = "";

	captureToken(): string {
		return JSON.stringify([this.generation, this.sessionId, this.branchId, this.memoryRoot]);
	}

	isCurrent(token: string): boolean {
		return this.enabled && token === this.captureToken();
	}

	/** The per-session on/off gate (default ON). Outermost guard in every handler. */
	enabled = true;

	/**
	 * Absolute root for this session scope's durable and transient memory. Set
	 * whenever the gate is enabled (session_start / `/om on`) via `selectMemoryScope`; empty
	 * while disabled. All path helpers (listTopics/indexPath/readJourney/run*Path) take this root.
	 */
	memoryRoot = "";

	/**
	 * In-flight observer subprocesses, keyed by runId. `coversUpToId` is the source-entry id at
	 * the END of the observer's chunk — it lets compaction decide whether the observer can affect
	 * the rendered block (an observer whose chunk lands entirely in the verbatim tail is excluded
	 * from the projection regardless, so compaction need not wait for it).
	 */
	readonly observersInFlight = new Map<string, { controller: AbortController; coversUpToId: string; sourceEntryIds?: string[] }>();

	/** In-flight observer async tasks, so compaction can wait for settled memory state (design R5). */
	readonly observerTasks = new Set<Promise<void>>();

	/**
	 * Strictly one consolidator at a time (design risk 4). The flag is held from dispatch through
	 * tombstone-commit so the pool clock cannot fire a second overlapping run. Runs in the
	 * background — compaction does NOT wait for it (R5).
	 */
	consolidatorInFlight = false;
	consolidatorController: AbortController | undefined;
	consolidatorTask: Promise<void> | undefined;
	consolidatorRunId: string | undefined;

	/** Guards so compaction trigger + hook never re-enter. */
	compactInFlight = false;
	compactHookInFlight = false;
	private compactionOwner: symbol | undefined;

	beginCompaction(): symbol {
		const owner = Symbol("compaction");
		this.compactionOwner = owner;
		this.compactInFlight = true;
		return owner;
	}

	finishCompaction(owner: symbol): boolean {
		if (this.compactionOwner !== owner) return false;
		this.compactionOwner = undefined;
		this.compactInFlight = false;
		return true;
	}

	/** Last worker error message, surfaced by /om:status. */
	lastWorkerError: string | undefined;

	/**
	 * Whether the last compaction waited for in-flight observers or skipped the wait (fast path:
	 * no in-flight observer could affect the rendered block). Surfaced by /om:status.
	 */
	lastCompactionObserverWait: "skipped" | "waited" | undefined;

	readonly status = new StatusController();

	// ── Toast coalescer ──────────────────────────────────────────────────────────
	// Parallel observers fire finish toasts from independent async tasks. If two
	// land in the same event-loop tick, pi's showStatus() would replace the first
	// with the second. queueToast() accumulates info lines and flushes them as a
	// single multi-line notify on the next tick so both lines remain visible.

	private pendingInfoToastLines: string[] = [];
	private infoToastFlushTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Queue an info-level toast line for batched delivery on the next event-loop tick.
	 * Non-info levels (warning/error) bypass the queue and fire immediately so they
	 * always use their own styling and are never merged with info lines.
	 */
	queueToast(
		line: string,
		level: "info" | "warning" | "error",
		notify: (message: string, level: "info" | "warning" | "error") => void,
	): void {
		if (level !== "info") {
			notify(line, level);
			return;
		}
		this.pendingInfoToastLines.push(line);
		if (this.infoToastFlushTimer !== undefined) return;
		this.infoToastFlushTimer = setTimeout(() => {
			this.infoToastFlushTimer = undefined;
			const lines = this.pendingInfoToastLines.splice(0);
			if (lines.length > 0) notify(lines.join("\n"), "info");
		}, 0);
		this.infoToastFlushTimer.unref?.();
	}

	/** Discard any pending toast lines (called on session shutdown). */
	cancelPendingToasts(): void {
		if (this.infoToastFlushTimer !== undefined) {
			clearTimeout(this.infoToastFlushTimer);
			this.infoToastFlushTimer = undefined;
		}
		this.pendingInfoToastLines = [];
	}

	ensureConfig(cwd: string): void {
		if (this.configLoaded) return;
		this.config = loadConfig(cwd);
		this.configLoaded = true;
	}

	/** Recompute the live footer gauges (next-observer + pool + context) from the current branch. */
	refreshFooterGauges(branch: Entry[], contextTokens?: number | null): void {
		if (!this.enabled) return;
		const folded = foldLedger(branch);
		this.status.setGauges({
			nextValue: rawTokensSinceObservationCoverage(branch),
			nextMax: this.config.chunkTokens,
			poolValue: poolTokens(folded.activeObservations),
			poolMax: this.config.consolidateAtPoolTokens,
			ctxValue: contextTokens ?? 0,
			ctxMax: this.config.compactAtContextTokens,
		});
	}

	/**
	 * Recompute accumulated session cost for the footer from ALL entries (every branch), so the
	 * displayed spend never rolls back under /tree. Pass `getEntries()`, not `getBranch()`.
	 */
	refreshCost(allEntries: Entry[]): void {
		if (!this.enabled) return;
		const { costUsd, runs } = sumSessionCost(allEntries);
		this.status.setCost(costUsd, runs);
	}

	/** Invalidate publication, then cancel workers without releasing their owned slots. */
	abortAllWorkers(): void {
		this.generation++;
		this.cancelPendingToasts();
		for (const { controller } of this.observersInFlight.values()) {
			controller.abort();
		}
		this.consolidatorController?.abort();
		// Owners retain their slots until their processes close, including after cancellation.
	}

	/** Track an observer task for the lifetime of its async run. */
	trackObserverTask(task: Promise<void>): void {
		this.observerTasks.add(task);
		void task.finally(() => this.observerTasks.delete(task));
	}

	async whenWorkersIdle(): Promise<void> {
		await Promise.allSettled([...this.observerTasks, ...(this.consolidatorTask ? [this.consolidatorTask] : [])]);
	}

	/** Resolve once no observer tasks are in flight (compaction blocks on this). */
	async whenObserversIdle(signal?: AbortSignal): Promise<void> {
		while (this.observerTasks.size > 0 && !signal?.aborted) {
			let onAbort: (() => void) | undefined;
			try {
				await Promise.race([
					Promise.allSettled([...this.observerTasks]),
					new Promise<void>(resolve => { onAbort = () => resolve(); signal?.addEventListener("abort", onAbort, { once: true }); }),
				]);
			} finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
		}
	}

	get observerSlotsAvailable(): number {
		return Math.max(0, this.config.observerConcurrency - this.observersInFlight.size);
	}
}

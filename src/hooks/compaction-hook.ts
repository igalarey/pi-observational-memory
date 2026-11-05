import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderMemoryMap } from "../memory/index-render.js";
import { listTopics, readJourney } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";
import { verifyReceipts } from "../memory/receipt.js";
import {
	buildCompactionProjection,
	contiguousCoverageIndex,
	OM_OBSERVATIONS_DROPPED,
	entryIndexById,
	isObservationsRecordedEntry,
	isObservationsDroppedEntry,
	isSourceEntry,
	isValidCutPoint,
	rawTokensAfterIndex,
	renderSummary,
	type Entry,
} from "../ledger/index.js";

function usableTombstones(branch: Entry[], runtime: Runtime): Set<string> {
	const dropped = new Set<string>();
	if (!runtime.sessionId || !runtime.branchId) return dropped;
	for (const entry of branch) {
		if (!isObservationsDroppedEntry(entry)) continue;
		const data = entry.data;
		if (data.sessionId !== runtime.sessionId || data.scopeId !== runtime.branchId || !Array.isArray(data.receipts)) continue;
		const declared = new Set(data.observationTimestamps);
		for (const receipt of data.receipts) {
			try {
				const [verified] = verifyReceipts(runtime.memoryRoot, [receipt]);
				if (declared.has(verified.timestamp)) dropped.add(verified.timestamp);
			} catch {
				// Recover only this observation when its persisted representation cannot be verified.
			}
		}
	}
	return dropped;
}

/** Distinct, branch-resolved coversUpToId indices of committed observation chunks, ascending. */
function chunkBoundaryIndices(branch: Entry[]): number[] {
	const indexes = entryIndexById(branch);
	const set = new Set<number>();
	const contiguous = contiguousCoverageIndex(branch);
	for (const entry of branch) {
		if (!isObservationsRecordedEntry(entry)) continue;
		const idx = indexes.get(entry.data.coversUpToId);
		if (idx !== undefined && idx <= contiguous) set.add(idx);
	}
	return Array.from(set).sort((a, b) => a - b);
}

/** First source entry after `boundaryIndex` that is a valid cut point, or undefined. */
function firstKeptAfterBoundary(branch: Entry[], boundaryIndex: number): Entry | undefined {
	for (let i = boundaryIndex + 1; i < branch.length; i++) {
		if (!isSourceEntry(branch[i])) continue;
		return isValidCutPoint(branch[i]) ? branch[i] : undefined;
	}
	return undefined;
}

/**
 * Snap pi's proposed `firstKeptEntryId` to an observation chunk boundary so the verbatim tail
 * starts exactly where a chunk ends — no chunk straddles the cutoff, so nothing is both
 * rendered into the summary and kept verbatim (and nothing is lost). Among boundaries whose
 * next entry is a valid cut point, pick the one whose resulting tail is closest to
 * `tailTokens`. Falls back to pi's proposal when no boundary qualifies (`tail` undefined).
 */
export function snapCutoff(
	branch: Entry[],
	proposedFirstKeptId: string,
	tailTokens: number,
): { firstKeptId: string; tail: number | undefined } {
	const boundaries = chunkBoundaryIndices(branch);
	let bestId: string | undefined;
	let bestTail: number | undefined;
	let bestDelta = Number.POSITIVE_INFINITY;

	for (const boundaryIndex of boundaries) {
		const firstKept = firstKeptAfterBoundary(branch, boundaryIndex);
		if (!firstKept) continue;
		const tail = rawTokensAfterIndex(branch, boundaryIndex);
		const delta = Math.abs(tail - tailTokens);
		if (delta < bestDelta) {
			bestDelta = delta;
			bestId = firstKept.id;
			bestTail = tail;
		}
	}

	return bestId ? { firstKeptId: bestId, tail: bestTail } : { firstKeptId: proposedFirstKeptId, tail: undefined };
}

export function snapFirstKeptEntryId(branch: Entry[], proposedFirstKeptId: string, tailTokens: number): string {
	return snapCutoff(branch, proposedFirstKeptId, tailTokens).firstKeptId;
}

/**
 * Fast-path test: can compaction skip waiting for in-flight observers entirely?
 *
 * The wait exists so just-committed observations are folded before rendering. But an observer
 * only affects the rendered block if its chunk's `coversUpToId` lands at-or-before the cutoff
 * (the projection includes an `om.observations.recorded` entry iff its coverage index is
 * `< index(firstKeptId)` — see `buildCompactionProjection`'s `beforeEntry` boundary). Observers
 * working a chunk in the verbatim tail are excluded regardless, so waiting for them is dead time.
 *
 * Two conditions must hold for a truly no-op skip (identical block AND identical cutoff):
 *  1. No in-flight observer has `coversUpToId` strictly before the cutoff entry (none can enter
 *     the projection). Unresolved ids are treated conservatively as "before" → wait.
 *  2. The snapped cutoff's tail is already `<= tailTokens`. Then committing the (tail-region)
 *     skipped observers can only produce SMALLER tails (further from target), so the snap is
 *     provably stable. If the tail is `> tailTokens` (nothing committed near the tip), a
 *     just-committed tail boundary could become a better snap target — so we wait, which also
 *     yields a tighter tail.
 */
export function canSkipObserverWait(
	branch: Entry[],
	snappedFirstKeptId: string,
	snappedTail: number | undefined,
	tailTokens: number,
	observersInFlight: Iterable<{ coversUpToId: string }>,
): boolean {
	// Condition 2: snap is only stable under skipped observers when its tail is already <= target.
	if (snappedTail === undefined || snappedTail > tailTokens) return false;

	const indexes = entryIndexById(branch);
	const cutoffIndex = indexes.get(snappedFirstKeptId);
	if (cutoffIndex === undefined) return false; // can't reason about the boundary → wait

	// Condition 1: every in-flight observer must cover a chunk that ends at-or-after the cutoff.
	for (const { coversUpToId } of observersInFlight) {
		const idx = indexes.get(coversUpToId);
		if (idx === undefined || idx < cutoffIndex) return false;
	}
	return true;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		if (!runtime.enabled || runtime.config.passive) return undefined;

		const hasUI = ctx.hasUI;
		if (runtime.compactHookInFlight) {
			if (hasUI) ctx.ui.notify("om: another compaction is already in progress; cancelling duplicate", "warning");
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		const token = runtime.captureToken();
		try {
			runtime.ensureConfig(ctx.cwd);
			const tailTokens = runtime.config.tailTokens;
			const { firstKeptEntryId, tokensBefore } = event.preparation;

			// Compute the snap from the CURRENT (pre-wait) branch. The snap only reads committed
			// chunk boundaries (fixed at hook entry), so this is safe to do before any wait and lets
			// us decide whether the wait is needed at all.
			let branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? (event.branchEntries as Entry[]);
			let snap = snapCutoff(branch, firstKeptEntryId, tailTokens);

			// R5 fast path: skip the wait when no in-flight observer can affect this compaction
			// (its chunk lands in the verbatim tail and the snap is stable). Otherwise wait for
			// observers to settle, then re-read the branch and recompute the snap so just-committed
			// `om.observations.recorded` entries are folded (pi's `event.branchEntries` is stale).
			const skip = canSkipObserverWait(branch, snap.firstKeptId, snap.tail, tailTokens, runtime.observersInFlight.values());
			runtime.lastCompactionObserverWait = skip ? "skipped" : "waited";
			if (!skip) {
				if (hasUI) ctx.ui.notify("om: waiting for in-flight observers before folding…", "info");
				await runtime.whenObserversIdle(event.signal);
				branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? (event.branchEntries as Entry[]);
				snap = snapCutoff(branch, firstKeptEntryId, tailTokens);
			}

			if (!runtime.isCurrent(token) || event.signal?.aborted) return { cancel: true };
			if (snap.tail === undefined) return undefined;
			const snapped = snap.firstKeptId;
			const projection = buildCompactionProjection(branch.filter(entry => entry.customType !== OM_OBSERVATIONS_DROPPED), snapped);
			const dropped = usableTombstones(branch, runtime);
			projection.observations = projection.observations.filter(observation => !dropped.has(observation.timestamp));
			projection.details.observations = projection.observations;
			// Phase B: render the long-term tier live from disk, regenerated each compaction
			// (throwaway projections — cannot decay). The journey is the running descriptive history
			// the consolidator maintains; the map is the topic-file index.
			const journey = readJourney(runtime.memoryRoot);
			const map = renderMemoryMap(listTopics(runtime.memoryRoot));
			const summary = renderSummary(journey, map, projection.observations) || "The covered conversation prefix was reviewed and contained no retained observations.";
			const window = ctx.model?.contextWindow;
			const contextLimit = typeof window === "number" && Number.isFinite(window) && window > 0
				? Math.min(window, runtime.config.compactAtContextTokens) : runtime.config.compactAtContextTokens;
			const configuredReserve = event.preparation.settings?.reserveTokens;
			const reserve = typeof configuredReserve === "number" && Number.isFinite(configuredReserve)
				? Math.max(4096, configuredReserve) : 4096;
			const budget = Math.min(
				4 * (runtime.config.poolTargetTokens + runtime.config.journeyTargetTokens + 2048),
				contextLimit - snap.tail - reserve,
			);
			// The pool-based byte cap bounds growth; context headroom uses the stricter one-byte-per-token bound.
			if (Buffer.byteLength(summary, "utf8") > budget) return undefined;

			return {
				compaction: {
					summary,
					firstKeptEntryId: snapped,
					tokensBefore,
					details: projection.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}

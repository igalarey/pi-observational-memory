import { describe, expect, it } from "vitest";
import { buildCompactionProjection, renderSummary } from "../src/ledger/index.js";
import { canSkipObserverWait, snapCutoff, snapFirstKeptEntryId } from "../src/hooks/compaction-hook.js";
import { observation, observationsRecordedEntry, rawMessage, toolResultMessage } from "./fixtures/session.js";

const body = "x".repeat(40);
function chunk(id: string, sourceEntryIds: string[], content = id) {
	return observationsRecordedEntry(id, {
		observations: [observation(id, { content })], coversUpToId: sourceEntryIds.at(-1)!,
		coverageVersion: 2, sourceEntryIds,
	});
}
function twoChunks() {
	return [
		rawMessage("raw-1", body), rawMessage("raw-2", body), chunk("om-1", ["raw-1", "raw-2"], "early"),
		rawMessage("raw-3", body), rawMessage("raw-4", body), chunk("om-2", ["raw-3", "raw-4"], "late"),
		rawMessage("raw-5", body), rawMessage("raw-6", body),
	];
}

describe("snapFirstKeptEntryId", () => {
	it("snaps to the chunk boundary whose tail is closest to tailTokens", () => {
		const branch = twoChunks();
		expect(snapFirstKeptEntryId(branch, "raw-6", 25)).toBe("raw-5");
		expect(snapFirstKeptEntryId(branch, "raw-6", 40)).toBe("raw-3");
	});
	it("skips a boundary whose next entry is not a valid cut point (tool result)", () => {
		const branch = [
			rawMessage("raw-1", body), rawMessage("raw-2", body), chunk("om-1", ["raw-1", "raw-2"]),
			toolResultMessage("tr-1", body), rawMessage("raw-3", body), chunk("om-2", ["tr-1", "raw-3"]), rawMessage("raw-4", body),
		];
		expect(snapFirstKeptEntryId(branch, "raw-4", 5)).toBe("raw-4");
	});
	it("leaves an unsafe proposal marked without a qualifying boundary", () => {
		const branch = [rawMessage("raw-1", body), rawMessage("raw-2", body)];
		expect(snapCutoff(branch, "raw-2", 5)).toEqual({ firstKeptId: "raw-2", tail: undefined });
	});
});

describe("canSkipObserverWait (R5 fast path)", () => {
	const branch = twoChunks();
	const snap = snapCutoff(branch, "raw-6", 20);
	it("skips when there are no in-flight observers and the tail is at/under target", () => {
		expect(snap.firstKeptId).toBe("raw-5");
		expect(snap.tail).toBe(20);
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [])).toBe(true);
	});
	it("skips when every in-flight observer covers a chunk in the verbatim tail", () => {
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [{ coversUpToId: "raw-6" }])).toBe(true);
	});
	it("waits when an in-flight observer covers a chunk before the cutoff", () => {
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [{ coversUpToId: "raw-2" }])).toBe(false);
	});
	it("waits when the in-flight observer's coversUpToId does not resolve", () => {
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [{ coversUpToId: "ghost" }])).toBe(false);
	});
	it("waits when the snapped tail exceeds tailTokens", () => {
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 5, [])).toBe(false);
	});
	it("waits when no qualifying boundary exists", () => {
		const bare = [rawMessage("raw-1", body), rawMessage("raw-2", body)];
		const fallback = snapCutoff(bare, "raw-2", 5);
		expect(fallback.tail).toBeUndefined();
		expect(canSkipObserverWait(bare, fallback.firstKeptId, fallback.tail, 5, [])).toBe(false);
	});
});

describe("cutoff and projection integration", () => {
	it("renders exactly the observations whose source precedes the snapped cutoff", () => {
		const branch = twoChunks();
		const snapped = snapFirstKeptEntryId(branch, "raw-6", 20);
		expect(snapped).toBe("raw-5");
		const projection = buildCompactionProjection(branch, snapped);
		expect(projection.observations.map(o => o.content)).toEqual(["early", "late"]);
		const summary = renderSummary(undefined, undefined, projection.observations);
		expect(summary).toContain("om-1  early");
		expect(summary).toContain("om-2  late");
	});
});

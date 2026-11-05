import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Runtime } from "../src/runtime.js";
import { fileDigest } from "../src/memory/receipt.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { evaluateObserverTriggers } from "../src/hooks/observer-trigger.js";
import { evaluateConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { registerConsolidatorTools } from "../agent/consolidator/tools.js";
import { latestCoverageMarkerId, OM_OBSERVATIONS_RECORDED, type Entry } from "../src/ledger/index.js";
import * as launch from "../src/spawn/launch.js";
import { observation, rawMessage } from "./fixtures/session.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "om-review-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
function setup() {
 const runtime = new Runtime();
 runtime.memoryRoot = root; runtime.sessionId = "session"; runtime.branchId = "scope"; runtime.configLoaded = true;
 runtime.config = { ...runtime.config, chunkTokens: 10, observerConcurrency: 1, consolidateAtPoolTokens: 1, poolTargetTokens: 1 };
 const branch: Entry[] = [rawMessage("a", "a".repeat(40)), rawMessage("tail", "tail")];
 const pi = { appendEntry(type: string, data: unknown) { branch.push({ type: "custom", id: `ledger-${branch.length}`, customType: type, data }); } } as any;
 const ctx = { hasUI: false, cwd: root, sessionManager: { getBranch: () => branch, getEntries: () => branch } };
 let hook: any;
 registerCompactionHook({ on: (_: string, handler: any) => { hook = handler; } } as any, runtime);
 const compact = (extra = {}) => hook({ preparation: { firstKeptEntryId: "tail", tokensBefore: 50000 }, branchEntries: branch }, { ...ctx, ...extra });
 return { runtime, branch, pi, ctx, compact };
}
it.each(["valid", "missing", "changed", "other-scope", "other-session"])("production compaction applies only usable scoped receipts: %s", async state => {
 const h = setup();
 h.pi.appendEntry(OM_OBSERVATIONS_RECORDED, { coverageVersion: 2, sourceEntryIds: ["a"], coversUpToId: "a", observations: [
  observation("T", { content: "OLD_OBSERVATION", tokenCount: 100 }), observation("Z", { content: "KEPT_OBSERVATION", tokenCount: 100 }),
 ] });
 vi.spyOn(launch, "spawnWorker").mockImplementation(async opts => {
  const tools = new Map<string, any>();
  registerConsolidatorTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, opts.env.OM_MEMORY_DIR!, opts.env.OM_RESULT_PATH);
  await tools.get("write").execute("w", { path: "topic.md", content: "OLD_OBSERVATION" });
  await tools.get("report_consolidation").execute("r", { receipts: [{ timestamp: "T", path: "topic.md", quote: "OLD_OBSERVATION" }] });
  return { code: 0, signal: null, stderr: "" };
 });
 evaluateConsolidatorTrigger(h.pi, h.runtime, h.ctx); await h.runtime.consolidatorTask;
 expect(h.branch.some(entry => entry.customType === "om.observations.dropped")).toBe(true);
 if (state === "missing") rmSync(join(root, "topic.md"));
 if (state === "changed") writeFileSync(join(root, "topic.md"), "Changed durable representation");
 if (state === "other-scope") h.runtime.branchId = "historical-scope";
 if (state === "other-session") h.runtime.sessionId = "fork";
 const result = await h.compact();
 expect(result?.compaction).toBeDefined();
 expect(result.compaction.summary).toContain("KEPT_OBSERVATION");
 if (state === "valid") {
  expect(result.compaction.summary).not.toContain("OLD_OBSERVATION");
  expect(result.compaction.details.observations.map((o: any) => o.timestamp)).toEqual(["Z"]);
 } else expect(result.compaction.summary).toContain("OLD_OBSERVATION");
});
it("a mixed receipt batch recovers only unavailable representations and honors explicit discard", async () => {
 const h = setup();
 h.pi.appendEntry(OM_OBSERVATIONS_RECORDED, { coverageVersion: 2, sourceEntryIds: ["a"], coversUpToId: "a", observations: [
  observation("T", { content: "PERSISTED" }), observation("U", { content: "RECOVER_ME" }), observation("N", { content: "NOISE" }),
 ] });
 writeFileSync(join(root, "topic.md"), "PERSISTED");
 h.pi.appendEntry("om.observations.dropped", { sessionId: "session", scopeId: "scope", observationTimestamps: ["T", "U", "N"], coversUpToId: "tail", receipts: [
  { timestamp: "T", path: "topic.md", quote: "PERSISTED", sha256: fileDigest("PERSISTED") },
  { timestamp: "U", path: "missing.md", quote: "RECOVER_ME", sha256: fileDigest("RECOVER_ME") },
  { timestamp: "N", discardReason: "Repeated greeting" },
 ] });
 const result = await h.compact();
 expect(result.compaction.details.observations.map((o: any) => o.timestamp)).toEqual(["U"]);
 expect(result.compaction.summary).toContain("RECOVER_ME");
 expect(result.compaction.summary).not.toContain("NOISE");
});
it("historical recovery delegates to native compaction rather than emitting an oversized or truncated summary", async () => {
 const h = setup();
 h.pi.appendEntry(OM_OBSERVATIONS_RECORDED, { coverageVersion: 2, sourceEntryIds: ["a"], coversUpToId: "a", observations: [observation("T", { content: "OLD_FACT ".repeat(20000), tokenCount: 40000 })] });
 h.pi.appendEntry("om.observations.dropped", { observationTimestamps: ["T"], coversUpToId: "a" });
 expect(await h.compact()).toBeUndefined();
 expect(h.runtime.compactHookInFlight).toBe(false);
});
it("a small model context also forces native fallback without dropping recovered observations", async () => {
 const h = setup();
 h.pi.appendEntry(OM_OBSERVATIONS_RECORDED, { coverageVersion: 2, sourceEntryIds: ["a"], coversUpToId: "a", observations: [observation("T", { content: "FACT".repeat(1000), tokenCount: 1000 })] });
 expect(await h.compact({ model: { contextWindow: 2048 } })).toBeUndefined();
});
it("synchronous launch failure attempts a range once per evaluation and retries on the next event", async () => {
 const h = setup(); h.branch.splice(1);
 const spawn = vi.spyOn(launch, "spawnWorker").mockImplementationOnce(() => { throw new Error("Synthetic synchronous path failure"); }).mockImplementation(async opts => {
  mkdirSync(join(root, ".runs"), { recursive: true }); writeFileSync(opts.env.OM_RESULT_PATH!, JSON.stringify({ observations: [] }));
  return { code: 0, signal: null, stderr: "" };
 });
 evaluateObserverTriggers(h.pi, h.runtime, h.ctx);
 await h.runtime.whenObserversIdle();
 expect(spawn).toHaveBeenCalledTimes(1);
 expect(latestCoverageMarkerId(h.branch, OM_OBSERVATIONS_RECORDED)).toBeUndefined();
 evaluateObserverTriggers(h.pi, h.runtime, h.ctx);
 await h.runtime.whenObserversIdle();
 expect(spawn).toHaveBeenCalledTimes(2);
 expect(latestCoverageMarkerId(h.branch, OM_OBSERVATIONS_RECORDED)).toBe("a");
});
it("invalidation during a synchronous launch failure stops the remaining dispatch attempts", async () => {
 const h = setup(); h.runtime.config.observerConcurrency = 2;
 h.branch.splice(1, 1, rawMessage("b", "b".repeat(40)));
 let attempts = 0;
 const spawn = vi.spyOn(launch, "spawnWorker").mockImplementation(() => {
  attempts++;
  if (attempts === 1) { h.runtime.abortAllWorkers(); throw new Error("Cancelled launch"); }
  return Promise.resolve({ code: 1, signal: null, stderr: "" });
 });
 evaluateObserverTriggers(h.pi, h.runtime, h.ctx);
 await h.runtime.whenObserversIdle();
 expect(spawn).toHaveBeenCalledTimes(1);
 expect(h.branch.filter(entry => entry.customType === OM_OBSERVATIONS_RECORDED)).toEqual([]);
});

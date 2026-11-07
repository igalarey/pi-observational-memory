import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig, DEFAULTS } from "../src/config.js";
import { Runtime } from "../src/runtime.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { evaluateObserverTriggers } from "../src/hooks/observer-trigger.js";
import { evaluateConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { latestCoverageMarkerId, OM_OBSERVATIONS_RECORDED } from "../src/ledger/index.js";
import { serializeBranchEntries } from "../src/ledger/serialize.js";
import { registerConsolidatorTools } from "../agent/consolidator/tools.js";
import * as launch from "../src/spawn/launch.js";
import { ensureSessionMemory } from "../src/memory/session.js";
import { atomicWrite } from "../src/memory/paths.js";
import * as runs from "../src/spawn/runs.js";
import { rawMessage, observation, observationsRecordedEntry } from "./fixtures/session.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "om-integrity-")); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function harness() {
 const runtime = new Runtime();
 runtime.memoryRoot = root;
 runtime.configLoaded = true;
 runtime.config = { ...DEFAULTS, chunkTokens: 10, observerConcurrency: 2, consolidateAtPoolTokens: 1, poolTargetTokens: 1 };
 const branch: any[] = [rawMessage("a", "a".repeat(40)), rawMessage("b", "b".repeat(40)), rawMessage("c", "c".repeat(40))];
 const appendEntry = vi.fn((customType, data) => branch.push({ type: "custom", id: `ledger-${branch.length}`, customType, data }));
 const pi = { appendEntry } as any;
 const ctx = { hasUI: false, cwd: root, sessionManager: { getBranch: () => branch, getEntries: () => branch } };
 return { runtime, branch, pi, ctx, appendEntry };
}
function completion(id: string, ids: string[], observations: any[] = []) {
 return { type: "custom", id, customType: OM_OBSERVATIONS_RECORDED, data: { observations, coversUpToId: ids.at(-1), sourceEntryIds: ids, coverageVersion: 2 } };
}
it("does not compact an uncovered prefix, even with unrelated durable memory", async () => {
 const h = harness();
 atomicWrite(join(root, "JOURNEY.md"), "Unrelated prior facts");
 let hook: any;
 registerCompactionHook({ on: (_: string, fn: any) => { hook = fn; } } as any, h.runtime);
 const result = await hook({ preparation: { firstKeptEntryId: "c", tokensBefore: 100 }, branchEntries: h.branch }, h.ctx);
 expect(result?.compaction).toBeUndefined();
});
it("coverage is contiguous, accepts explicit empty completions, and rejects ambiguous legacy ranges", () => {
 const { branch } = harness();
 branch.push(completion("B", ["b"], [observation("B")]));
 expect(latestCoverageMarkerId(branch, OM_OBSERVATIONS_RECORDED)).toBeUndefined();
 branch.push(completion("A", ["a"]));
 expect(latestCoverageMarkerId(branch, OM_OBSERVATIONS_RECORDED)).toBe("b");
 branch.push(observationsRecordedEntry("legacy", { coversUpToId: "c", observations: [observation("C")] }));
 expect(latestCoverageMarkerId(branch, OM_OBSERVATIONS_RECORDED)).toBe("b");
});
it("failed earlier observers are retried after later completion, including empty results", async () => {
 const h = harness();
 const calls: any[] = [];
 vi.spyOn(launch, "spawnWorker").mockImplementation((opts) => new Promise(resolve => calls.push({ opts, resolve })));
 evaluateObserverTriggers(h.pi, h.runtime, h.ctx);
 expect(calls).toHaveLength(2);
 mkdirSync(join(root, ".runs"), { recursive: true });
 writeFileSync(calls[1].opts.env.OM_RESULT_PATH, JSON.stringify({ observations: [] }));
 calls[1].resolve({ code: 0, signal: null, stderr: "" });
 calls[0].resolve({ code: 1, signal: null, stderr: "" });
 await h.runtime.whenObserversIdle();
 expect(latestCoverageMarkerId(h.branch, OM_OBSERVATIONS_RECORDED)).toBeUndefined();
 evaluateObserverTriggers(h.pi, h.runtime, h.ctx);
 expect(calls[2].opts.input).toContain("Source entry id: a");
 for (const call of calls.slice(2)) call.resolve({ code: 1, signal: null, stderr: "" });
 await h.runtime.whenObserversIdle();
});
it("exit zero without a receipt never tombstones observations", async () => {
 const h = harness();
 h.branch.push(observationsRecordedEntry("obs", { observations: [observation("T", { tokenCount: 100 }), observation("Z", { tokenCount: 100 })], coversUpToId: "a" }));
 vi.spyOn(launch, "spawnWorker").mockResolvedValue({ code: 0, signal: null, stderr: "" });
 evaluateConsolidatorTrigger(h.pi, h.runtime, h.ctx);
 await vi.waitFor(() => expect(h.runtime.consolidatorInFlight).toBe(false));
 expect(launch.spawnWorker).toHaveBeenCalledTimes(1);
 expect(h.appendEntry.mock.calls.some(([type]) => type === "om.observations.dropped")).toBe(false);
});
it("cancellation holds consolidator ownership until close and rejects late observer output", async () => {
 const h = harness();
 let close: any;
 vi.spyOn(launch, "spawnWorker").mockImplementation(() => new Promise(resolve => { close = resolve; }));
 h.branch.push(observationsRecordedEntry("obs", { observations: [observation("T", { tokenCount: 100 }), observation("Z", { tokenCount: 100 })], coversUpToId: "a" }));
 evaluateConsolidatorTrigger(h.pi, h.runtime, h.ctx);
 h.runtime.abortAllWorkers();
 expect(h.runtime.consolidatorInFlight).toBe(true);
 evaluateConsolidatorTrigger(h.pi, h.runtime, h.ctx);
 expect(launch.spawnWorker).toHaveBeenCalledTimes(1);
 close({ code: 0, signal: null, stderr: "" });
 await vi.waitFor(() => expect(h.runtime.consolidatorInFlight).toBe(false));
 expect(h.appendEntry).not.toHaveBeenCalled();
});
it.each([false, true])("only verified receipts permit publication and tombstones (tampered=%s)", async (tampered) => {
 const h = harness();
 h.branch.push(observationsRecordedEntry("obs", { observations: [observation("T", { tokenCount: 100 }), observation("Z", { tokenCount: 100 })], coversUpToId: "a" }));
 vi.spyOn(launch, "spawnWorker").mockImplementation(async opts => {
  const tools = new Map<string, any>();
  (registerConsolidatorTools as any)({ registerTool: (tool: any) => tools.set(tool.name, tool) }, opts.env.OM_MEMORY_DIR, opts.env.OM_RESULT_PATH, new Set(JSON.parse(readFileSync(opts.env.OM_BATCH_IDS_PATH!, "utf8"))));
  await tools.get("write").execute("write", { path: "topic.md", content: "Retained fact" });
  expect(existsSync(join(root, "topic.md"))).toBe(false);
  await tools.get("report_consolidation").execute("receipt", { receipts: [{ timestamp: "T", path: "topic.md", quote: "Retained fact" }] });
  if (tampered) writeFileSync(join(opts.env.OM_MEMORY_DIR!, "topic.md"), "Changed after receipt");
  return { code: 0, signal: null, stderr: "" };
 });
 evaluateConsolidatorTrigger(h.pi, h.runtime, h.ctx);
 await vi.waitFor(() => expect(h.runtime.consolidatorInFlight).toBe(false));
 const drops = h.appendEntry.mock.calls.filter(([type]) => type === "om.observations.dropped");
 expect(drops.length).toBe(tampered ? 0 : 1);
 if (!tampered) { expect(drops[0][1].observationTimestamps).toEqual(["T"]); expect(readFileSync(join(root, "topic.md"), "utf8")).toBe("Retained fact"); }
});
it("late observers cannot publish after lifecycle invalidation", async () => {
 const h = harness(); h.runtime.config.observerConcurrency = 1;
 let close: any, opts: any;
 vi.spyOn(launch, "spawnWorker").mockImplementation(o => { opts = o; return new Promise(resolve => { close = resolve; }); });
 evaluateObserverTriggers(h.pi, h.runtime, h.ctx);
 h.runtime.abortAllWorkers();
 mkdirSync(join(root, ".runs"), { recursive: true });
 writeFileSync(opts.env.OM_RESULT_PATH, JSON.stringify({ observations: [{ timestamp: "2026-01-01 10:00", content: "STALE" }] }));
 close({ code: 0, signal: null, stderr: "" });
 await h.runtime.whenObserversIdle(); expect(h.appendEntry).not.toHaveBeenCalled();
});
it("retention only removes known inactive IPC files", () => {
 const dir = join(root, ".runs"); mkdirSync(dir);
 for (let i = 0; i < 110; i++) writeFileSync(join(dir, `obs-20260101-1-${i}.result.json`), "{}");
 writeFileSync(join(dir, "user-notes.md"), "KEEP");
 (runs as any).pruneRuns(root, new Set(["obs-20260101-1-0"]), 10);
 expect(existsSync(join(dir, "obs-20260101-1-0.result.json"))).toBe(true);
 expect(readFileSync(join(dir, "user-notes.md"), "utf8")).toBe("KEEP");
 expect(readdirSync(dir).length).toBeLessThanOrEqual(12);
});
it("untrusted project models are ignored and trusted overrides inherit global fields", () => {
 const agent = join(root, "agent"); mkdirSync(agent);
 vi.stubEnv("PI_CODING_AGENT_DIR", agent);
 const models = { observer: { provider: "private", id: "one", thinking: "high" }, consolidator: { provider: "private", id: "two", thinking: "high" } };
 writeFileSync(join(agent, "settings.json"), JSON.stringify({ "observational-memory": { models } }));
 mkdirSync(join(root, ".pi"));
 writeFileSync(join(root, ".pi/settings.json"), JSON.stringify({ "observational-memory": { models: { observer: { id: "override" } } } }));
 expect(loadConfig(root, {}).models).toEqual(models);
 const runtime = new Runtime();
 runtime.ensureConfig(root, { isProjectTrusted: () => false });
 expect(runtime.config.models).toEqual(models);
 expect(loadConfig(root, {}, { allowProjectConfig: true }).models).toEqual({ ...models, observer: { ...models.observer, id: "override" } });
});
it.each([true, false])("accepts boolean showStatus=%s with a visible default", (showStatus) => {
 const agent = join(root, "agent"); mkdirSync(agent);
 vi.stubEnv("PI_CODING_AGENT_DIR", agent);
 expect(loadConfig(root, {})).toHaveProperty("showStatus", true);
 writeFileSync(join(agent, "settings.json"), JSON.stringify({ "observational-memory": { showStatus } }));
 expect(loadConfig(root, {})).toHaveProperty("showStatus", showStatus);
 mkdirSync(join(root, ".pi"));
 writeFileSync(join(root, ".pi/settings.json"), JSON.stringify({ "observational-memory": { showStatus: !showStatus } }));
 expect(loadConfig(root, {})).toHaveProperty("showStatus", showStatus);
 expect(loadConfig(root, {}, { allowProjectConfig: true })).toHaveProperty("showStatus", !showStatus);
});
it.each([undefined, null, "false", "true", 0, 1, [], {}])("ignores non-boolean showStatus=%j without losing the inherited value", (showStatus) => {
 const agent = join(root, "agent"); mkdirSync(agent);
 vi.stubEnv("PI_CODING_AGENT_DIR", agent);
 writeFileSync(join(agent, "settings.json"), JSON.stringify({ "observational-memory": { showStatus } }));
 expect(loadConfig(root, {})).toHaveProperty("showStatus", true);
 writeFileSync(join(agent, "settings.json"), JSON.stringify({ "observational-memory": { showStatus: false } }));
 mkdirSync(join(root, ".pi"));
 writeFileSync(join(root, ".pi/settings.json"), JSON.stringify({ "observational-memory": { showStatus } }));
 expect(loadConfig(root, {}, { allowProjectConfig: true })).toHaveProperty("showStatus", false);
});
it("rejects symlink components for every scoped operation and recursive grep", async () => {
 const memory = join(root, "memory"), outside = join(root, "outside"); mkdirSync(memory); mkdirSync(outside);
 writeFileSync(join(outside, "canary.md"), "CANARY"); symlinkSync(outside, join(memory, "bridge"));
 const tools = new Map<string, any>(); registerConsolidatorTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, memory);
 for (const name of ["read", "write", "edit", "grep"]) {
  const result = await tools.get(name).execute("test", { path: "bridge/canary.md", content: "BAD", oldText: "CANARY", newText: "BAD", pattern: "CANARY" });
  expect(result.details.error, name).toBe(true);
 }
 expect((await tools.get("grep").execute("test", { pattern: "CANARY" })).content[0].text).not.toContain("CANARY");
 expect(readFileSync(join(outside, "canary.md"), "utf8")).toBe("CANARY");
});
it("atomic writes do not follow preplanted temporaries", () => {
 vi.spyOn(Date, "now").mockReturnValue(1234);
 const path = join(root, "topic.md"), outside = join(root, "canary"); writeFileSync(outside, "SAFE");
 symlinkSync(outside, `${path}.tmp-${process.pid}-1234`);
 atomicWrite(path, "NEW");
 expect(readFileSync(outside, "utf8")).toBe("SAFE");
 expect(readFileSync(path, "utf8")).toBe("NEW");
});
it("does not seed future parent files into a historical fork", () => {
 mkdirSync(join(root, ".memory/parent"), { recursive: true }); writeFileSync(join(root, ".memory/parent/future.md"), "FUTURE");
 const parent = join(root, "synthetic-parent.jsonl"); writeFileSync(parent, JSON.stringify({ type: "session", id: "parent" }) + "\n");
 const child = ensureSessionMemory({ cwd: root, sessionManager: { getSessionId: () => "child", getHeader: () => ({ parentSession: parent }) } });
 expect(existsSync(join(child, "future.md"))).toBe(false);
});
it("omits thinking and redacts recognizable credentials before transport", () => {
 const entries = [rawMessage("a", "Authorization: Bearer synthetic-secret-value"), rawMessage("b", "", { message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_THOUGHT" }, { type: "toolCall", name: "request", arguments: { api_key: "synthetic-key-value" } }] } })];
 const text = serializeBranchEntries(entries);
 expect(text).not.toContain("PRIVATE_THOUGHT"); expect(text).not.toContain("synthetic-secret-value"); expect(text).not.toContain("synthetic-key-value");
});
it("escalates TERM ignoring workers and enforces a deadline without external model calls", async () => {
 const worker = join(root, "worker.cjs");
 writeFileSync(worker, 'process.on("SIGTERM",()=>{}); require("fs").writeFileSync("ready", String(process.pid)); setInterval(()=>{},1000);');
 const controller = new AbortController();
 const result = launch.spawnWorker({ argv: [process.execPath, worker], cwd: root, env: {}, signal: controller.signal, timeoutMs: 5000, killGraceMs: 50 } as any);
 await vi.waitFor(() => expect(existsSync(join(root, "ready"))).toBe(true));
 controller.abort();
 let timer: ReturnType<typeof setTimeout> | undefined;
 try {
  const exit = await Promise.race([result, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("worker did not close")), 4000); })]);
  expect(exit.signal).toBe("SIGKILL");
 } finally {
  clearTimeout(timer);
  try { process.kill(Number(readFileSync(join(root, "ready"), "utf8")), "SIGKILL"); } catch {}
  await result;
 }
}, 6000);

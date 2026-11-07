import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import omWorker from "../agent/index.js";
import { registerConsolidatorTools } from "../agent/consolidator/tools.js";
import { evaluateConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { Runtime } from "../src/runtime.js";
import { atomicWrite } from "../src/memory/paths.js";
import * as launch from "../src/spawn/launch.js";
import { observation, observationsRecordedEntry, rawMessage } from "./fixtures/session.js";

const exact = "2026-11-07T13:55:00";
const wrong = `${exact}.01`;
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "om-batch-")); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function toolsApi() {
 const tools = new Map<string, any>();
 return { tools, pi: { on: vi.fn(), registerTool: (tool: any) => tools.set(tool.name, tool) } as any };
}
function workerEnv(env: NodeJS.ProcessEnv) {
 for (const key of ["OM_WORKER", "OM_MEMORY_DIR", "OM_RESULT_PATH", "OM_BATCH_IDS_PATH"]) vi.stubEnv(key, env[key]);
}
function harness() {
 const runtime = new Runtime(); runtime.memoryRoot = root; runtime.configLoaded = true;
 runtime.config = { ...runtime.config, consolidateAtPoolTokens: 1, poolTargetTokens: 1 };
 const branch = [rawMessage("source", "Source"), observationsRecordedEntry("obs", { coversUpToId: "source", observations: [
  observation(exact, { tokenCount: 100 }), observation("2026-11-07T13:56:00", { tokenCount: 100 }), observation("2026-11-07T13:57:00", { tokenCount: 100 }),
 ] })];
 const pi = { appendEntry: vi.fn() } as any;
 const ctx = { hasUI: false, sessionManager: { getBranch: () => branch, getEntries: () => branch } };
 return { runtime, pi, ctx };
}

it.each([false, true])("rejects an outside ID before writing a result, then accepts exact retry (discard=%s)", async discard => {
 const { tools, pi } = toolsApi(); const result = join(root, "result.json");
 registerConsolidatorTools(pi, join(root, "stage"), result, new Set([exact, "another-id"]));
 await tools.get("write").execute("w", { path: "topic.md", content: "Retained fact" });
 const receipt = discard ? { discardReason: "Duplicate" } : { path: "topic.md", quote: "Retained fact" };
 await expect(tools.get("report_consolidation").execute("bad", { receipts: [{ timestamp: wrong, ...receipt }] }))
  .rejects.toThrow(`${wrong}`);
 expect(existsSync(result)).toBe(false);
 await expect(tools.get("report_consolidation").execute("bad2", { receipts: [{ timestamp: wrong, ...receipt }] }))
  .rejects.toThrow(/copy exact IDs from supplied observations/i);
 await tools.get("report_consolidation").execute("retry", { receipts: [{ timestamp: exact, ...receipt }] });
 expect(JSON.parse(readFileSync(result, "utf8")).receipts.map((r: any) => r.timestamp)).toEqual([exact]);
});

it("fails closed when direct report registration has no allowed IDs", () => {
 const { pi, tools } = toolsApi();
 expect(() => registerConsolidatorTools(pi, root, join(root, "result.json"))).toThrow(/batch|allowed/i);
 expect(tools.has("report_consolidation")).toBe(false);
});

it.each([undefined, "missing", "not-json", "{}", '[1]', '[""]'])("fails closed before registering report with invalid manifest %s", manifest => {
 const { pi, tools } = toolsApi(); const path = join(root, "batch.json");
 workerEnv({ OM_WORKER: "consolidator", OM_MEMORY_DIR: root, OM_RESULT_PATH: join(root, "result.json"), OM_BATCH_IDS_PATH: manifest === undefined ? undefined : path });
 if (manifest !== undefined && manifest !== "missing") writeFileSync(path, manifest);
 expect(() => omWorker(pi)).toThrow();
 expect(tools.has("report_consolidation")).toBe(false);
 expect(existsSync(join(root, "result.json"))).toBe(false);
});

it("passes trusted IDs outside staging, rejects tampering, and publishes an exact partial retry through the orchestrator", async () => {
 const h = harness(); let manifest!: string; let staging!: string; let workerFinished = false;
 vi.spyOn(launch, "spawnWorker").mockImplementation(async opts => {
  manifest = opts.env.OM_BATCH_IDS_PATH!; staging = opts.env.OM_MEMORY_DIR!;
  expect(manifest).toBeTruthy(); expect(dirname(manifest)).toBe(join(root, ".runs"));
  expect(relative(staging, manifest).startsWith("..")).toBe(true);
  expect(JSON.parse(readFileSync(manifest, "utf8"))).toEqual([exact, "2026-11-07T13:56:00"]);
  workerEnv(opts.env); const { pi, tools } = toolsApi(); omWorker(pi);
  for (const name of ["write", "edit"]) {
   const denied = await tools.get(name).execute("tamper", { path: manifest, content: "[]", oldText: exact, newText: wrong });
   expect(denied.details.error).toBe(true);
  }
  await tools.get("write").execute("w", { path: "topic.md", content: "Retained fact" });
  await expect(tools.get("report_consolidation").execute("bad", { receipts: [{ timestamp: wrong, discardReason: "Duplicate" }] })).rejects.toThrow(wrong);
  expect(existsSync(opts.env.OM_RESULT_PATH!)).toBe(false);
  await tools.get("report_consolidation").execute("retry", { receipts: [{ timestamp: exact, path: "topic.md", quote: "Retained fact" }] });
  workerFinished = true; return { code: 0, signal: null, stderr: "" };
 });
 evaluateConsolidatorTrigger(h.pi, h.runtime, h.ctx); await h.runtime.consolidatorTask;
 expect(workerFinished, h.runtime.lastWorkerError).toBe(true);
 expect(h.runtime.lastWorkerError).toBeUndefined();
 expect(readFileSync(join(root, "topic.md"), "utf8")).toBe("Retained fact");
 expect(h.pi.appendEntry).toHaveBeenCalledWith("om.observations.dropped", expect.objectContaining({ observationTimestamps: [exact] }));
 expect(existsSync(manifest)).toBe(false); expect(existsSync(staging)).toBe(false);
});

it.each(["bypass", "failure", "cancel"])("keeps parent guard and cleans manifest/staging on %s", async mode => {
 const h = harness(); let manifest!: string; let staging!: string;
 vi.spyOn(launch, "spawnWorker").mockImplementation(async opts => {
  manifest = opts.env.OM_BATCH_IDS_PATH!; staging = opts.env.OM_MEMORY_DIR!;
  if (mode === "cancel") h.runtime.abortAllWorkers();
  atomicWrite(opts.env.OM_RESULT_PATH!, JSON.stringify({ receipts: [{ timestamp: wrong, discardReason: "Bypassed worker tool" }] }));
  return { code: mode === "failure" ? 1 : 0, signal: null, stderr: "" };
 });
 evaluateConsolidatorTrigger(h.pi, h.runtime, h.ctx); await h.runtime.consolidatorTask;
 if (mode === "bypass") expect(h.runtime.lastWorkerError).toBe("Receipt outside handed batch");
 expect(h.pi.appendEntry).not.toHaveBeenCalled();
 expect(manifest).toBeTruthy(); expect(existsSync(manifest)).toBe(false); expect(existsSync(staging)).toBe(false);
});

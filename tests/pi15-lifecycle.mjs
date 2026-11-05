import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const host = process.env.PI_OM_TEST_HOST;
assert.ok(host, "Set PI_OM_TEST_HOST to the installed Pi 1.5 package directory");
const fixture = mkdtempSync(join(tmpdir(), "om-pi15-"));
process.env.HOME = fixture;
process.env.PI_CODING_AGENT_DIR = join(fixture, "agent");
process.env.XDG_CONFIG_HOME = join(fixture, "config");
process.env.XDG_CACHE_HOME = join(fixture, "cache");
mkdirSync(process.env.PI_CODING_AGENT_DIR);
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ "observational-memory": { models: {
 observer: { provider: "synthetic", id: "observer" }, consolidator: { provider: "synthetic", id: "consolidator" },
} } }));
const source = resolve(import.meta.dirname, "..");
let checks = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
try {
 const { loadExtensions } = await import(pathToFileURL(join(host, "dist/core/extensions/loader.js")));
 const { ExtensionRunner } = await import(pathToFileURL(join(host, "dist/core/extensions/runner.js")));
 const { SessionManager } = await import(pathToFileURL(join(host, "dist/core/session-manager.js")));
 const loaded = await loadExtensions([join(source, "src/index.ts")], fixture);
 check(loaded.errors, []);
 const sm = SessionManager.inMemory(fixture);
 const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, fixture, sm, {});
 const errors = []; runner.onError(error => errors.push(error));
 runner.bindCore({ appendEntry: (type, data) => sm.appendCustomEntry(type, data), getThinkingLevel: () => "off" }, {
  getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true,
  getSignal: () => undefined, abort() {}, hasPendingMessages: () => false, shutdown() {},
  getContextUsage: () => undefined, compact() { throw new Error("Unexpected automatic compaction"); }, getSystemPrompt: () => "",
 });
 await runner.emit({ type: "session_start", reason: "startup" });
 const scope = () => sm.getBranch().filter(e => e.customType === "om.memory.scope").at(-1)?.data.scopeId;
 const firstScope = scope(); assert.ok(firstScope); checks++;
 const a = sm.appendMessage({ role: "user", content: "UNIQUE_PREFIX", timestamp: Date.now() });
 const b = sm.appendMessage({ role: "user", content: "TAIL", timestamp: Date.now() });
 const compact = () => runner.emit({ type: "session_before_compact", preparation: { firstKeptEntryId: b, tokensBefore: 100 }, branchEntries: sm.getBranch(), signal: new AbortController().signal });
 check(await compact(), undefined);
 sm.appendCustomEntry("om.observations.recorded", { coverageVersion: 2, sourceEntryIds: [a], coversUpToId: a,
  observations: [{ timestamp: "2026-11-05T10:00:00", content: "UNIQUE_PREFIX", tokenCount: 4 }] });
 const folded = await compact();
 check(folded.compaction.firstKeptEntryId, b);
 assert.match(folded.compaction.summary, /UNIQUE_PREFIX/); checks++;
 await runner.emit({ type: "session_before_tree", preparation: {}, signal: new AbortController().signal });
 sm.branch(a);
 await runner.emit({ type: "session_tree", newLeafId: a });
 assert.notEqual(scope(), firstScope); checks++;
 check(sm.getBranch().some(e => e.customType === "om.observations.recorded"), false);
 await runner.emit({ type: "session_before_fork", entryId: a, position: "before" });
 await runner.emit({ type: "session_before_switch", reason: "new" });
 await runner.emit({ type: "session_shutdown", reason: "quit" });
 check(errors, []);

 process.env.OM_WORKER = "consolidator";
 process.env.OM_MEMORY_DIR = join(fixture, "staging");
 process.env.OM_RESULT_PATH = join(fixture, "receipt.json");
 mkdirSync(process.env.OM_MEMORY_DIR);
 const worker = await loadExtensions([join(source, "agent/index.ts")], fixture);
 check(worker.errors, []);
 const workerRunner = new ExtensionRunner(worker.extensions, worker.runtime, fixture, sm, {});
 const tools = workerRunner.getAllRegisteredTools();
 const tool = name => tools.find(t => t.definition.name === name).definition;
 await tool("write").execute("w", { path: "topic.md", content: "Retained evidence" });
 await tool("report_consolidation").execute("r", { receipts: [{ timestamp: "T", path: "topic.md", quote: "Retained evidence" }, { timestamp: "N", discardReason: "Repeated greeting" }] });
 const receipts = JSON.parse(readFileSync(process.env.OM_RESULT_PATH, "utf8")).receipts;
 check(receipts.length, 2); assert.match(receipts[0].sha256, /^[a-f0-9]{64}$/); checks++;
 const payload = await workerRunner.emitBeforeProviderRequest({ messages: [{ content: "Authorization: Bearer synthetic-secret" }] });
 assert.ok(!JSON.stringify(payload).includes("synthetic-secret")); checks++;
 const { createJiti } = await import(pathToFileURL(join(host, "node_modules/jiti/lib/jiti.mjs")));
 const jiti = createJiti(import.meta.url, { fsCache: false });
 const { Runtime } = await jiti.import(join(source, "src/runtime.ts"));
 const { evaluateConsolidatorTrigger } = await jiti.import(join(source, "src/hooks/consolidator-trigger.ts"));
 const { evaluateCompactionTrigger } = await jiti.import(join(source, "src/hooks/compaction-trigger.ts"));
 const ownerRuntime = new Runtime();
 const callbacks = [];
 const ownerCtx = { hasUI: false, sessionManager: { getBranch: () => [] }, getContextUsage: () => ({ tokens: 999999 }), compact: options => callbacks.push(options) };
 evaluateCompactionTrigger(ownerRuntime, ownerCtx);
 callbacks[0].onComplete();
 ownerRuntime.abortAllWorkers();
 evaluateCompactionTrigger(ownerRuntime, ownerCtx);
 callbacks[0].onComplete();
 check(ownerRuntime.compactInFlight, true);
 callbacks[1].onComplete();
 check(ownerRuntime.compactInFlight, false);
 const { pruneRuns } = await jiti.import(join(source, "src/spawn/runs.ts"));
 const { spawnWorker } = await jiti.import(join(source, "src/spawn/launch.ts"));
 const fakeWorker = join(fixture, "worker.cjs");
 writeFileSync(fakeWorker, `
 const fs = require('fs'), path = require('path'), crypto = require('crypto');
 const root = path.dirname(path.dirname(process.env.OM_RESULT_PATH));
 const text = 'Persisted fact';
 fs.writeFileSync(path.join(process.env.OM_MEMORY_DIR, 'topic.md'), text);
 fs.writeFileSync(process.env.OM_RESULT_PATH, JSON.stringify({receipts:[{timestamp:'T',path:'topic.md',quote:text,sha256:crypto.createHash('sha256').update(text).digest('hex')}]}));
 fs.writeFileSync(path.join(root, 'ready'), 'ready');
 setTimeout(() => process.exit(0), 300);
 `);
 const previousArgv = process.argv[1]; process.argv[1] = fakeWorker;
 try {
  for (const failIndex of [false, true]) {
   const memory = join(fixture, failIndex ? "partial" : "success"); mkdirSync(memory);
   const rt = new Runtime(); rt.memoryRoot = memory; rt.configLoaded = true;
   rt.config = { ...rt.config, consolidateAtPoolTokens: 1, poolTargetTokens: 1 };
   const branch = [{ type: "message", id: "a", message: { role: "user", content: "source" } },
    { type: "custom", id: "obs", customType: "om.observations.recorded", data: { coversUpToId: "a", observations: [
     { timestamp: "T", content: "Persisted fact", tokenCount: 100 }, { timestamp: "Z", content: "Keep tail", tokenCount: 100 },
    ] } }];
   const commits = [];
   evaluateConsolidatorTrigger({ appendEntry: (type, data) => commits.push({ type, data }) }, rt,
    { hasUI: false, sessionManager: { getBranch: () => branch, getEntries: () => branch } });
   const { existsSync, readdirSync, symlinkSync, utimesSync } = await import("node:fs");
   const until = Date.now() + 3000;
   while (!existsSync(join(memory, "ready")) && rt.consolidatorInFlight && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
   assert.ok(existsSync(join(memory, "ready")), rt.lastWorkerError); checks++;
   const stage = readdirSync(join(memory, ".runs")).find(name => name.includes(".stage-"));
   utimesSync(join(memory, ".runs", stage), new Date(0), new Date(0));
   for (let i = 0; i < 110; i++) writeFileSync(join(memory, ".runs", `obs-20260101-1-${i}.result.json`), "{}");
   pruneRuns(memory, new Set([rt.consolidatorRunId]));
   check(existsSync(join(memory, ".runs", stage)), true);
   if (failIndex) symlinkSync(join(fixture, "outside-index"), join(memory, "INDEX.md"));
   await rt.consolidatorTask;
   const drops = commits.filter(commit => commit.type === "om.observations.dropped");
   check(drops.length, failIndex ? 0 : 1);
   check(readFileSync(join(memory, "topic.md"), "utf8"), "Persisted fact");
   check(rt.consolidatorInFlight, false);
   check(existsSync(join(memory, ".runs", stage)), false);
  }
 } finally { process.argv[1] = previousArgv; }
 const deadlineScript = join(fixture, "deadline.cjs");
 writeFileSync(deadlineScript, 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);');
 const started = Date.now();
 const expired = await spawnWorker({ argv: [process.execPath, deadlineScript], cwd: fixture, env: {}, timeoutMs: 200, killGraceMs: 50 });
 check(expired.signal, "SIGKILL"); assert.ok(Date.now() - started < 3000); checks++;
 console.log(`Pi 1.5 lifecycle integration: ${checks} checks PASS; synthetic fixtures; no model calls`);
} finally { rmSync(fixture, { recursive: true, force: true }); }

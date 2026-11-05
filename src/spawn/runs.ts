import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { assertNoSymlinks, atomicWrite, safeRead } from "../memory/paths.js";
export { atomicWrite } from "../memory/paths.js";

export type RawObservation = { timestamp: string; content: string };
export type ObserverRunResult = { observations: RawObservation[] };
export type WorkerCostResult = { costUsd: number };

export function runsDir(root: string): string { return join(root, ".runs"); }
export function runResultPath(root: string, runId: string): string { return join(runsDir(root), `${runId}.result.json`); }
export function runCostPath(root: string, runId: string): string { return join(runsDir(root), `${runId}.cost.json`); }

export function writeWorkerCost(path: string, cost: WorkerCostResult): void { atomicWrite(path, JSON.stringify(cost)); }
export function readWorkerCost(path: string): WorkerCostResult | undefined {
	try {
		const raw = JSON.parse(safeRead(path)) as unknown;
		if (!raw || typeof raw !== "object") return undefined;
		const cost = (raw as { costUsd?: unknown }).costUsd;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return undefined;
		return { costUsd: cost };
	} catch { return undefined; }
}

export function pruneRuns(root: string, active: Set<string> = new Set(), keep = 100): void {
	const dir = runsDir(root);
	if (!existsSync(dir)) return;
	assertNoSymlinks(dir);
	const files = readdirSync(dir).flatMap(name => {
		const match = /^((?:obs|cons)-\d+-\d+-\d+(?:-[a-f0-9-]{36})?)\.(?:(?:result|cost)\.json|stage-[a-zA-Z0-9]+)$/.exec(name);
		if (!match || active.has(match[1])) return [];
		const path = join(dir, name), stat = lstatSync(path);
		return stat.isFile() || stat.isDirectory() ? [{ path, mtime: stat.mtimeMs, directory: stat.isDirectory() }] : [];
	}).sort((a, b) => b.mtime - a.mtime);
	for (const file of files.slice(keep)) {
		if (file.directory) rmSync(file.path, { recursive: true, force: true });
		else unlinkSync(file.path);
	}
}

function isRawObservation(value: unknown): value is RawObservation {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.timestamp === "string" && typeof v.content === "string" && v.content.trim().length > 0;
}

export function readObserverResult(path: string): ObserverRunResult {
	let raw: unknown;
	try { raw = JSON.parse(safeRead(path)); } catch { throw new Error("Missing or invalid observer result JSON"); }
	if (!raw || typeof raw !== "object" || !Array.isArray((raw as { observations?: unknown }).observations)) {
		throw new Error("observer result missing observations array");
	}
	const observations = (raw as { observations: unknown[] }).observations;
	if (!observations.every(isRawObservation)) throw new Error("Invalid observation result");
	return { observations };
}
export function writeObserverResult(path: string, result: ObserverRunResult): void { atomicWrite(path, JSON.stringify(result)); }

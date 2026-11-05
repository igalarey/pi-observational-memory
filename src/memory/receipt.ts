import { createHash } from "node:crypto";
import { resolveWithinMemory, safeRead } from "./paths.js";

export type ConsolidationReceipt = {
	timestamp: string;
	path?: string;
	quote?: string;
	sha256?: string;
	discardReason?: string;
};

export function fileDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function verifyReceipts(root: string, value: unknown): ConsolidationReceipt[] {
	if (!Array.isArray(value)) throw new Error("Missing consolidation receipts");
	const seen = new Set<string>();
	return value.map(raw => {
		if (!raw || typeof raw !== "object" || typeof raw.timestamp !== "string" || seen.has(raw.timestamp)) {
			throw new Error("Invalid consolidation receipt");
		}
		seen.add(raw.timestamp);
		if (typeof raw.discardReason === "string" && raw.discardReason.trim() && !raw.path && !raw.quote && !raw.sha256) {
			return { timestamp: raw.timestamp, discardReason: raw.discardReason.trim() };
		}
		if (typeof raw.path !== "string" || !/^[\w-]+\.md$/.test(raw.path) || /^INDEX\.md$/i.test(raw.path) ||
			typeof raw.quote !== "string" || !raw.quote.trim() || typeof raw.sha256 !== "string" || raw.discardReason) {
			throw new Error("Invalid persisted receipt");
		}
		const path = resolveWithinMemory(root, raw.path);
		if (!path) throw new Error("Unsafe receipt path");
		const text = safeRead(path);
		if (!text.includes(raw.quote) || fileDigest(text) !== raw.sha256) throw new Error("Receipt does not match persisted file");
		return { timestamp: raw.timestamp, path: raw.path, quote: raw.quote, sha256: raw.sha256 };
	});
}

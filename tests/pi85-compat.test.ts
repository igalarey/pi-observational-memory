import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

test("manifest and lock pin Pi 0.85.1 dev dependencies without changing public peers", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
	for (const metadata of [manifest, lock.packages[""]]) {
		expect(metadata.peerDependencies).toMatchObject({
			"@earendil-works/pi-agent-core": "*",
			"@earendil-works/pi-ai": "*",
			"@earendil-works/pi-coding-agent": "*",
			"@earendil-works/pi-tui": "*",
			typebox: "*",
		});
		expect(metadata.devDependencies?.["@earendil-works/pi-server"]).toBeUndefined();
	}
	for (const dependency of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"]) {
		expect(manifest.devDependencies[`@earendil-works/${dependency}`]).toBe("0.85.1");
	}
	expect(manifest.devDependencies.typebox).toBe("1.3.7");
});

test("Pi 0.85.1 loads observational memory and registers its commands and hooks", async () => {
	const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-observational-memory-compat-"));
	try {
		const result = await discoverAndLoadExtensions([path.join(root, "src/index.ts")], emptyDir, emptyDir);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		const extension = result.extensions[0];
		expect([...extension.commands.keys()].sort()).toEqual(["om", "om:compact", "om:consolidate", "om:status"]);
		expect([...extension.handlers.keys()].sort()).toEqual([
			"agent_settled",
			"agent_start",
			"session_before_compact",
			"session_shutdown",
			"session_start",
			"turn_end",
		]);
	} finally {
		fs.rmSync(emptyDir, { recursive: true, force: true });
	}
});

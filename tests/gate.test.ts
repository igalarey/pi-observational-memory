import { describe, expect, it } from "vitest";
import { readGateFromLedger } from "../src/index.js";
import { OM_ENABLED, type Entry } from "../src/ledger/index.js";
import { Runtime } from "../src/runtime.js";

function gateEntry(id: string, enabled: boolean): Entry {
	return {
		type: "custom",
		id,
		customType: OM_ENABLED,
		data: { enabled },
	};
}

describe("per-session gate", () => {
	it("is enabled when the session has no persisted gate state", () => {
		expect(new Runtime().enabled).toBe(true);
		expect(readGateFromLedger([])).toBe(true);
	});

	it("honors the latest explicit gate state", () => {
		expect(readGateFromLedger([gateEntry("off", false)])).toBe(false);
		expect(readGateFromLedger([gateEntry("off", false), gateEntry("on", true)])).toBe(true);
		expect(readGateFromLedger([gateEntry("on", true), gateEntry("off", false)])).toBe(false);
	});
});

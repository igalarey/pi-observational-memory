import { describe, expect, it } from "vitest";

import { StatusController, type StatusUI } from "../src/ui/status-controller.js";

function fakeUI() {
	const status = new Map<string, string | undefined>();
	const ui: StatusUI = {
		setStatus: (key, text) => status.set(key, text),
		setWidget: () => {},
		// Strip color so assertions read the raw glyphs.
		theme: { fg: (_color, text) => text },
	};
	return { ui, footer: () => status.get("om") };
}

describe("StatusController footer gauges", () => {
	it("keeps the workers widget registered while its spinner refreshes", () => {
		const theme = { fg: (_color: string, text: string) => text };
		const writes: unknown[] = [];
		let renderRequests = 0;
		let component: { render(width: number): string[] } | undefined;
		const ui: StatusUI = {
			setStatus: () => {},
			setWidget: (_key, content) => {
				writes.push(content);
				if (typeof content === "function") {
					component = content({ requestRender: () => { renderRequests += 1; } }, theme);
				}
			},
			theme,
		};
		const sc = new StatusController({ spinnerIntervalMs: 60_000 });
		sc.attach(ui);
		sc.workerStart("observer", "observer-1");
		sc.workerStart("consolidator", "consolidator-1");

		expect(writes).toHaveLength(1);
		expect(renderRequests).toBe(1);
		expect(component?.render(80).join(" ")).toContain("[observer]");
		expect(component?.render(80).join(" ")).toContain("[consolidator]");

		sc.detach();
		expect(writes).toHaveLength(2);
		expect(writes[1]).toBeUndefined();
	});

	it("shows a bare footer until gauges are set", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		expect(footer()).toBe("om");
	});

	it("clearing gauges returns to the bare footer", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		sc.setGauges({ nextValue: 1500, nextMax: 3000, poolValue: 5000, poolMax: 10_000, ctxValue: 10_000, ctxMax: 80_000 });
		sc.setGauges(undefined);
		expect(footer()).toBe("om");
	});
});

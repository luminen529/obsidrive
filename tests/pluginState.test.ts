import { describe, expect, it } from "vitest";
import { planPluginStates } from "../src/pluginState";

const m = (id: string) => `.obsidian/plugins/${id}/manifest.json`;
const plan = (o: Partial<Parameters<typeof planPluginStates>[0]>) =>
	planPluginStates({
		configDir: ".obsidian",
		before: new Set(),
		after: new Set(),
		report: { downloaded: [], deletedLocal: [] },
		firstSync: false,
		enabled: new Set(),
		isSynced: (p) => !p.includes("/obsidrive/"),
		...o,
	});

describe("planPluginStates", () => {
	it("enables every synced plugin on the first sync", () => {
		const r = plan({
			firstSync: true,
			after: new Set(["dataview", "brat", "obsidrive", "kanban"]),
			enabled: new Set(["obsidrive", "kanban"]),
		});
		expect(r.enable.sort()).toEqual(["brat", "dataview"]);
		expect(r.disable).toEqual([]);
	});

	it("enables plugins that sync installed, but leaves updated ones alone", () => {
		const r = plan({
			before: new Set(["dataview", "dragger"]),
			after: new Set(["dataview", "dragger", "kanban"]),
			report: { downloaded: [m("dragger"), m("kanban"), ".obsidian/plugins/kanban/main.js", "note.md"], deletedLocal: [] },
			enabled: new Set(["dataview"]), // dragger was turned off on this device
		});
		expect(r.enable).toEqual(["kanban"]);
	});

	it("disables plugins that sync removed", () => {
		const r = plan({
			before: new Set(["dataview", "kanban"]),
			after: new Set(["dataview"]),
			report: { downloaded: [], deletedLocal: [m("kanban"), m("never-enabled")] },
			enabled: new Set(["dataview", "kanban"]),
		});
		expect(r.disable).toEqual(["kanban"]);
		expect(r.enable).toEqual([]);
	});

	it("keeps a plugin enabled when its manifest was deleted but it is still installed", () => {
		const r = plan({
			before: new Set(["kanban"]),
			after: new Set(["kanban"]),
			report: { downloaded: [], deletedLocal: [m("kanban")] },
			enabled: new Set(["kanban"]),
		});
		expect(r.disable).toEqual([]);
	});
});

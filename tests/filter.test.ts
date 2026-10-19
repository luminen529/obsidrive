import { describe, expect, it } from "vitest";
import { PathFilter } from "../src/filter";
import { DEFAULT_SETTINGS } from "../src/settings";
import { conflictPath, patternToRegExp, splitExt } from "../src/util";

const make = (over: Partial<typeof DEFAULT_SETTINGS> = {}) =>
	new PathFilter(".obsidian", { ...DEFAULT_SETTINGS, ...over }, "obsidrive");

describe("PathFilter", () => {
	it("syncs regular notes but not dot-folders", () => {
		const f = make();
		expect(f.includes("Notes/a.md")).toBe(true);
		expect(f.includes(".git/config")).toBe(false);
		expect(f.includes(".trash/a.md")).toBe(false);
		expect(f.includes("a/.hidden/b.md")).toBe(false);
		expect(f.includes("a/../b.md")).toBe(false);
	});

	it("handles config categories", () => {
		const f = make();
		expect(f.includes(".obsidian/app.json")).toBe(true);
		expect(f.includes(".obsidian/workspace.json")).toBe(false);
		expect(f.includes(".obsidian/community-plugins.json")).toBe(false); // enabled plugins are per device
		expect(f.includes(".obsidian/themes/Minimal/theme.css")).toBe(true);
		expect(f.includes(".obsidian/snippets/x.css")).toBe(true);
		expect(f.includes(".obsidian/plugins/dataview/main.js")).toBe(true);
		expect(f.includes(".obsidian/plugins/dataview/data.json")).toBe(true);
		expect(f.includes(".obsidian/plugins/dataview/cache/x.json")).toBe(false);
		expect(f.includes(".obsidian/plugins/obsidrive/data.json")).toBe(false);
		expect(f.includes(".obsidian/plugins/obsidrive/main.js")).toBe(false);
	});

	it("respects toggles and excluded plugins", () => {
		const f = make({ syncPluginData: false, excludedPlugins: "obsidian-git, x", syncCoreSettings: false, syncWorkspace: true });
		expect(f.includes(".obsidian/plugins/dataview/data.json")).toBe(false);
		expect(f.includes(".obsidian/plugins/obsidian-git/main.js")).toBe(false);
		expect(f.includes(".obsidian/app.json")).toBe(false);
		expect(f.includes(".obsidian/workspace.json")).toBe(true);
	});

	it("applies ignore patterns", () => {
		const f = make({ ignorePatterns: "Archive/**\n*.tmp\nPrivate/\n/^Daily\\/2020/" });
		expect(f.includes("Archive/old.md")).toBe(false);
		expect(f.includes("x/y.tmp")).toBe(false);
		expect(f.includes("Private/secret.md")).toBe(false);
		expect(f.includes("Daily/2020-01-01.md")).toBe(false);
		expect(f.includes("Daily/2021-01-01.md")).toBe(true);
		expect(f.includes("Notes/Archive.md")).toBe(true);
	});
});

describe("util", () => {
	it("glob patterns", () => {
		expect(patternToRegExp("*.png")!.test("a/b/c.png")).toBe(true);
		expect(patternToRegExp("a/*.md")!.test("a/b/c.md")).toBe(false);
		expect(patternToRegExp("a/**/*.md")!.test("a/b/c.md")).toBe(true);
		expect(patternToRegExp("# comment")).toBeNull();
	});
	it("conflict names keep the extension", () => {
		expect(splitExt("a/b.c/note.md")).toEqual(["a/b.c/note", ".md"]);
		expect(splitExt(".gitignore")).toEqual([".gitignore", ""]);
		expect(conflictPath("x/note.md", "phone", 0)).toMatch(/^x\/note \(conflict .* phone\)\.md$/);
	});
});

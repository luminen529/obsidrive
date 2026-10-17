// ObsidianLocalFs + OwnWriteTracker against an in-memory vault that fires
// events in the same order Obsidian does (synchronously inside the write).

import { beforeEach, describe, expect, it } from "vitest";
import { PathFilter } from "../src/filter";
import { ObsidianLocalFs } from "../src/obsidianFs";
import { runTextReplaceSelfTest } from "../src/selfTest";
import { FileState, OwnWriteTracker } from "../src/ownWrites";
import { DEFAULT_SETTINGS } from "../src/settings";
import { fakeApp, FakeVault } from "./obsidianStub";

let vault: FakeVault;
let fs: ObsidianLocalFs;
let changes: number;

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

beforeEach(() => {
	vault = new FakeVault();
	changes = 0;
	const tracker = new OwnWriteTracker(
		(path): FileState => {
			const e = vault.files.get(path);
			if (e) return { kind: "file", mtime: e.mtime, size: e.data.byteLength };
			return vault.folders.has(path) ? { kind: "folder" } : null;
		},
		() => changes++,
	);
	vault.onEvent = (paths) => tracker.onEvent(paths);
	fs = new ObsidianLocalFs(fakeApp(vault), new PathFilter(".obsidian", DEFAULT_SETTINGS, "obsidrive"), tracker);
});

describe("own-write detection through ObsidianLocalFs", () => {
	it("our own write and its late watcher event are not user changes", async () => {
		vault.userWrite("n.md", "v1");
		changes = 0;
		await fs.write("n.md", enc("v2 from remote"), 500);
		vault.onEvent?.(["n.md"]); // late watcher event
		expect(changes).toBe(0);
	});

	it("a user save after our write is a change", async () => {
		await fs.write("n.md", enc("v2"), 500);
		vault.userWrite("n.md", "user edit");
		expect(changes).toBe(1);
	});

	it("replaceText without interference is not a change", async () => {
		vault.userWrite("n.md", "abc");
		changes = 0;
		expect(await fs.replaceText("n.md", "abc", "def")).toBe("replaced");
		vault.onEvent?.(["n.md"]);
		expect(changes).toBe(0);
	});

	it("a same-size user save right after replaceText still triggers a sync", async () => {
		vault.userWrite("n.md", "abc");
		changes = 0;
		vault.afterProcess = (path) => {
			vault.afterProcess = undefined;
			vault.userWrite(path, "xyz"); // same byte length as our "def"
		};
		expect(await fs.replaceText("n.md", "abc", "def")).toBe("replaced");
		expect(changes).toBeGreaterThanOrEqual(1);
		const before = changes;
		vault.onEvent?.(["n.md"]); // late watcher event for the user's save
		expect(changes).toBe(before + 1);
	});

	it("replaceText refuses to overwrite a note that changed", async () => {
		vault.userWrite("n.md", "user text");
		expect(await fs.replaceText("n.md", "old text", "remote text")).toBe("changed");
		expect(vault.text("n.md")).toBe("user text");
	});

	it("our trash and rename events are not user changes", async () => {
		vault.userWrite("a.md", "a");
		vault.userWrite("b.md", "b");
		changes = 0;
		await fs.trash("a.md");
		await fs.rename("b.md", "c.md");
		vault.onEvent?.(["c.md", "b.md"]);
		expect(changes).toBe(0);
	});
});

describe("text replace self-test", () => {
	const filter = () => new PathFilter(".obsidian", DEFAULT_SETTINGS, "obsidrive");
	const tracker = () => new OwnWriteTracker(() => null, () => {});

	it("passes when Vault.process keeps the bytes, and cleans up its note", async () => {
		const r = await runTextReplaceSelfTest(fakeApp(vault), filter(), tracker());
		expect(r.ok).toBe(true);
		expect(vault.files.size).toBe(0);
	});

	it("reports a vault whose text read normalizes BOM/line endings", async () => {
		vault.normalizeOnRead = true;
		const r = await runTextReplaceSelfTest(fakeApp(vault), filter(), tracker());
		expect(r.ok).toBe(false);
		expect(vault.files.size).toBe(0);
	});

	it("its temporary note is never synced", () => {
		expect(filter().includes("__obsidrive_selftest__ 123.md")).toBe(false);
	});
});

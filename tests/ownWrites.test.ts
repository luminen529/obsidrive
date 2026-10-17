import { describe, expect, it } from "vitest";
import { FileState, OwnWriteTracker } from "../src/ownWrites";

function setup() {
	const disk = new Map<string, FileState>();
	let changes = 0;
	const t = new OwnWriteTracker(
		(p) => disk.get(p) ?? null,
		() => changes++,
	);
	return { t, disk, changes: () => changes };
}

const file = (mtime: number, size: number): FileState => ({ kind: "file", mtime, size });

describe("OwnWriteTracker", () => {
	it("ignores events from our own write, before and after it settles", () => {
		const { t, disk, changes } = setup();
		t.begin(["n.md"]);
		disk.set("n.md", file(100, 5));
		t.onEvent(["n.md"]); // fired from inside the write call
		t.settle("n.md", file(100, 5));
		t.onEvent(["n.md"]); // late watcher event
		expect(changes()).toBe(0);
	});

	it("[P2] a user save during the write is reported once the write settles", () => {
		const { t, disk, changes } = setup();
		t.begin(["n.md"]);
		disk.set("n.md", file(200, 9)); // the user saved while our write was in flight
		t.onEvent(["n.md"]);
		expect(changes()).toBe(0); // deferred, not swallowed
		t.settle("n.md", undefined); // result did not match what we wrote
		expect(changes()).toBe(1);
		t.onEvent(["n.md"]); // the late watcher event also counts
		expect(changes()).toBe(2);
	});

	it("a deferred event is reported if the file changed again before settling", () => {
		const { t, disk, changes } = setup();
		t.begin(["n.md"]);
		disk.set("n.md", file(100, 5));
		t.onEvent(["n.md"]);
		disk.set("n.md", file(300, 7)); // user edit right after our write
		t.settle("n.md", file(100, 5)); // our verified result
		expect(changes()).toBe(1);
	});

	it("a user edit after a settled write counts as a change", () => {
		const { t, disk, changes } = setup();
		t.begin(["n.md"]);
		disk.set("n.md", file(100, 5));
		t.settle("n.md", file(100, 5));
		disk.set("n.md", file(150, 6));
		t.onEvent(["n.md"]);
		expect(changes()).toBe(1);
	});

	it("handles deletions and renames", () => {
		const { t, disk, changes } = setup();
		disk.set("a.md", file(1, 1));
		t.begin(["a.md", "b.md"]);
		disk.delete("a.md");
		disk.set("b.md", file(1, 1));
		t.settle("a.md", null);
		t.settle("b.md", file(1, 1));
		t.onEvent(["b.md", "a.md"]);
		expect(changes()).toBe(0);
		disk.set("a.md", file(5, 2)); // user re-creates the old path
		t.onEvent(["a.md"]);
		expect(changes()).toBe(1);
	});

	it("unknown paths are always user changes", () => {
		const { t, changes } = setup();
		t.onEvent(["other.md"]);
		expect(changes()).toBe(1);
	});
});

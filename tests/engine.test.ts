import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/util";
import { Clock, Device, enc, FakeDrive } from "./fakes";

let clock: Clock;
let drive: FakeDrive;
let A: Device;
let B: Device;

beforeEach(() => {
	clock = new Clock();
	drive = new FakeDrive(clock);
	A = new Device("laptop", drive, clock);
	B = new Device("phone", drive, clock);
});

const sorted = (m: Map<string, string>) => [...m].sort(([a], [b]) => a.localeCompare(b));

describe("two-device sync", () => {
	it("propagates new files and edits", async () => {
		A.fs.put("a.md", "hello");
		A.fs.put("dir/b.md", "world");
		A.fs.put(".obsidian/app.json", "{}");
		await A.sync();
		await B.sync();
		expect(sorted(B.fs.snapshot())).toEqual(sorted(A.fs.snapshot()));

		A.fs.put("a.md", "hello v2");
		await A.sync();
		const r = await B.sync();
		expect(B.fs.get("a.md")).toBe("hello v2");
		expect(r.downloaded).toEqual(["a.md"]);
	});

	it("an idle sync transfers, lists and writes nothing", async () => {
		for (let i = 0; i < 20; i++) A.fs.put(`n${i}.md`, `c${i}`);
		await A.sync();
		await A.sync(); // settles bookkeeping from the first run
		const calls = { ...drive.calls };
		const saves = A.store.saves;
		const cacheSaves = A.cache.saves;
		const r = await A.sync();
		expect(r.uploaded.length + r.downloaded.length + r.deletedLocal.length + r.deletedRemote.length).toBe(0);
		// One change-feed request, no full listing, no transfers or remote writes.
		expect((drive.calls.changes ?? 0) - (calls.changes ?? 0)).toBe(1);
		for (const k of ["list", "download", "create", "updateContent", "updateMeta", "remove"]) {
			expect(drive.calls[k] ?? 0).toBe(calls[k] ?? 0);
		}
		// No disk writes for the state file or the remote cache.
		expect(A.store.saves).toBe(saves);
		expect(A.cache.saves).toBe(cacheSaves);
	});

	it("propagates deletions via tombstones and keeps the content remotely", async () => {
		A.fs.put("a.md", "x");
		A.fs.put("b.md", "y");
		await A.sync();
		await B.sync();
		A.fs.files.delete("a.md");
		await A.sync();
		expect(drive.tombstones()).toEqual(["a.md"]);
		const r = await B.sync();
		expect(r.deletedLocal).toEqual(["a.md"]);
		expect(B.fs.trashed).toEqual(["a.md"]);
		expect(B.fs.get("b.md")).toBe("y");
	});

	it("keeps both versions on concurrent edits", async () => {
		A.fs.put("n.md", "base");
		await A.sync();
		await B.sync();
		A.fs.put("n.md", "from laptop");
		B.fs.put("n.md", "from phone");
		await A.sync();
		const r = await B.sync();
		expect(r.conflicts).toHaveLength(1);
		expect(B.fs.get("n.md")).toBe("from laptop");
		const copy = [...B.fs.files.keys()].find((p) => p.includes("(conflict"));
		expect(copy).toBeDefined();
		expect(B.fs.get(copy!)).toBe("from phone");
		await A.sync();
		expect(sorted(A.fs.snapshot())).toEqual(sorted(B.fs.snapshot()));
	});

	it("modification beats deletion", async () => {
		A.fs.put("n.md", "base");
		await A.sync();
		await B.sync();
		A.fs.files.delete("n.md");
		B.fs.put("n.md", "edited on phone");
		await A.sync(); // tombstones n.md
		await B.sync(); // phone edit revives it
		await A.sync();
		expect(A.fs.get("n.md")).toBe("edited on phone");
		expect(drive.tombstones()).toEqual([]);
	});

	it("first sync with identical files on both sides transfers nothing", async () => {
		A.fs.put("a.md", "same");
		B.fs.put("a.md", "same");
		await A.sync();
		const before = drive.calls.download ?? 0;
		const r = await B.sync();
		expect(r.conflicts).toEqual([]);
		expect(r.uploaded).toEqual([]);
		expect(drive.calls.download ?? 0).toBe(before);
	});

	it("first sync with different content never deletes, makes a conflict copy", async () => {
		A.fs.put("a.md", "laptop");
		B.fs.put("a.md", "phone");
		B.fs.put("only-phone.md", "p");
		await A.sync();
		const r = await B.sync();
		expect(r.deletedLocal).toEqual([]);
		expect(r.deletedRemote).toEqual([]);
		expect(r.conflicts).toHaveLength(1);
		await A.sync();
		expect(A.fs.get("only-phone.md")).toBe("p");
	});

	it("losing the state file never causes deletions", async () => {
		for (let i = 0; i < 10; i++) A.fs.put(`f${i}.md`, `c${i}`);
		await A.sync();
		await B.sync();
		B.store.state = null;
		B.fs.files.delete("f1.md");
		const r = await B.sync();
		expect(r.deletedRemote).toEqual([]);
		expect(B.fs.get("f1.md")).toBe("c1"); // restored from remote instead
	});

	it("mass deletion guard stops the run when not confirmed", async () => {
		for (let i = 0; i < 12; i++) A.fs.put(`f${i}.md`, `c${i}`);
		await A.sync();
		for (let i = 0; i < 10; i++) A.fs.files.delete(`f${i}.md`);
		A.confirm = async () => false;
		const r = await A.sync();
		expect(r.aborted).toMatch(/삭제 보호/);
		expect(drive.tombstones()).toEqual([]);
		A.confirm = async () => true;
		const r2 = await A.sync();
		expect(r2.deletedRemote).toHaveLength(10);
	});

	it("an emptied remote does not wipe the local vault silently", async () => {
		for (let i = 0; i < 10; i++) A.fs.put(`f${i}.md`, `c${i}`);
		await A.sync();
		drive.wipe();
		A.confirm = async () => false;
		const r = await A.sync();
		expect(r.aborted).toBeDefined();
		expect(A.fs.files.size).toBe(10);
	});

	it("renames are applied without re-transferring content", async () => {
		A.fs.put("img/big.png", "BIG-BINARY");
		await A.sync();
		await B.sync();
		const f = A.fs.files.get("img/big.png")!;
		A.fs.files.delete("img/big.png");
		A.fs.files.set("assets/big.png", f);
		const createsBefore = drive.calls.create ?? 0;
		const r = await A.sync();
		expect(r.renamed).toEqual(["img/big.png → assets/big.png"]);
		expect(drive.calls.create ?? 0).toBe(createsBefore);
		const downloadsBefore = drive.calls.download ?? 0;
		const r2 = await B.sync();
		expect(r2.renamed).toEqual(["img/big.png → assets/big.png"]);
		expect(drive.calls.download ?? 0).toBe(downloadsBefore);
		expect(B.fs.get("assets/big.png")).toBe("BIG-BINARY");
		expect(B.fs.get("img/big.png")).toBeUndefined();
	});

	it("config files resolve conflicts by newest mtime without conflict copies", async () => {
		A.fs.put(".obsidian/app.json", '{"v":0}');
		await A.sync();
		await B.sync();
		A.fs.put(".obsidian/app.json", '{"v":"laptop"}');
		B.fs.put(".obsidian/app.json", '{"v":"phone-newer"}');
		await A.sync();
		const r = await B.sync();
		expect(r.conflicts).toEqual([]);
		expect(B.fs.get(".obsidian/app.json")).toBe('{"v":"phone-newer"}');
		const r2 = await A.sync();
		expect(r2.configChanged).toBe(true);
		expect(A.fs.get(".obsidian/app.json")).toBe('{"v":"phone-newer"}');
	});

	it("skips a download when the local file changes during the sync", async () => {
		A.fs.put("n.md", "v1");
		await A.sync();
		await B.sync();
		A.fs.put("n.md", "v2");
		await A.sync();
		let raced = false;
		B.fs.beforeStat = (p) => {
			if (p === "n.md" && !raced) {
				raced = true;
				B.fs.put("n.md", "typing on phone");
			}
		};
		const r = await B.sync();
		expect(r.skipped.map((s) => s.path)).toContain("n.md");
		expect(B.fs.get("n.md")).toBe("typing on phone");
		B.fs.beforeStat = undefined;
		const r2 = await B.sync();
		expect(r2.conflicts).toHaveLength(1); // both changed -> both kept
	});

	it("re-creating a deleted path revives the tombstone", async () => {
		A.fs.put("n.md", "v1");
		await A.sync();
		await B.sync();
		A.fs.files.delete("n.md");
		await A.sync();
		await B.sync();
		expect(B.fs.get("n.md")).toBeUndefined();
		A.fs.put("n.md", "reborn");
		await A.sync();
		expect(drive.files.size).toBe(1);
		await B.sync();
		expect(B.fs.get("n.md")).toBe("reborn");
	});

	it("normalizes duplicate remote files created concurrently", async () => {
		// Two devices uploaded the same new path before either saw the other's file.
		const put = async (content: string, device: string) =>
			drive.create("n.md", { ov: "vault1", oh: await sha256Hex(enc(content)), om: "1", odv: device }, enc(content));
		await put("laptop", "laptop");
		await put("phone", "phone");
		await put("phone", "phone"); // identical duplicate is simply removed
		const r = await A.sync();
		expect(r.errors).toEqual([]);
		const names = [...drive.files.values()].map((f) => f.name).sort();
		expect(names).toHaveLength(2);
		expect(names.filter((n) => n.includes("(conflict"))).toHaveLength(1);
		expect(A.fs.files.size).toBe(2);
		expect(new Set(A.fs.snapshot().values())).toEqual(new Set(["laptop", "phone"]));
	});

	it("case-only renames work on case-insensitive disks", async () => {
		A.fs.put("Note.md", "x");
		await A.sync();
		await B.sync();
		const f = A.fs.files.get("Note.md")!;
		A.fs.files.delete("Note.md");
		A.fs.files.set("note.md", f);
		await A.sync();
		const r = await B.sync();
		expect(r.skipped).toEqual([]);
		expect([...B.fs.files.keys()]).toEqual(["note.md"]);
	});

	it("a freshly created vault does not overwrite established settings", async () => {
		A.fs.put(".obsidian/app.json", '{"vimMode":true}');
		A.fs.put(".obsidian/community-plugins.json", JSON.stringify(["dataview", "obsidrive"]));
		A.fs.put("note.md", "hi");
		await A.sync();
		// New device: Obsidian just wrote its defaults (newer mtimes) and BRAT was installed.
		B.fs.put(".obsidian/app.json", "{}");
		B.fs.put(".obsidian/community-plugins.json", JSON.stringify(["obsidian42-brat", "obsidrive"]));
		const r = await B.sync();
		expect(r.conflicts).toEqual([]);
		expect(r.configChanged).toBe(true);
		expect(B.fs.get(".obsidian/app.json")).toBe('{"vimMode":true}');
		expect(JSON.parse(B.fs.get(".obsidian/community-plugins.json")!)).toEqual(["dataview", "obsidrive", "obsidian42-brat"]);
		expect(B.fs.get("note.md")).toBe("hi");
		await A.sync();
		expect(A.fs.get(".obsidian/app.json")).toBe('{"vimMode":true}');
		expect(JSON.parse(A.fs.get(".obsidian/community-plugins.json")!)).toEqual(["dataview", "obsidrive", "obsidian42-brat"]);
	});

	it("after the first sync, config conflicts go back to newest-wins", async () => {
		A.fs.put(".obsidian/community-plugins.json", JSON.stringify(["a", "b"]));
		await A.sync();
		await B.sync();
		A.fs.put(".obsidian/community-plugins.json", JSON.stringify(["a"])); // plugin b disabled on laptop
		B.fs.put(".obsidian/community-plugins.json", JSON.stringify(["a", "b", "c"])); // newer edit on phone
		await A.sync();
		await B.sync();
		expect(JSON.parse(B.fs.get(".obsidian/community-plugins.json")!)).toEqual(["a", "b", "c"]);
	});

	it("dry run changes nothing", async () => {
		A.fs.put("a.md", "x");
		const r = await A.sync(true);
		expect(r.plan?.some((a) => a.kind === "upload")).toBe(true);
		expect(drive.files.size).toBe(0);
		expect(A.store.state).toBeNull();
	});

	it("ignores files over the size limit on both sides without deleting", async () => {
		A.overrides.maxBytes = 5;
		B.overrides.maxBytes = 5;
		A.fs.put("small.md", "ok");
		A.fs.put("big.bin", "0123456789");
		await A.sync();
		expect([...drive.live().keys()]).toEqual(["small.md"]);
		expect(A.fs.get("big.bin")).toBe("0123456789");
	});
});

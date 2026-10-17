// Regression tests for concurrent-edit races found in review:
// edits that land while a sync is already running must never be lost.

import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/util";
import { Clock, dec, Device, enc, FakeDrive } from "./fakes";

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

const remoteId = (name: string) => [...drive.files.values()].find((f) => f.name === name)!.id;

/** Another device replaces the content of a remote file (with a correct hash). */
async function editRemotely(name: string, content: string) {
	const data = enc(content);
	await drive.updateContent(remoteId(name), { appProperties: { oh: await sha256Hex(data), om: String(clock.tick()), odv: "tablet" } }, data);
}

async function expectRemoteHashesValid() {
	for (const f of drive.files.values()) expect(await sha256Hex(f.data)).toBe(f.appProperties.oh);
}

describe("concurrent edits during a sync", () => {
	it("[P1] an edit made while a download is in flight is not overwritten", async () => {
		A.fs.put("n.md", "v1");
		await A.sync();
		await B.sync();
		A.fs.put("n.md", "v2 from laptop");
		await A.sync();

		drive.onDownload = () => {
			drive.onDownload = undefined;
			B.fs.put("n.md", "typing on phone");
		};
		const r = await B.sync();
		expect(r.downloaded).toEqual([]);
		expect(r.skipped.map((s) => s.path)).toContain("n.md");
		expect(B.fs.get("n.md")).toBe("typing on phone");

		const r2 = await B.sync(); // now both sides changed -> both versions kept
		expect(r2.conflicts).toHaveLength(1);
		expect(B.fs.get("n.md")).toBe("v2 from laptop");
		expect([...B.fs.snapshot().values()]).toContain("typing on phone");
	});

	it("[P1] a remote rename does not overwrite the hash of content changed by another device", async () => {
		A.fs.put("img.png", "IMG");
		await A.sync();
		await B.sync();
		const f = A.fs.files.get("img.png")!;
		A.fs.files.delete("img.png");
		A.fs.files.set("new.png", f);

		drive.onListed = () => editRemotely("img.png", "IMG edited on tablet");
		const r = await A.sync();
		expect(r.renamed).toEqual([]);
		expect(r.errors).toEqual([]);
		await expectRemoteHashesValid();

		const r2 = await A.sync();
		expect(r2.errors).toEqual([]);
		expect(A.fs.get("img.png")).toBe("IMG edited on tablet"); // modification beats the move
		expect(A.fs.get("new.png")).toBe("IMG");
		await expectRemoteHashesValid();
		const r3 = await B.sync();
		expect(r3.errors).toEqual([]);
	});

	it("[P1] a remote deletion does not tombstone a newer edit from another device", async () => {
		A.fs.put("n.md", "v1");
		await A.sync();
		A.fs.files.delete("n.md");

		drive.onListed = () => editRemotely("n.md", "edited on tablet");
		const r = await A.sync();
		expect(r.deletedRemote).toEqual([]);
		expect(drive.tombstones()).toEqual([]);

		await A.sync();
		expect(A.fs.get("n.md")).toBe("edited on tablet");
	});

	it("[P2] a cancelled sync is reported as aborted and not recorded as completed", async () => {
		for (let i = 0; i < 10; i++) A.fs.put(`f${i}.md`, `c${i}`);
		A.overrides.concurrency = 1;
		A.overrides.isCancelled = () => (drive.calls.create ?? 0) >= 2;
		const r = await A.sync();
		expect(r.aborted).toMatch(/취소/);
		expect(r.uploaded.length).toBeLessThan(10);
		expect(A.store.state?.lastSync ?? 0).toBe(0);

		A.overrides.isCancelled = undefined;
		const r2 = await A.sync();
		expect(r2.aborted).toBeUndefined();
		expect(A.store.state!.lastSync).toBeGreaterThan(0);
		expect(drive.live().size).toBe(10);
	});

	it("an idle sync does not rewrite the state or cache files", async () => {
		A.fs.put("a.md", "x");
		await A.sync();
		await A.sync(); // settles any bookkeeping from the first run
		const saves = A.store.saves;
		const cacheSaves = A.cache.saves;
		await A.sync();
		expect(A.store.saves).toBe(saves);
		expect(A.cache.saves).toBe(cacheSaves);
	});

	it("downloaded content always matches its recorded hash", async () => {
		A.fs.put("n.md", "v1");
		await A.sync();
		await B.sync();
		await editRemotely("n.md", "v2");
		await B.sync();
		expect(B.fs.get("n.md")).toBe("v2");
		expect(dec(B.fs.files.get("n.md")!.data)).toBe("v2");
	});
});

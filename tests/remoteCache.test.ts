import { beforeEach, describe, expect, it } from "vitest";
import { CachedRemoteStore, RemoteCacheData } from "../src/remoteCache";
import { Clock, Device, enc, FakeDrive, MemJson } from "./fakes";

let clock: Clock;
let drive: FakeDrive;

beforeEach(() => {
	clock = new Clock();
	drive = new FakeDrive(clock);
});

const props = (extra: Record<string, string> = {}) => ({ ov: "vault1", oh: "h", om: "1", ...extra });
const names = (files: { name: string }[]) => files.map((f) => f.name).sort();

function cached(cache = new MemJson<RemoteCacheData>(), scope = "client|me|vault1") {
	return new CachedRemoteStore(drive, cache, scope, { fullRefreshMs: 86_400_000, now: () => clock.t });
}

describe("CachedRemoteStore", () => {
	it("lists everything once, then only fetches changes", async () => {
		await drive.create("a.md", props(), enc("a"));
		const remote = cached();
		expect(names(await remote.listVault("vault1"))).toEqual(["a.md"]);
		expect(drive.calls.list).toBe(1);

		const b = await drive.create("b.md", props(), enc("b"));
		await drive.updateMeta(b.id, { name: "c.md" });
		expect(names(await remote.listVault("vault1"))).toEqual(["a.md", "c.md"]);
		expect(drive.calls.list).toBe(1);
		expect(drive.calls.changes).toBe(1);
	});

	it("drops removed files while tombstones stay visible", async () => {
		const a = await drive.create("a.md", props(), enc("a"));
		const b = await drive.create("b.md", props(), enc("b"));
		const remote = cached();
		await remote.listVault("vault1");
		await drive.remove(a.id);
		await drive.updateMeta(b.id, { appProperties: { od: "123" } });
		const files = await remote.listVault("vault1");
		expect(names(files)).toEqual(["b.md"]);
		expect(files[0].appProperties.od).toBe("123");
	});

	it("ignores other vaults and vault markers in the feed", async () => {
		const remote = cached();
		await remote.listVault("vault1");
		await drive.create("x.md", { ov: "other" }, enc("x"));
		await drive.create(".obsidrive-vault/v", { ov: "vault1", okind: "vault" }, enc(""));
		expect(await remote.listVault("vault1")).toEqual([]);
	});

	it("falls back to a full listing when the token is no longer valid", async () => {
		await drive.create("a.md", props(), enc("a"));
		const remote = cached();
		await remote.listVault("vault1");
		await drive.create("b.md", props(), enc("b"));
		drive.minValidToken = 999;
		expect(names(await remote.listVault("vault1"))).toEqual(["a.md", "b.md"]);
		expect(drive.calls.list).toBe(2);
	});

	it("does a full listing again after the refresh interval", async () => {
		const remote = cached();
		await remote.listVault("vault1");
		clock.tick(86_400_001);
		await remote.listVault("vault1");
		expect(drive.calls.list).toBe(2);
	});

	it("does not reuse a cache from another account, client or vault", async () => {
		const shared = new MemJson<RemoteCacheData>();
		await cached(shared, "client|me|vault1").listVault("vault1");
		await cached(shared, "client|someone-else|vault1").listVault("vault1");
		expect(drive.calls.list).toBe(2);
	});

	it("network errors abort instead of trusting a stale cache", async () => {
		const remote = cached();
		await remote.listVault("vault1");
		drive.listChanges = async () => {
			throw new Error("offline");
		};
		await expect(remote.listVault("vault1")).rejects.toThrow("offline");
	});

	it("an idle sync costs one change-feed request and no listing", async () => {
		const A = new Device("laptop", drive, clock);
		for (let i = 0; i < 50; i++) A.fs.put(`n${i}.md`, `c${i}`);
		await A.sync();
		const before = { ...drive.calls };
		const r = await A.sync();
		expect(r.uploaded.length + r.downloaded.length).toBe(0);
		expect(drive.calls.list ?? 0).toBe(before.list ?? 0);
		expect((drive.calls.changes ?? 0) - (before.changes ?? 0)).toBe(1);
		expect(drive.calls.download ?? 0).toBe(before.download ?? 0);
	});
});

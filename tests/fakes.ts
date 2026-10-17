// In-memory stand-ins for the vault, Google Drive and the state file.

import type { AppProps, RemoteFile } from "../src/drive";
import { EngineConfig, LocalFs, RemoteStore, StateStore, SyncEngine } from "../src/sync/engine";
import type { SyncReport, SyncState } from "../src/sync/types";

export const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
export const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

export class Clock {
	t = 1_700_000_000_000;
	tick(ms = 1000) {
		this.t += ms;
		return this.t;
	}
}

interface StoredRemote {
	id: string;
	name: string;
	appProperties: Record<string, string>;
	data: ArrayBuffer;
	modifiedTime: number;
}

export class FakeDrive implements RemoteStore {
	files = new Map<string, StoredRemote>();
	calls: Record<string, number> = {};
	private seq = 0;
	constructor(private clock: Clock) {}

	private count(k: string) {
		this.calls[k] = (this.calls[k] ?? 0) + 1;
	}
	private view(f: StoredRemote): RemoteFile {
		return { id: f.id, name: f.name, size: f.data.byteLength, modifiedTime: f.modifiedTime, appProperties: { ...f.appProperties } };
	}
	private merge(target: Record<string, string>, props: AppProps | undefined) {
		for (const [k, v] of Object.entries(props ?? {})) {
			if (v === null) delete target[k];
			else target[k] = v;
		}
	}
	async listVault(vaultKey: string) {
		this.count("list");
		return [...this.files.values()].filter((f) => f.appProperties.ov === vaultKey).map((f) => this.view(f));
	}
	async getMeta(id: string) {
		this.count("getMeta");
		const f = this.files.get(id);
		return f ? this.view(f) : null;
	}
	async download(id: string) {
		this.count("download");
		const f = this.files.get(id);
		if (!f) throw new Error("404");
		return f.data.slice(0);
	}
	async create(name: string, appProperties: AppProps, data: ArrayBuffer) {
		this.count("create");
		const f: StoredRemote = { id: `id${++this.seq}`, name, appProperties: {}, data: data.slice(0), modifiedTime: this.clock.tick() };
		this.merge(f.appProperties, appProperties);
		this.files.set(f.id, f);
		return this.view(f);
	}
	async updateContent(id: string, meta: { name?: string; appProperties: AppProps }, data: ArrayBuffer) {
		this.count("updateContent");
		const f = this.files.get(id);
		if (!f) throw new Error("404");
		if (meta.name) f.name = meta.name;
		this.merge(f.appProperties, meta.appProperties);
		f.data = data.slice(0);
		f.modifiedTime = this.clock.tick();
		return this.view(f);
	}
	async updateMeta(id: string, meta: { name?: string; appProperties?: AppProps }) {
		this.count("updateMeta");
		const f = this.files.get(id);
		if (!f) throw new Error("404");
		if (meta.name) f.name = meta.name;
		this.merge(f.appProperties, meta.appProperties);
		f.modifiedTime = this.clock.tick();
		return this.view(f);
	}
	async remove(id: string) {
		this.count("remove");
		this.files.delete(id);
	}

	live(): Map<string, string> {
		const out = new Map<string, string>();
		for (const f of this.files.values()) if (!f.appProperties.od) out.set(f.name, dec(f.data));
		return out;
	}
	tombstones(): string[] {
		return [...this.files.values()].filter((f) => f.appProperties.od).map((f) => f.name);
	}
}

export class FakeFs implements LocalFs {
	files = new Map<string, { data: ArrayBuffer; mtime: number }>();
	trashed: string[] = [];
	/** Hook to simulate edits racing the sync. */
	beforeStat?: (path: string) => void;
	constructor(private clock: Clock) {}

	put(path: string, content: string) {
		this.files.set(path, { data: enc(content), mtime: this.clock.tick() });
	}
	get(path: string) {
		const f = this.files.get(path);
		return f ? dec(f.data) : undefined;
	}
	snapshot(): Map<string, string> {
		return new Map([...this.files].map(([p, f]) => [p, dec(f.data)]));
	}

	async list() {
		return [...this.files].map(([path, f]) => ({ path, mtime: f.mtime, size: f.data.byteLength }));
	}
	async stat(path: string) {
		this.beforeStat?.(path);
		const f = this.files.get(path);
		return f ? { mtime: f.mtime, size: f.data.byteLength } : null;
	}
	async read(path: string) {
		const f = this.files.get(path);
		if (!f) throw new Error(`ENOENT ${path}`);
		return f.data.slice(0);
	}
	async write(path: string, data: ArrayBuffer, mtime: number) {
		this.files.set(path, { data: data.slice(0), mtime: mtime || this.clock.tick() });
	}
	async rename(from: string, to: string) {
		const f = this.files.get(from);
		if (!f) throw new Error(`ENOENT ${from}`);
		this.files.delete(from);
		this.files.set(to, f);
	}
	async trash(path: string) {
		this.files.delete(path);
		this.trashed.push(path);
	}
	async cleanupEmptyFolders() {}
}

export class MemStore implements StateStore {
	state: SyncState | null = null;
	async load() {
		return this.state ? (JSON.parse(JSON.stringify(this.state)) as SyncState) : null;
	}
	async save(s: SyncState) {
		this.state = JSON.parse(JSON.stringify(s));
	}
}

export class Device {
	fs: FakeFs;
	store = new MemStore();
	confirm = async () => true;
	constructor(
		public name: string,
		public drive: FakeDrive,
		public clock: Clock,
		public overrides: Partial<EngineConfig> = {},
	) {
		this.fs = new FakeFs(clock);
	}

	async sync(dryRun = false): Promise<SyncReport> {
		const cfg: EngineConfig = {
			vaultKey: "vault1",
			device: this.name,
			planOptions: {
				strategy: "keepBoth",
				configStrategy: "newer",
				isConfigPath: (p) => p.startsWith(".obsidian/"),
				isMergeableList: (p) => p === ".obsidian/community-plugins.json",
			},
			includes: () => true,
			maxBytes: 1024 * 1024,
			concurrency: 3,
			deletionGuardPercent: 50,
			tombstoneMaxAgeMs: 30 * 86_400_000,
			confirmDeletions: () => this.confirm(),
			log: () => {},
			now: () => this.clock.t,
			...this.overrides,
		};
		this.clock.tick();
		return new SyncEngine(this.fs, this.drive, this.store, cfg).run(dryRun);
	}
}

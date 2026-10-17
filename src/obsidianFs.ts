// Obsidian-backed implementations of the engine's LocalFs and StateStore.
// Regular notes go through the Vault API (keeps editors and the metadata cache
// consistent); the hidden config folder is only reachable through the adapter.

import { App, normalizePath, TFile, TFolder } from "obsidian";
import type { PathFilter } from "./filter";
import type { FileState, OwnWriteTracker } from "./ownWrites";
import type { LocalFs, StateStore } from "./sync/engine";
import type { LocalEntry, SyncState } from "./sync/types";
import { dirname } from "./util";

const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css", "data.json"];

type Stat = { type: string; mtime: number; size: number } | null;

function toState(st: Stat): FileState {
	if (!st) return null;
	return st.type === "folder" ? { kind: "folder" } : { kind: "file", mtime: st.mtime, size: st.size };
}

/** A tracked path and a check that its state after the operation is the one we intended. */
interface Tracked {
	path: string;
	verify: (state: FileState) => boolean;
}

const isGone = (s: FileState) => s === null;

export class ObsidianLocalFs implements LocalFs {
	constructor(
		private app: App,
		private filter: PathFilter,
		private tracker?: OwnWriteTracker,
	) {}

	/**
	 * Runs `op` with its paths marked as in progress, then records each verified
	 * result. Results that do not match the intent (e.g. the user saved at the
	 * same moment) are left unverified, so their events count as user changes.
	 */
	private async track<T>(items: Tracked[], op: () => Promise<T>): Promise<T> {
		this.tracker?.begin(items.map((i) => i.path));
		try {
			return await op();
		} finally {
			for (const item of items) {
				const state = toState(await this.adapter.stat(item.path).catch(() => null));
				this.tracker?.settle(item.path, item.verify(state) ? state : undefined);
			}
		}
	}

	private get adapter() {
		return this.app.vault.adapter;
	}

	private get configDir() {
		return this.app.vault.configDir;
	}

	async list(): Promise<LocalEntry[]> {
		const out: LocalEntry[] = [];
		for (const f of this.app.vault.getFiles()) {
			out.push({ path: f.path, mtime: f.stat.mtime, size: f.stat.size });
		}

		const roots = this.filter.configScanRoots();
		const cd = this.configDir;
		const candidates: string[] = [];
		const listDir = async (dir: string) => ((await this.adapter.exists(dir)) ? await this.adapter.list(dir) : null);

		if (roots.topLevel) {
			const l = await listDir(cd);
			if (l) candidates.push(...l.files);
		}
		if (roots.themes) {
			const l = await listDir(`${cd}/themes`);
			for (const folder of l?.folders ?? []) candidates.push(...((await listDir(folder))?.files ?? []));
		}
		if (roots.snippets) {
			candidates.push(...((await listDir(`${cd}/snippets`))?.files ?? []));
		}
		if (roots.plugins) {
			const l = await listDir(`${cd}/plugins`);
			for (const folder of l?.folders ?? []) {
				for (const name of PLUGIN_FILES) candidates.push(`${folder}/${name}`);
			}
		}
		for (const path of candidates) {
			if (!this.filter.includes(path)) continue;
			const st = await this.adapter.stat(path);
			if (st && st.type === "file") out.push({ path, mtime: st.mtime, size: st.size });
		}
		return out;
	}

	async stat(path: string) {
		const st = await this.adapter.stat(path);
		return st && st.type === "file" ? { mtime: st.mtime, size: st.size } : null;
	}

	read(path: string): Promise<ArrayBuffer> {
		return this.adapter.readBinary(path);
	}

	private async ensureFolder(dir: string) {
		if (!dir) return;
		if (this.filter.isConfigPath(`${dir}/x`) || dir === this.configDir) {
			if (!(await this.adapter.exists(dir))) {
				await this.ensureFolder(dirname(dir));
				await this.adapter.mkdir(dir);
			}
			return;
		}
		const existing = this.app.vault.getAbstractFileByPath(dir);
		if (existing instanceof TFolder) return;
		if (existing) throw new Error(`폴더 위치에 파일이 있습니다: ${dir}`);
		await this.ensureFolder(dirname(dir));
		this.tracker?.folderCreated(dir);
		try {
			await this.app.vault.createFolder(dir);
		} catch (e) {
			// Already exists on disk but not yet indexed.
			if (!(await this.adapter.exists(dir))) throw e;
		}
	}

	async write(path: string, data: ArrayBuffer, mtime: number): Promise<void> {
		path = normalizePath(path);
		await this.ensureFolder(dirname(path));
		const opts = mtime > 0 ? { mtime } : undefined;
		const verify = (s: FileState) => s?.kind === "file" && s.size === data.byteLength && (mtime <= 0 || s.mtime === mtime);
		await this.track([{ path, verify }], async () => {
			if (this.filter.isConfigPath(path)) {
				await this.adapter.writeBinary(path, data, opts);
				return;
			}
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				await this.app.vault.modifyBinary(existing, data, opts);
			} else if (existing) {
				throw new Error(`같은 이름의 폴더가 있습니다: ${path}`);
			} else if (await this.adapter.exists(path)) {
				await this.adapter.writeBinary(path, data, opts);
			} else {
				await this.app.vault.createBinary(path, data, opts);
			}
		});
	}

	async rename(from: string, to: string): Promise<void> {
		await this.ensureFolder(dirname(to));
		// A rename keeps mtime and size.
		const before = toState(await this.adapter.stat(from));
		const intact = (s: FileState) =>
			s?.kind === "file" && before?.kind === "file" && s.mtime === before.mtime && s.size === before.size;
		await this.track([{ path: from, verify: isGone }, { path: to, verify: intact }], async () => {
			const file = this.filter.isConfigPath(from) ? null : this.app.vault.getAbstractFileByPath(from);
			// Vault.rename (not FileManager.renameFile): links were already updated on the other device.
			if (file) await this.app.vault.rename(file, to);
			else await this.adapter.rename(from, to);
		});
	}

	async trash(path: string): Promise<void> {
		await this.track([{ path, verify: isGone }], async () => {
			const file = this.filter.isConfigPath(path) ? null : this.app.vault.getAbstractFileByPath(path);
			if (file) {
				// Respects the user's "deleted files" preference (system trash / .trash / permanent).
				await this.app.fileManager.trashFile(file);
				return;
			}
			if (!(await this.adapter.trashSystem(path))) await this.adapter.trashLocal(path);
		});
	}

	async cleanupEmptyFolders(paths: string[]): Promise<void> {
		const dirs = new Set<string>();
		for (const p of paths) {
			if (this.filter.isConfigPath(p)) continue;
			for (let d = dirname(p); d; d = dirname(d)) dirs.add(d);
		}
		// Deepest first so parents become empty before they are checked.
		for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
			const folder = this.app.vault.getAbstractFileByPath(d);
			if (folder instanceof TFolder && folder.children.length === 0 && !folder.isRoot()) {
				await this.track([{ path: d, verify: isGone }], () => this.app.vault.delete(folder));
			}
		}
	}

	/**
	 * Atomic compare-and-replace for regular text notes via Vault.process: the
	 * new text is only written if the note still holds exactly `expected`.
	 */
	async replaceText(path: string, expected: string, next: string): Promise<"replaced" | "changed" | "unsupported"> {
		const file = this.filter.isConfigPath(path) ? null : this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return "unsupported";
		let replaced = false;
		const size = new TextEncoder().encode(next).byteLength;
		await this.track([{ path, verify: (s) => replaced && s?.kind === "file" && s.size === size }], () =>
			this.app.vault.process(file, (current) => {
				replaced = current === expected;
				return replaced ? next : current;
			}),
		);
		return replaced ? "replaced" : "changed";
	}
}

/**
 * A JSON file next to the plugin (sync state, remote listing cache). Written
 * twice (tmp first) so a crash mid-write always leaves one complete copy behind.
 */
export class JsonFileStore<T> {
	constructor(
		private app: App,
		private path: string,
	) {}

	private async readJson(path: string): Promise<T | null> {
		try {
			if (!(await this.app.vault.adapter.exists(path))) return null;
			return JSON.parse(await this.app.vault.adapter.read(path)) as T;
		} catch {
			return null;
		}
	}

	async load(): Promise<T | null> {
		return (await this.readJson(this.path)) ?? (await this.readJson(`${this.path}.tmp`));
	}

	async save(value: T): Promise<void> {
		const json = JSON.stringify(value);
		await this.app.vault.adapter.write(`${this.path}.tmp`, json);
		await this.app.vault.adapter.write(this.path, json);
	}

	async clear(): Promise<void> {
		for (const p of [this.path, `${this.path}.tmp`]) {
			if (await this.app.vault.adapter.exists(p)) await this.app.vault.adapter.remove(p);
		}
	}
}

export class FileStateStore extends JsonFileStore<SyncState> implements StateStore {}

// Minimal stand-in for the "obsidian" module (aliased in tests/vitest.config.ts),
// plus an in-memory vault that fires events synchronously like Obsidian does.

import type { App as ObsidianApp } from "obsidian";

export class TAbstractFile {
	constructor(public path: string) {}
	get name() {
		return this.path.slice(this.path.lastIndexOf("/") + 1);
	}
}

export class TFile extends TAbstractFile {
	constructor(
		path: string,
		public stat: { mtime: number; size: number; ctime: number },
	) {
		super(path);
	}
}

export class TFolder extends TAbstractFile {
	constructor(
		path: string,
		public children: TAbstractFile[],
	) {
		super(path);
	}
	isRoot() {
		return this.path === "";
	}
}

export class App {}

export function normalizePath(p: string) {
	return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

interface Entry {
	data: ArrayBuffer;
	mtime: number;
}

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(b);

/** In-memory vault. `onEvent` receives the paths of every vault event (new path first for renames). */
export class FakeVault {
	files = new Map<string, Entry>();
	folders = new Set<string>([""]);
	t = 1_000_000;
	configDir = ".obsidian";
	onEvent?: (paths: string[]) => void;
	/** Runs right after Vault.process has written, before the caller continues. */
	afterProcess?: (path: string) => void;
	/** Simulates a text read that strips the BOM and converts CRLF to LF. */
	normalizeOnRead = false;

	tick() {
		return ++this.t;
	}
	text(path: string) {
		const e = this.files.get(path);
		return e ? dec(e.data) : undefined;
	}
	/** The user saves a file in the editor. */
	userWrite(path: string, content: string) {
		this.files.set(path, { data: enc(content), mtime: this.tick() });
		this.onEvent?.([path]);
	}
	/** The user moves a file. */
	userRename(from: string, to: string) {
		const e = this.files.get(from)!;
		this.files.delete(from);
		this.files.set(to, e);
		this.onEvent?.([to, from]);
	}

	private set(path: string, data: ArrayBuffer, mtime?: number) {
		this.files.set(path, { data: data.slice(0), mtime: mtime ?? this.tick() });
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		const e = this.files.get(path);
		if (e) return new TFile(path, { mtime: e.mtime, size: e.data.byteLength, ctime: e.mtime });
		if (this.folders.has(path)) {
			const children = [...this.files.keys(), ...this.folders]
				.filter((p) => p !== path && p.slice(0, p.lastIndexOf("/") === -1 ? 0 : p.lastIndexOf("/")) === path)
				.map((p) => new TAbstractFile(p));
			return new TFolder(path, children);
		}
		return null;
	}
	getFiles() {
		return [...this.files.keys()]
			.filter((p) => !p.startsWith("."))
			.map((p) => this.getAbstractFileByPath(p) as TFile);
	}
	async createFolder(path: string) {
		this.folders.add(path);
		this.onEvent?.([path]);
	}
	async createBinary(path: string, data: ArrayBuffer, opts?: { mtime?: number }) {
		this.set(path, data, opts?.mtime);
		this.onEvent?.([path]);
	}
	async modifyBinary(file: TFile, data: ArrayBuffer, opts?: { mtime?: number }) {
		this.set(file.path, data, opts?.mtime);
		this.onEvent?.([file.path]);
	}
	async process(file: TFile, fn: (data: string) => string) {
		let current = this.text(file.path) ?? "";
		if (this.normalizeOnRead) current = current.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
		const next = fn(current);
		this.set(file.path, enc(next));
		this.onEvent?.([file.path]);
		this.afterProcess?.(file.path);
		return next;
	}
	async rename(file: TAbstractFile, to: string) {
		const e = this.files.get(file.path)!;
		this.files.delete(file.path);
		this.files.set(to, e);
		this.onEvent?.([to, file.path]);
	}
	async delete(file: TAbstractFile) {
		this.files.delete(file.path);
		this.folders.delete(file.path);
		this.onEvent?.([file.path]);
	}

	adapter = {
		stat: async (path: string) => {
			const e = this.files.get(path);
			if (e) return { type: "file", mtime: e.mtime, size: e.data.byteLength, ctime: e.mtime };
			return this.folders.has(path) ? { type: "folder", mtime: 0, size: 0, ctime: 0 } : null;
		},
		exists: async (path: string) => this.files.has(path) || this.folders.has(path),
		readBinary: async (path: string) => {
			const e = this.files.get(path);
			if (!e) throw new Error(`ENOENT ${path}`);
			return e.data.slice(0);
		},
		writeBinary: async (path: string, data: ArrayBuffer, opts?: { mtime?: number }) => this.set(path, data, opts?.mtime),
		mkdir: async (path: string) => void this.folders.add(path),
		rename: async (from: string, to: string) => {
			const e = this.files.get(from)!;
			this.files.delete(from);
			this.files.set(to, e);
		},
		trashSystem: async (path: string) => this.files.delete(path),
		trashLocal: async (path: string) => void this.files.delete(path),
		list: async () => ({ files: [], folders: [] }),
	};

	fileManager = {
		trashFile: async (file: TAbstractFile) => this.delete(file),
	};
}

/** Builds an object shaped like Obsidian's App around a FakeVault. */
export function fakeApp(vault: FakeVault): ObsidianApp {
	return { vault, fileManager: vault.fileManager } as unknown as ObsidianApp;
}

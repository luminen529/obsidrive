export type ConflictStrategy = "keepBoth" | "newer" | "local" | "remote";

export interface LocalEntry {
	path: string;
	mtime: number;
	size: number;
	/** Filled in before planning when it cannot be inferred from the base state. */
	hash?: string;
}

export interface RemoteEntry {
	path: string;
	id: string;
	/** sha256 of the content, "" if unknown. */
	hash: string;
	/** mtime of the source file when it was uploaded. */
	mtime: number;
	size: number;
	deleted: boolean;
	deletedAt: number;
	modifiedTime: number;
	device: string;
}

/** What both sides looked like right after the last successful sync of a path. */
export interface BaseEntry {
	/** sha256 of the content (identical locally and remotely at that point). */
	h: string;
	/** local mtime / size observed after the sync. */
	lm: number;
	ls: number;
	/** Drive file id. */
	rid: string;
}

export interface SyncState {
	version: 1;
	vaultKey: string;
	lastSync: number;
	files: Record<string, BaseEntry>;
}

export type Action =
	| { kind: "upload"; path: string; remoteId?: string; reason: string }
	| { kind: "download"; path: string; remote: RemoteEntry; reason: string }
	| { kind: "deleteLocal"; path: string }
	| { kind: "deleteRemote"; path: string; remoteId: string }
	| { kind: "renameRemote"; from: string; to: string; remoteId: string }
	| { kind: "renameLocal"; from: string; to: string; remote: RemoteEntry }
	| { kind: "conflict"; path: string; remote: RemoteEntry; resolution: "keepBoth" | "useLocal" | "useRemote" | "mergeList" }
	| { kind: "record"; path: string; base: BaseEntry }
	| { kind: "forget"; path: string };

export type RemoteFix =
	| { kind: "removeRemote"; id: string; path: string; why: string }
	| { kind: "renameRemoteDuplicate"; id: string; from: string; to: string };

export interface SyncReport {
	startedAt: number;
	finishedAt: number;
	dryRun: boolean;
	uploaded: string[];
	downloaded: string[];
	deletedLocal: string[];
	deletedRemote: string[];
	renamed: string[];
	conflicts: string[];
	skipped: { path: string; reason: string }[];
	errors: { path: string; message: string }[];
	configChanged: boolean;
	aborted?: string;
	plan?: Action[];
}

export function emptyReport(dryRun: boolean): SyncReport {
	return {
		startedAt: Date.now(),
		finishedAt: 0,
		dryRun,
		uploaded: [],
		downloaded: [],
		deletedLocal: [],
		deletedRemote: [],
		renamed: [],
		conflicts: [],
		skipped: [],
		errors: [],
		configChanged: false,
	};
}

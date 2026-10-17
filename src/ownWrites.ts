// Tells vault events caused by the sync's own writes apart from user edits.
// Must not import "obsidian" so it can be unit tested.
//
// Each path the sync touches gets an expected state. An event counts as ours
// only if the file is still exactly in that state. Events that arrive while a
// write is still in progress are deferred and judged once the write settles;
// if the result cannot be shown to be what we intended, it counts as a change.

export type FileState = { kind: "file"; mtime: number; size: number } | { kind: "folder" } | null;

type Expectation = { mtime: number; size: number } | null | "folder" | "pending";

export class OwnWriteTracker {
	private expected = new Map<string, Expectation>();
	private deferred = new Set<string>();

	constructor(
		/** Current state of a path as the vault sees it. */
		private current: (path: string) => FileState,
		/** Called when an event turns out to be a user change. */
		private onChange: () => void,
	) {}

	/** A write/rename/delete of these paths is about to start. */
	begin(paths: string[]) {
		for (const p of paths) this.expected.set(p, "pending");
	}

	/**
	 * The operation finished. `state` is the verified result we intended, or
	 * undefined if it could not be verified (then later events count as changes).
	 */
	settle(path: string, state: FileState | undefined) {
		if (state === undefined) this.expected.delete(path);
		else if (state === null) this.expected.set(path, null);
		else if (state.kind === "folder") this.expected.set(path, "folder");
		else this.expected.set(path, { mtime: state.mtime, size: state.size });

		if (this.deferred.delete(path) && !this.isOwn(path)) this.onChange();
	}

	folderCreated(path: string) {
		this.expected.set(path, "folder");
	}

	/** Classifies a vault event touching `paths` (one path, or new + old path for renames). */
	onEvent(paths: string[]) {
		if (paths.some((p) => this.expected.get(p) === "pending")) {
			for (const p of paths) this.deferred.add(p);
			return;
		}
		if (!paths.every((p) => this.isOwn(p))) this.onChange();
	}

	private isOwn(path: string): boolean {
		const e = this.expected.get(path);
		if (e === undefined || e === "pending") return false;
		const cur = this.current(path);
		if (e === null) return cur === null;
		if (e === "folder") return cur?.kind === "folder";
		return cur?.kind === "file" && cur.mtime === e.mtime && cur.size === e.size;
	}
}

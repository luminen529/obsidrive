// Pure three-way sync planner: (local, remote, base) -> actions.
// No I/O here so every rule is unit-testable.
//
// Safety invariants:
//  * Deletions are only ever derived from the base state. With no base entry a
//    path can only be uploaded, downloaded or recorded – never deleted.
//  * A modification always beats a deletion on the other side.
//  * Concurrent different edits never silently overwrite unless the user chose
//    a non-"keepBoth" strategy.

import { conflictPath } from "../util";
import type { Action, BaseEntry, ConflictStrategy, LocalEntry, RemoteEntry, RemoteExpect, RemoteFix } from "./types";

export function expectOf(r: RemoteEntry): RemoteExpect {
	return { id: r.id, path: r.path, hash: r.hash, deleted: r.deleted, deletedAt: r.deletedAt };
}

export function knownLocalHash(l: LocalEntry, b: BaseEntry | undefined): string | undefined {
	if (l.hash) return l.hash;
	if (b && l.mtime === b.lm && l.size === b.ls) return b.h;
	return undefined;
}

export interface PlanOptions {
	strategy: ConflictStrategy;
	/** Strategy for files inside the config folder (conflict copies there are useless). */
	configStrategy: Exclude<ConflictStrategy, "keepBoth">;
	isConfigPath: (path: string) => boolean;
}

type Side = "absent" | "same" | "changed" | "new";

export function plan(
	local: Map<string, LocalEntry>,
	remote: Map<string, RemoteEntry>,
	base: Record<string, BaseEntry>,
	opts: PlanOptions,
): Action[] {
	const paths = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(base)]);
	const actions: Action[] = [];

	for (const path of [...paths].sort()) {
		const l = local.get(path);
		const r = remote.get(path);
		const b = base[path];
		const rLive = r && !r.deleted ? r : undefined;
		const lHash = l ? knownLocalHash(l, b) : undefined;
		if (l && lHash === undefined) throw new Error(`planner: missing local hash for ${path}`);

		const ls: Side = !l ? "absent" : !b ? "new" : lHash === b.h ? "same" : "changed";
		const rs: Side = !rLive ? "absent" : !b ? "new" : rLive.hash === b.h ? "same" : "changed";

		const record = () => {
			actions.push({ kind: "record", path, base: { h: lHash!, lm: l!.mtime, ls: l!.size, rid: rLive!.id } });
		};
		const upload = (reason: string) => actions.push({ kind: "upload", path, remote: r ? expectOf(r) : undefined, reason });
		const download = (reason: string) => actions.push({ kind: "download", path, remote: rLive!, reason });

		// Identical content on both sides: nothing to transfer, just remember it.
		if (l && rLive && lHash === rLive.hash) {
			if (!b || b.h !== lHash || b.lm !== l.mtime || b.ls !== l.size || b.rid !== rLive.id) record();
			continue;
		}

		switch (`${ls}/${rs}`) {
			case "same/same":
				break;
			case "same/changed":
			case "absent/new":
				download(ls === "absent" ? "new remote file" : "changed remotely");
				break;
			case "absent/changed":
				download("changed remotely, deleted locally (modification wins)");
				break;
			case "same/absent":
				actions.push({ kind: "deleteLocal", path });
				break;
			case "changed/same":
			case "new/absent":
				upload(ls === "new" ? "new local file" : "changed locally");
				break;
			case "changed/absent":
				upload("changed locally, deleted remotely (modification wins)");
				break;
			case "absent/same":
				actions.push({ kind: "deleteRemote", path, remoteId: rLive!.id });
				break;
			case "absent/absent":
				if (b) actions.push({ kind: "forget", path });
				break;
			case "changed/changed":
			case "new/new":
				actions.push(resolveConflict(path, l!, rLive!, b, opts));
				break;
			default:
				throw new Error(`planner: unexpected state ${ls}/${rs} for ${path}`);
		}
	}

	return detectRenames(actions, local, base, opts);
}

function resolveConflict(
	path: string,
	l: LocalEntry,
	r: RemoteEntry,
	b: BaseEntry | undefined,
	opts: PlanOptions,
): Action {
	const isConfig = opts.isConfigPath(path);
	if (isConfig && !b) {
		// First contact (e.g. a freshly created vault): the remote holds the established
		// settings, while local files are just Obsidian's defaults – which would otherwise
		// look "newer".
		return { kind: "conflict", path, remote: r, resolution: "useRemote" };
	}
	const strategy = isConfig ? opts.configStrategy : opts.strategy;
	let resolution: "keepBoth" | "useLocal" | "useRemote";
	switch (strategy) {
		case "keepBoth":
			resolution = "keepBoth";
			break;
		case "local":
			resolution = "useLocal";
			break;
		case "remote":
			resolution = "useRemote";
			break;
		case "newer":
			resolution = l.mtime > r.mtime ? "useLocal" : "useRemote";
			break;
	}
	return { kind: "conflict", path, remote: r, resolution };
}

/**
 * Turns "delete A + create B" with identical content into a rename, so moving a
 * large attachment does not re-transfer it. Applied in both directions.
 */
function detectRenames(
	actions: Action[],
	local: Map<string, LocalEntry>,
	base: Record<string, BaseEntry>,
	opts: PlanOptions,
): Action[] {
	const remoteDeletes = new Map<string, Action & { kind: "deleteRemote" }>();
	const localDeletes = new Map<string, Action & { kind: "deleteLocal" }>();
	for (const a of actions) {
		if (a.kind === "deleteRemote" && !opts.isConfigPath(a.path)) {
			const h = base[a.path]?.h;
			if (h && !remoteDeletes.has(h)) remoteDeletes.set(h, a);
		}
		if (a.kind === "deleteLocal" && !opts.isConfigPath(a.path)) {
			const h = base[a.path]?.h;
			if (h && !localDeletes.has(h)) localDeletes.set(h, a);
		}
	}
	if (remoteDeletes.size === 0 && localDeletes.size === 0) return actions;

	const drop = new Set<Action>();
	const extra: Action[] = [];
	for (const a of actions) {
		if (a.kind === "upload" && !a.remote && !opts.isConfigPath(a.path)) {
			const h = local.get(a.path)?.hash;
			const del = h ? remoteDeletes.get(h) : undefined;
			if (del && !drop.has(del)) {
				drop.add(del).add(a);
				extra.push({ kind: "renameRemote", from: del.path, to: a.path, remoteId: del.remoteId });
			}
		}
		if (a.kind === "download" && !local.has(a.path) && !base[a.path] && !opts.isConfigPath(a.path)) {
			const del = localDeletes.get(a.remote.hash);
			if (del && !drop.has(del)) {
				drop.add(del).add(a);
				extra.push({ kind: "renameLocal", from: del.path, to: a.path, remote: a.remote });
			}
		}
	}
	return [...extra, ...actions.filter((a) => !drop.has(a))];
}

/**
 * Cleans up the remote listing before planning:
 *  * several live files with one path (two devices created it concurrently):
 *    identical copies are removed, different ones are renamed to conflict copies;
 *  * tombstones next to a live file, duplicate tombstones and expired tombstones are removed.
 */
export function normalizeRemote(
	entries: RemoteEntry[],
	base: Record<string, BaseEntry>,
	now: number,
	tombstoneMaxAgeMs: number,
): { remote: Map<string, RemoteEntry>; fixes: RemoteFix[] } {
	const byPath = new Map<string, RemoteEntry[]>();
	for (const e of entries) {
		const list = byPath.get(e.path);
		if (list) list.push(e);
		else byPath.set(e.path, [e]);
	}

	const remote = new Map<string, RemoteEntry>();
	const fixes: RemoteFix[] = [];
	const taken = new Set(byPath.keys());

	for (const [path, list] of byPath) {
		const live = list.filter((e) => !e.deleted);
		const tombs = list.filter((e) => e.deleted).sort((a, b) => b.deletedAt - a.deletedAt);

		if (live.length > 0) {
			for (const t of tombs) fixes.push({ kind: "removeRemote", expect: expectOf(t), path, why: "tombstone superseded" });
			const rid = base[path]?.rid;
			live.sort((a, b) => b.modifiedTime - a.modifiedTime);
			const canonical = live.find((e) => e.id === rid) ?? live[0];
			remote.set(path, canonical);
			for (const dup of live) {
				if (dup === canonical) continue;
				if (dup.hash && dup.hash === canonical.hash) {
					fixes.push({ kind: "removeRemote", expect: expectOf(dup), path, why: "identical duplicate" });
					continue;
				}
				let to = conflictPath(path, dup.device || "remote", dup.modifiedTime || now);
				for (let n = 2; taken.has(to); n++) to = conflictPath(path, `${dup.device || "remote"} ${n}`, dup.modifiedTime || now);
				taken.add(to);
				fixes.push({ kind: "renameRemoteDuplicate", expect: expectOf(dup), from: path, to });
				remote.set(to, { ...dup, path: to });
			}
			continue;
		}

		const [newest, ...older] = tombs;
		for (const t of older) fixes.push({ kind: "removeRemote", expect: expectOf(t), path, why: "duplicate tombstone" });
		if (newest.deletedAt && now - newest.deletedAt > tombstoneMaxAgeMs) {
			fixes.push({ kind: "removeRemote", expect: expectOf(newest), path, why: "tombstone expired" });
			continue;
		}
		remote.set(path, newest);
	}
	return { remote, fixes };
}

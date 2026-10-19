// Executes a sync run: scan -> list remote -> normalize -> plan -> guard -> apply.
// All I/O goes through the small interfaces below so the engine can be tested
// end-to-end with in-memory fakes.

import type { AppProps, RemoteFile } from "../drive";
import { PROP_DELETED, PROP_DEVICE, PROP_HASH, PROP_MTIME, PROP_VAULT } from "../drive";
import { conflictPath, errorMessage, runPool, sha256Hex } from "../util";
import { expectOf, knownLocalHash, normalizeRemote, plan, PlanOptions } from "./planner";
import { Action, BaseEntry, emptyReport, LocalEntry, RemoteEntry, RemoteExpect, SyncReport, SyncState } from "./types";

export interface LocalFs {
	/** Every candidate local file (the engine applies the path filter). */
	list(): Promise<LocalEntry[]>;
	stat(path: string): Promise<{ mtime: number; size: number } | null>;
	read(path: string): Promise<ArrayBuffer>;
	/** Creates parent folders as needed; overwrites an existing file. */
	write(path: string, data: ArrayBuffer, mtime: number): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** Moves a file to the trash according to the user's preference. */
	trash(path: string): Promise<void>;
	/** Removes folders left empty after deletions/renames (best effort). */
	cleanupEmptyFolders(paths: string[]): Promise<void>;
	/**
	 * Optional atomic compare-and-replace for text notes: writes `next` only if the
	 * file still holds exactly `expected`.
	 */
	replaceText?(path: string, expected: string, next: string): Promise<"replaced" | "changed" | "unsupported">;
}

/** Regular notes that can be replaced atomically as text. */
const TEXT_NOTE = /\.(md|canvas|base|txt)$/i;

function decodeUtf8Strict(data: ArrayBuffer): string | null {
	try {
		// ignoreBOM keeps a BOM in the string, so re-encoding gives back identical bytes.
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
	} catch {
		return null;
	}
}

export interface RemoteStore {
	listVault(vaultKey: string): Promise<RemoteFile[]>;
	getMeta(id: string): Promise<RemoteFile | null>;
	download(id: string): Promise<ArrayBuffer>;
	create(name: string, appProperties: AppProps, data: ArrayBuffer): Promise<RemoteFile>;
	updateContent(id: string, meta: { name?: string; appProperties: AppProps }, data: ArrayBuffer): Promise<RemoteFile>;
	updateMeta(id: string, meta: { name?: string; appProperties?: AppProps }): Promise<RemoteFile>;
	remove(id: string): Promise<void>;
}

export interface StateStore {
	load(): Promise<SyncState | null>;
	save(state: SyncState): Promise<void>;
}

export interface EngineConfig {
	vaultKey: string;
	device: string;
	planOptions: PlanOptions;
	includes: (path: string) => boolean;
	maxBytes: number;
	concurrency: number;
	deletionGuardPercent: number;
	tombstoneMaxAgeMs: number;
	/** Asked before applying a plan that deletes an unusual number of files. */
	confirmDeletions: (summary: { local: string[]; remote: string[]; tracked: number }) => Promise<boolean>;
	log: (msg: string) => void;
	onProgress?: (done: number, total: number) => void;
	isCancelled?: () => boolean;
	now?: () => number;
}

export function toRemoteEntry(f: RemoteFile): RemoteEntry {
	const p = f.appProperties;
	return {
		path: f.name,
		id: f.id,
		hash: p[PROP_HASH] ?? "",
		mtime: Number(p[PROP_MTIME] ?? 0) || f.modifiedTime,
		size: f.size,
		deleted: !!p[PROP_DELETED],
		deletedAt: Number(p[PROP_DELETED] ?? 0),
		modifiedTime: f.modifiedTime,
		device: p[PROP_DEVICE] ?? "",
	};
}

class SkipError extends Error {}

export class SyncEngine {
	private state!: SyncState;
	private dirty = 0;
	private lastSave = 0;

	constructor(
		private local: LocalFs,
		private remote: RemoteStore,
		private store: StateStore,
		private cfg: EngineConfig,
	) {}

	private now() {
		return this.cfg.now ? this.cfg.now() : Date.now();
	}

	async run(dryRun = false): Promise<SyncReport> {
		const report = emptyReport(dryRun);
		const { cfg } = this;
		try {
			await this.loadState();

			cfg.log("로컬 파일 검색 중…");
			const localList = (await this.local.list()).filter((e) => cfg.includes(e.path));
			cfg.log(`로컬 ${localList.length}개`);

			cfg.log("원격 목록 가져오는 중…");
			const remoteRaw = (await this.remote.listVault(cfg.vaultKey))
				.map(toRemoteEntry)
				.filter((e) => cfg.includes(e.path));
			const { remote, fixes } = normalizeRemote(remoteRaw, this.state.files, this.now(), cfg.tombstoneMaxAgeMs);
			cfg.log(`원격 ${[...remote.values()].filter((r) => !r.deleted).length}개 (정리 작업 ${fixes.length}건)`);

			if (!dryRun && fixes.length) {
				for (const fix of fixes) {
					// Another device may have restored or edited the file since we listed it.
					// The rest of the plan assumes these fixes happened, so on any doubt stop the run.
					const st = await this.checkRemote(fix.expect);
					if (st === "mismatch" || (st === "gone" && fix.kind === "renameRemoteDuplicate")) {
						throw new Error("원격 파일이 정리 도중 변경되었습니다. 이번 동기화를 중단하고 다음에 다시 시도합니다.");
					}
					if (st === "gone") continue;
					if (fix.kind === "removeRemote") {
						cfg.log(`원격 정리: ${fix.path} (${fix.why})`);
						await this.remote.remove(fix.expect.id);
					} else {
						cfg.log(`원격 중복 → 충돌 사본: ${fix.from} → ${fix.to}`);
						await this.remote.updateMeta(fix.expect.id, { name: fix.to });
					}
				}
			}

			// Size limit, applied symmetrically: a path too large on either side is ignored everywhere.
			const tooLarge = new Set<string>();
			for (const l of localList) if (l.size > cfg.maxBytes) tooLarge.add(l.path);
			for (const r of remote.values()) if (!r.deleted && r.size > cfg.maxBytes) tooLarge.add(r.path);
			for (const p of tooLarge) report.skipped.push({ path: p, reason: "파일 크기 제한 초과" });

			const local = new Map<string, LocalEntry>();
			for (const l of localList) if (!tooLarge.has(l.path)) local.set(l.path, l);
			for (const p of tooLarge) remote.delete(p);
			const base: Record<string, BaseEntry> = {};
			for (const [p, b] of Object.entries(this.state.files)) {
				if (cfg.includes(p) && !tooLarge.has(p)) base[p] = b;
			}

			await this.hashLocal(local, base, report);
			// Unreadable files are left out entirely this round (never treated as deleted).
			for (const s of report.skipped) {
				local.delete(s.path);
				remote.delete(s.path);
				delete base[s.path];
			}

			const actions = plan(local, remote, base, cfg.planOptions);
			report.plan = actions;
			const deletesLocal = actions.filter((a) => a.kind === "deleteLocal").map((a) => (a as { path: string }).path);
			const deletesRemote = actions.filter((a) => a.kind === "deleteRemote").map((a) => (a as { path: string }).path);
			const tracked = Math.max(Object.keys(base).length, 1);
			const deletions = deletesLocal.length + deletesRemote.length;

			if (dryRun) return report;

			if (deletions > 5 && (deletions / tracked) * 100 > cfg.deletionGuardPercent) {
				const ok = await cfg.confirmDeletions({ local: deletesLocal, remote: deletesRemote, tracked });
				if (!ok) {
					report.aborted = `삭제 보호: ${deletions}개 파일(${Math.round((deletions / tracked) * 100)}%)이 삭제될 예정이라 동기화를 중단했습니다.`;
					return report;
				}
			}

			await this.apply(actions, local, report);
			if (cfg.isCancelled?.()) {
				// Work already done is recorded in the base state, but the run is not a completed sync.
				report.aborted = "사용자가 동기화를 취소했습니다.";
				return report;
			}
			// Only touch the disk when something changed (or the very first time).
			if (this.dirty || !this.state.lastSync) {
				this.state.lastSync = this.now();
				await this.saveState(true);
			}
		} catch (e) {
			report.aborted = errorMessage(e);
			throw Object.assign(e instanceof Error ? e : new Error(String(e)), { report });
		} finally {
			report.finishedAt = Date.now();
			if (this.state && this.dirty) await this.saveState(true).catch(() => {});
		}
		return report;
	}

	private async loadState() {
		const s = await this.store.load();
		if (s && s.version === 1 && s.vaultKey === this.cfg.vaultKey) this.state = s;
		else {
			// Unknown or different remote vault: start without a base. This can never
			// cause deletions (see planner invariants), only uploads/downloads/conflicts.
			this.state = { version: 1, vaultKey: this.cfg.vaultKey, lastSync: 0, files: {} };
		}
	}

	private async saveState(force = false) {
		if (!force && (this.dirty < 25 || Date.now() - this.lastSave < 3000)) return;
		this.dirty = 0;
		this.lastSave = Date.now();
		await this.store.save(this.state);
	}

	private setBase(path: string, b: BaseEntry | null) {
		if (b) this.state.files[path] = b;
		else delete this.state.files[path];
		this.dirty++;
	}

	private async hashLocal(local: Map<string, LocalEntry>, base: Record<string, BaseEntry>, report: SyncReport) {
		const todo = [...local.values()].filter((l) => knownLocalHash(l, base[l.path]) === undefined);
		if (todo.length) this.cfg.log(`변경 확인을 위해 ${todo.length}개 파일 해시 계산 중…`);
		await runPool(todo, this.cfg.concurrency, async (l) => {
			try {
				// Hash and stat from the same stable read, so they describe one version.
				const cur = await this.readStable(l.path);
				l.hash = cur.hash;
				l.mtime = cur.mtime;
				l.size = cur.size;
			} catch (e) {
				report.skipped.push({ path: l.path, reason: `읽기 실패: ${errorMessage(e)}` });
			}
		});
	}

	private props(hash: string, mtime: number): AppProps {
		return {
			[PROP_VAULT]: this.cfg.vaultKey,
			[PROP_HASH]: hash,
			[PROP_MTIME]: String(mtime),
			[PROP_DEVICE]: this.cfg.device.slice(0, 30),
			[PROP_DELETED]: null,
		};
	}

	/** Reads a file and makes sure it did not change while reading. */
	private async readStable(path: string): Promise<{ data: ArrayBuffer; hash: string; mtime: number; size: number }> {
		for (let i = 0; i < 3; i++) {
			const s1 = await this.local.stat(path);
			if (!s1) throw new SkipError("로컬 파일이 사라짐");
			const data = await this.local.read(path);
			const s2 = await this.local.stat(path);
			if (s2 && s2.mtime === s1.mtime && s2.size === s1.size && data.byteLength === s2.size) {
				return { data, hash: await sha256Hex(data), mtime: s2.mtime, size: s2.size };
			}
		}
		throw new SkipError("파일이 계속 수정되는 중");
	}

	/** True if the local file is still exactly what the planner saw. */
	private async unchangedSincePlan(path: string, seen: LocalEntry | undefined): Promise<boolean> {
		const s = await this.local.stat(path);
		if (!seen) return s === null;
		return !!s && s.mtime === seen.mtime && s.size === seen.size;
	}

	private async downloadVerified(r: RemoteEntry): Promise<{ data: ArrayBuffer; hash: string }> {
		for (let attempt = 0; ; attempt++) {
			const data = await this.remote.download(r.id);
			const hash = await sha256Hex(data);
			if (!r.hash || hash === r.hash) return { data, hash };
			if (attempt >= 1) throw new Error("다운로드한 내용의 해시가 일치하지 않습니다 (원격 파일이 변경 중일 수 있음)");
		}
	}

	/**
	 * Writes downloaded content, re-checking the local file right before the write:
	 * the download may have taken a while and the user may have kept typing.
	 * `seen` is the local state the plan was based on (undefined = file did not exist).
	 */
	private async writeAndRecord(path: string, r: RemoteEntry, data: ArrayBuffer, hash: string, seen: LocalEntry | undefined) {
		if (!(await this.unchangedSincePlan(path, seen))) {
			throw new SkipError("다운로드하는 동안 로컬 파일이 수정됨 — 덮어쓰지 않음 (다음 동기화에서 충돌로 처리)");
		}
		const mtime = r.mtime || r.modifiedTime;
		if (await this.tryReplaceText(path, r, data, hash, seen)) return;
		await this.local.write(path, data, mtime);
		const st = await this.verifiedState(path, hash, data.byteLength, mtime);
		this.setBase(path, this.baseFor(hash, st, r.id));
		if (!r.hash) await this.remote.updateMeta(r.id, { appProperties: { [PROP_HASH]: hash } });
	}

	/**
	 * For an existing text note, replaces its content atomically (Vault.process) only
	 * if it still holds the version the plan was based on. Returns false when not
	 * applicable, so the caller falls back to a normal write.
	 */
	private async tryReplaceText(path: string, r: RemoteEntry, data: ArrayBuffer, hash: string, seen: LocalEntry | undefined) {
		if (!seen || !this.local.replaceText || !TEXT_NOTE.test(path) || this.cfg.planOptions.isConfigPath(path)) return false;
		const planned = knownLocalHash(seen, this.state.files[path]);
		const next = decodeUtf8Strict(data);
		if (!planned || next === null) return false;
		const cur = await this.readStable(path);
		if (cur.hash !== planned) throw new SkipError("다운로드하는 동안 로컬 파일이 수정됨 — 덮어쓰지 않음 (다음 동기화에서 충돌로 처리)");
		const curText = decodeUtf8Strict(cur.data);
		if (curText === null) return false;
		const res = await this.local.replaceText(path, curText, next);
		if (res === "unsupported") return false;
		if (res === "changed") {
			// Either the user just edited it, or Obsidian's text read normalizes this file
			// (e.g. BOM/line endings) so the comparison can never match. Tell them apart by bytes.
			const again = await this.readStable(path);
			if (again.hash === planned) return false; // bytes untouched: use the guarded binary write
			throw new SkipError("쓰기 직전에 로컬 파일이 수정됨 — 덮어쓰지 않음 (다음 동기화에서 충돌로 처리)");
		}
		const st = await this.verifiedState(path, hash, data.byteLength, -1);
		this.setBase(path, this.baseFor(hash, st, r.id));
		if (!r.hash) await this.remote.updateMeta(r.id, { appProperties: { [PROP_HASH]: hash } });
		return true;
	}

	/**
	 * The stat that belongs to content `hash`, or null if that cannot be shown
	 * (e.g. the user saved right after our write). Never pairs a hash with the
	 * stat of a different version.
	 */
	private async verifiedState(path: string, hash: string, size: number, mtime: number): Promise<{ mtime: number; size: number } | null> {
		const st = await this.local.stat(path);
		if (st && st.size === size && st.mtime === mtime) return st; // exactly what we wrote
		try {
			const now = await this.readStable(path);
			return now.hash === hash ? { mtime: now.mtime, size: now.size } : null;
		} catch {
			return null;
		}
	}

	/** Base entry; an unknown stat forces a re-hash next time, so a newer local edit is never mistaken as synced. */
	private baseFor(hash: string, st: { mtime: number; size: number } | null, rid: string): BaseEntry {
		return { h: hash, lm: st ? st.mtime : -1, ls: st ? st.size : -1, rid };
	}

	/**
	 * Optimistic concurrency for remote writes: re-reads the remote file and checks it
	 * still has the content the plan was based on. Drive has no conditional writes,
	 * so a very small window remains between this check and the write.
	 */
	private async remoteState(remoteId: string, expectPath: string, expectHash: string): Promise<"same" | "changed" | "deleted" | "gone"> {
		const meta = await this.remote.getMeta(remoteId);
		if (!meta) return "gone";
		// Renamed by another device: it is a different file now, never act on it under the old path.
		if (meta.name !== expectPath) return "changed";
		if (meta.appProperties[PROP_DELETED]) return "deleted";
		return (meta.appProperties[PROP_HASH] ?? "") === expectHash ? "same" : "changed";
	}

	/** Re-reads the remote file and compares name, content and deletion state with what the plan saw. */
	private async checkRemote(expect: RemoteExpect): Promise<"match" | "gone" | "mismatch"> {
		const meta = await this.remote.getMeta(expect.id);
		if (!meta) return "gone";
		const p = meta.appProperties;
		const deleted = !!p[PROP_DELETED];
		const same =
			meta.name === expect.path &&
			(p[PROP_HASH] ?? "") === expect.hash &&
			deleted === expect.deleted &&
			(!deleted || Number(p[PROP_DELETED]) === expect.deletedAt);
		return same ? "match" : "mismatch";
	}

	/** `expect` is the remote file the plan saw at this path (live or tombstone), if any. */
	private async doUpload(path: string, expect: RemoteExpect | undefined, name?: string) {
		const { data, hash, mtime, size } = await this.readStable(path);
		let f: RemoteFile;
		let remoteId = expect?.id;
		if (expect) {
			// Also covers reviving a tombstone: if another device restored or edited it meanwhile, stop.
			const st = await this.checkRemote(expect);
			if (st === "mismatch") throw new SkipError("원격 파일이 동기화 도중 변경됨 (다음 동기화에서 처리)");
			if (st === "gone") remoteId = undefined;
		}
		if (remoteId) f = await this.remote.updateContent(remoteId, { name: name ?? path, appProperties: this.props(hash, mtime) }, data);
		else f = await this.remote.create(name ?? path, this.props(hash, mtime), data);
		this.setBase(path, { h: hash, lm: mtime, ls: size, rid: f.id });
	}

	private async apply(actions: Action[], local: Map<string, LocalEntry>, report: SyncReport) {
		const { cfg } = this;
		const touchedFolders: string[] = [];
		const isConfig = cfg.planOptions.isConfigPath;
		// Paths present locally, compared case-insensitively to avoid clobbering on Windows/macOS/Android.
		const lowerLocal = new Map<string, string>();
		for (const p of local.keys()) lowerLocal.set(p.toLowerCase(), p);
		const caseClash = (path: string) => {
			const other = lowerLocal.get(path.toLowerCase());
			return other !== undefined && other !== path;
		};

		const transferKinds = new Set(["upload", "download", "conflict"]);
		const phases: Action[][] = [
			actions.filter((a) => a.kind === "record" || a.kind === "forget"),
			actions.filter((a) => a.kind === "renameRemote" || a.kind === "renameLocal"),
			actions.filter((a) => transferKinds.has(a.kind)),
			actions.filter((a) => a.kind === "deleteLocal" || a.kind === "deleteRemote"),
		];
		const total = phases.reduce((n, p) => n + p.length, 0);
		let done = 0;

		const exec = async (a: Action) => {
			const path = a.kind === "renameLocal" || a.kind === "renameRemote" ? a.to : a.path;
			try {
				switch (a.kind) {
					case "record":
						this.setBase(a.path, a.base);
						break;
					case "forget":
						this.setBase(a.path, null);
						break;
					case "upload": {
						await this.doUpload(a.path, a.remote);
						report.uploaded.push(a.path);
						cfg.log(`↑ ${a.path} (${a.reason})`);
						break;
					}
					case "download": {
						if (caseClash(a.path)) throw new SkipError("대소문자만 다른 파일이 이미 있음 — 둘 중 하나의 이름을 바꿔주세요");
						if (!(await this.unchangedSincePlan(a.path, local.get(a.path)))) {
							throw new SkipError("로컬 파일이 동기화 도중 변경됨 (다음 동기화에서 처리)");
						}
						const { data, hash } = await this.downloadVerified(a.remote);
						await this.writeAndRecord(a.path, a.remote, data, hash, local.get(a.path));
						report.downloaded.push(a.path);
						if (isConfig(a.path)) report.configChanged = true;
						cfg.log(`↓ ${a.path} (${a.reason})`);
						break;
					}
					case "deleteLocal": {
						if (!(await this.unchangedSincePlan(a.path, local.get(a.path)))) {
							throw new SkipError("로컬 파일이 동기화 도중 변경됨");
						}
						await this.local.trash(a.path);
						this.setBase(a.path, null);
						touchedFolders.push(a.path);
						report.deletedLocal.push(a.path);
						if (isConfig(a.path)) report.configChanged = true;
						cfg.log(`🗑 로컬 삭제(휴지통): ${a.path}`);
						break;
					}
					case "deleteRemote": {
						// A newer edit from another device must win over this deletion.
						const st = await this.remoteState(a.remoteId, a.path, this.state.files[a.path]?.h ?? "");
						if (st === "changed") {
							throw new SkipError("다른 기기에서 수정되어 원격 삭제를 취소함 (다음 동기화에서 다운로드)");
						}
						if (st === "gone" || st === "deleted") {
							this.setBase(a.path, null);
							cfg.log(`원격에서 이미 삭제됨: ${a.path}`);
							break;
						}
						// Soft delete: keep the content as a tombstone so it can be restored.
						await this.remote.updateMeta(a.remoteId, {
							appProperties: { [PROP_DELETED]: String(this.now()), [PROP_DEVICE]: cfg.device.slice(0, 30) },
						});
						this.setBase(a.path, null);
						report.deletedRemote.push(a.path);
						cfg.log(`🗑 원격 삭제(보관): ${a.path}`);
						break;
					}
					case "renameRemote": {
						const l = local.get(a.to);
						if (!l?.hash) throw new SkipError("이름 변경 대상 해시 없음");
						// The rename only makes sense if the remote still holds this exact content.
						const st = await this.remoteState(a.remoteId, a.from, l.hash);
						if (st !== "same") {
							throw new SkipError("원격 파일이 동기화 도중 변경되어 이름 변경을 건너뜀 (다음 동기화에서 처리)");
						}
						// Only the name changes; the content hash stays as the remote recorded it.
						await this.remote.updateMeta(a.remoteId, {
							name: a.to,
							appProperties: { [PROP_DEVICE]: cfg.device.slice(0, 30) },
						});
						this.setBase(a.from, null);
						this.setBase(a.to, { h: l.hash, lm: l.mtime, ls: l.size, rid: a.remoteId });
						report.renamed.push(`${a.from} → ${a.to}`);
						cfg.log(`↑ 이름 변경: ${a.from} → ${a.to}`);
						break;
					}
					case "renameLocal": {
						// Case-only renames ("Note.md" -> "note.md") look like a clash on case-insensitive disks.
						const caseOnly = a.from.toLowerCase() === a.to.toLowerCase();
						if (!caseOnly && (caseClash(a.to) || (await this.local.stat(a.to)))) {
							throw new SkipError("이름 변경 대상 경로가 이미 있음");
						}
						if (!(await this.unchangedSincePlan(a.from, local.get(a.from)))) {
							throw new SkipError("로컬 파일이 동기화 도중 변경됨");
						}
						if (caseOnly) {
							const tmp = `${a.from}.obsidrive-tmp`;
							await this.local.rename(a.from, tmp);
							await this.local.rename(tmp, a.to);
						} else {
							await this.local.rename(a.from, a.to);
						}
						const st = await this.local.stat(a.to);
						if (!st) throw new Error("이름 변경 후 파일을 찾을 수 없음");
						// A rename keeps mtime/size; anything else means the user already edited it.
						const seen = local.get(a.from)!;
						const intact = st.mtime === seen.mtime && st.size === seen.size;
						this.setBase(a.from, null);
						this.setBase(a.to, this.baseFor(a.remote.hash, intact ? st : null, a.remote.id));
						touchedFolders.push(a.from);
						report.renamed.push(`${a.from} → ${a.to}`);
						cfg.log(`↓ 이름 변경: ${a.from} → ${a.to}`);
						break;
					}
					case "conflict":
						await this.resolveConflict(a, local, report);
						break;
				}
			} catch (e) {
				if (e instanceof SkipError) {
					report.skipped.push({ path, reason: e.message });
					cfg.log(`⏭ ${path}: ${e.message}`);
				} else {
					// Auth problems abort the whole run; everything else is per-file.
					if (e instanceof Error && e.name === "AuthError") throw e;
					report.errors.push({ path, message: errorMessage(e) });
					cfg.log(`❌ ${path}: ${errorMessage(e)}`);
				}
			} finally {
				done++;
				cfg.onProgress?.(done, total);
				await this.saveState();
			}
		};

		for (const phase of phases) {
			if (cfg.isCancelled?.()) break;
			// Renames run one by one: they may depend on each other's paths.
			const limit = phase[0]?.kind === "renameLocal" || phase[0]?.kind === "renameRemote" ? 1 : cfg.concurrency;
			let authError: unknown = null;
			await runPool(
				phase,
				limit,
				async (a) => {
					try {
						await exec(a);
					} catch (e) {
						authError = e;
					}
				},
				() => authError !== null || !!cfg.isCancelled?.(),
			);
			if (authError) throw authError;
		}
		if (touchedFolders.length) await this.local.cleanupEmptyFolders(touchedFolders).catch(() => {});
	}

	private async resolveConflict(a: Action & { kind: "conflict" }, local: Map<string, LocalEntry>, report: SyncReport) {
		const { cfg } = this;
		const seen = local.get(a.path);
		if (!(await this.unchangedSincePlan(a.path, seen))) throw new SkipError("로컬 파일이 동기화 도중 변경됨");

		if (a.resolution === "useLocal") {
			await this.doUpload(a.path, expectOf(a.remote));
			report.uploaded.push(a.path);
			cfg.log(`⚔ 충돌 → 로컬 유지: ${a.path}`);
			return;
		}
		const { data, hash } = await this.downloadVerified(a.remote);
		if (!(await this.unchangedSincePlan(a.path, seen))) {
			throw new SkipError("다운로드하는 동안 로컬 파일이 수정됨 — 다음 동기화에서 처리");
		}
		if (a.resolution === "useRemote") {
			await this.writeAndRecord(a.path, a.remote, data, hash, seen);
			report.downloaded.push(a.path);
			if (cfg.planOptions.isConfigPath(a.path)) report.configChanged = true;
			cfg.log(`⚔ 충돌 → 원격 사용: ${a.path}`);
			return;
		}

		// keepBoth: local version moves aside to a conflict copy, remote version takes the original name.
		let copy = conflictPath(a.path, cfg.device, this.now());
		for (let n = 2; await this.local.stat(copy); n++) copy = conflictPath(a.path, `${cfg.device} ${n}`, this.now());
		await this.local.rename(a.path, copy);
		await this.writeAndRecord(a.path, a.remote, data, hash, undefined);
		await this.doUpload(copy, undefined);
		report.conflicts.push(`${a.path} → ${copy}`);
		cfg.log(`⚔ 충돌 → 둘 다 보관: ${copy}`);
	}
}

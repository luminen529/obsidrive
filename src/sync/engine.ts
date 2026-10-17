// Executes a sync run: scan -> list remote -> normalize -> plan -> guard -> apply.
// All I/O goes through the small interfaces below so the engine can be tested
// end-to-end with in-memory fakes.

import type { AppProps, RemoteFile } from "../drive";
import { PROP_DELETED, PROP_DEVICE, PROP_HASH, PROP_MTIME, PROP_VAULT } from "../drive";
import { conflictPath, errorMessage, mergeJsonLists, runPool, sha256Hex } from "../util";
import { knownLocalHash, normalizeRemote, plan, PlanOptions } from "./planner";
import { Action, BaseEntry, emptyReport, LocalEntry, RemoteEntry, SyncReport, SyncState } from "./types";

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
					if (fix.kind === "removeRemote") {
						cfg.log(`원격 정리: ${fix.path} (${fix.why})`);
						await this.remote.remove(fix.id);
					} else {
						cfg.log(`원격 중복 → 충돌 사본: ${fix.from} → ${fix.to}`);
						await this.remote.updateMeta(fix.id, { name: fix.to });
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
			this.state.lastSync = this.now();
			await this.saveState(true);
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
				l.hash = await sha256Hex(await this.local.read(l.path));
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

	private async writeAndRecord(path: string, r: RemoteEntry, data: ArrayBuffer, hash: string) {
		await this.local.write(path, data, r.mtime || r.modifiedTime);
		const st = await this.local.stat(path);
		if (!st) throw new Error("쓰기 후 파일을 찾을 수 없음");
		this.setBase(path, { h: hash, lm: st.mtime, ls: st.size, rid: r.id });
		if (!r.hash) await this.remote.updateMeta(r.id, { appProperties: { [PROP_HASH]: hash } });
	}

	private async doUpload(path: string, remoteId: string | undefined, expectRemoteHash: string | undefined, name?: string) {
		const { data, hash, mtime, size } = await this.readStable(path);
		let f: RemoteFile;
		if (remoteId) {
			// Optimistic concurrency: make sure nobody replaced the remote file since we listed it.
			if (expectRemoteHash !== undefined) {
				const meta = await this.remote.getMeta(remoteId);
				const cur = meta?.appProperties[PROP_HASH] ?? "";
				if (meta && !meta.appProperties[PROP_DELETED] && cur !== expectRemoteHash) {
					throw new SkipError("원격 파일이 동기화 도중 변경됨 (다음 동기화에서 처리)");
				}
				if (!meta) remoteId = undefined;
			}
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
						const b = this.state.files[a.path];
						await this.doUpload(a.path, a.remoteId, a.remoteId ? (b?.h ?? undefined) : undefined);
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
						await this.writeAndRecord(a.path, a.remote, data, hash);
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
						await this.remote.updateMeta(a.remoteId, {
							name: a.to,
							appProperties: { ...this.props(l.hash, l.mtime) },
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
						this.setBase(a.from, null);
						this.setBase(a.to, { h: a.remote.hash, lm: st.mtime, ls: st.size, rid: a.remote.id });
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
			await this.doUpload(a.path, a.remote.id, a.remote.hash);
			report.uploaded.push(a.path);
			cfg.log(`⚔ 충돌 → 로컬 유지: ${a.path}`);
			return;
		}
		const { data, hash } = await this.downloadVerified(a.remote);
		if (a.resolution === "mergeList") {
			const merged = mergeJsonLists(await this.local.read(a.path), data);
			report.configChanged = true;
			if (merged?.changed) {
				await this.local.write(a.path, merged.data, this.now());
				await this.doUpload(a.path, a.remote.id, a.remote.hash);
				report.uploaded.push(a.path);
				cfg.log(`⚔ 첫 동기화 → 목록 합침: ${a.path}`);
				return;
			}
			// Not a list, or nothing to add: take the remote version.
			await this.writeAndRecord(a.path, a.remote, data, hash);
			report.downloaded.push(a.path);
			cfg.log(`⚔ 첫 동기화 → 원격 사용: ${a.path}`);
			return;
		}
		if (a.resolution === "useRemote") {
			await this.writeAndRecord(a.path, a.remote, data, hash);
			report.downloaded.push(a.path);
			if (cfg.planOptions.isConfigPath(a.path)) report.configChanged = true;
			cfg.log(`⚔ 충돌 → 원격 사용: ${a.path}`);
			return;
		}

		// keepBoth: local version moves aside to a conflict copy, remote version takes the original name.
		let copy = conflictPath(a.path, cfg.device, this.now());
		for (let n = 2; await this.local.stat(copy); n++) copy = conflictPath(a.path, `${cfg.device} ${n}`, this.now());
		await this.local.rename(a.path, copy);
		await this.writeAndRecord(a.path, a.remote, data, hash);
		await this.doUpload(copy, undefined, undefined);
		report.conflicts.push(`${a.path} → ${copy}`);
		cfg.log(`⚔ 충돌 → 둘 다 보관: ${copy}`);
	}
}

// Keeps a local copy of the remote file listing and refreshes it through the
// Drive change feed, so a sync with no remote changes costs one tiny request
// instead of downloading the metadata of every file.
//
// Safety: any doubt (no cache, different account/client/vault, invalid token,
// cache older than `fullRefreshMs`) falls back to a full listing. The engine's
// own guards (mass-deletion check, hash verification) still apply on top.

import type { AppProps, RemoteChange, RemoteFile } from "./drive";
import { PROP_KIND, PROP_VAULT } from "./drive";
import { HttpError } from "./http";
import type { RemoteStore } from "./sync/engine";

export interface ChangeFeedRemote extends RemoteStore {
	getStartPageToken(): Promise<string>;
	listChanges(pageToken: string): Promise<{ changes: RemoteChange[]; newStartPageToken: string }>;
}

export interface RemoteCacheData {
	version: 1;
	/** Identifies client + account + vault; a mismatch invalidates the cache. */
	scope: string;
	token: string;
	fullAt: number;
	files: Record<string, RemoteFile>;
}

export interface JsonStore<T> {
	load(): Promise<T | null>;
	save(value: T): Promise<void>;
}

export interface CacheOptions {
	fullRefreshMs: number;
	log?: (msg: string) => void;
	now?: () => number;
}

export class CachedRemoteStore implements RemoteStore {
	constructor(
		private inner: ChangeFeedRemote,
		private store: JsonStore<RemoteCacheData>,
		private scope: string,
		private opts: CacheOptions,
	) {}

	private now() {
		return this.opts.now ? this.opts.now() : Date.now();
	}

	private log(msg: string) {
		this.opts.log?.(msg);
	}

	async listVault(vaultKey: string): Promise<RemoteFile[]> {
		let cache = await this.store.load().catch(() => null);
		if (cache && (cache.version !== 1 || cache.scope !== this.scope || !cache.token || !cache.files)) cache = null;

		if (cache && this.now() - cache.fullAt < this.opts.fullRefreshMs) {
			try {
				const { changes, newStartPageToken } = await this.inner.listChanges(cache.token);
				// Nothing changed in our space: keep the old token and skip the disk write.
				// Replaying from it later is still correct (it just returns no changes).
				if (changes.length) {
					for (const c of changes) applyChange(cache.files, c, vaultKey);
					cache.token = newStartPageToken;
					await this.store.save(cache);
				}
				this.log(`원격 변경분 ${changes.length}건 반영 (전체 목록 생략)`);
				return Object.values(cache.files);
			} catch (e) {
				// Expired/invalid token: rebuild below. Anything else (offline, auth) aborts the sync.
				if (!(e instanceof HttpError) || ![400, 404, 410].includes(e.status)) throw e;
				this.log(`변경 토큰을 쓸 수 없어 전체 목록을 다시 받습니다 (${e.message})`);
			}
		}

		// Take the token first, then catch up once after listing: changes made while the
		// listing was running are applied now instead of only on the next run (upserts are idempotent).
		const startToken = await this.inner.getStartPageToken();
		const listed = await this.inner.listVault(vaultKey);
		const files: Record<string, RemoteFile> = Object.fromEntries(listed.map((f) => [f.id, f]));
		const { changes, newStartPageToken } = await this.inner.listChanges(startToken);
		for (const c of changes) applyChange(files, c, vaultKey);
		await this.store.save({ version: 1, scope: this.scope, token: newStartPageToken, fullAt: this.now(), files });
		this.log(`원격 전체 목록 ${Object.keys(files).length}개 저장 (목록 중 변경 ${changes.length}건 반영)`);
		return Object.values(files);
	}

	getMeta(id: string) {
		return this.inner.getMeta(id);
	}
	download(id: string) {
		return this.inner.download(id);
	}
	create(name: string, appProperties: AppProps, data: ArrayBuffer) {
		return this.inner.create(name, appProperties, data);
	}
	updateContent(id: string, meta: { name?: string; appProperties: AppProps }, data: ArrayBuffer) {
		return this.inner.updateContent(id, meta, data);
	}
	updateMeta(id: string, meta: { name?: string; appProperties?: AppProps }) {
		return this.inner.updateMeta(id, meta);
	}
	remove(id: string) {
		return this.inner.remove(id);
	}
}

export function applyChange(files: Record<string, RemoteFile>, c: RemoteChange, vaultKey: string) {
	const f = c.file;
	if (c.removed || !f || f.appProperties[PROP_VAULT] !== vaultKey || f.appProperties[PROP_KIND]) {
		delete files[c.fileId];
	} else {
		files[c.fileId] = f;
	}
}

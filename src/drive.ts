// Minimal Google Drive v3 client restricted to the hidden "appDataFolder" space.
// Files there are invisible in the Drive web UI and only accessible to this OAuth client.
//
// Storage model: one Drive file per vault file, flat (no Drive folders).
//   name           = vault-relative path, e.g. "Notes/today.md" or ".obsidian/app.json"
//   appProperties  = { ov: vaultKey, oh: sha256, om: mtime, od?: deletedAt, odv?: device }
// A file with `od` set is a tombstone: the content is kept for recovery until purged.

import { AuthError, HttpError, HttpFn, HttpResponse, safeJson } from "./http";
import type { TokenProvider } from "./auth";
import { errorMessage, sleep } from "./util";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS = "id,name,size,modifiedTime,appProperties";
const MULTIPART_LIMIT = 5 * 1024 * 1024;

export const PROP_VAULT = "ov";
export const PROP_HASH = "oh";
export const PROP_MTIME = "om";
export const PROP_DELETED = "od";
export const PROP_DEVICE = "odv";
export const PROP_KIND = "okind";

export interface RemoteFile {
	id: string;
	name: string;
	size: number;
	modifiedTime: number;
	appProperties: Record<string, string>;
}

export type AppProps = Record<string, string | null>;

export interface RemoteChange {
	fileId: string;
	/** Deleted or trashed. */
	removed: boolean;
	file?: RemoteFile;
}

function toRemote(f: any): RemoteFile {
	return {
		id: f.id,
		name: f.name,
		size: Number(f.size ?? 0),
		modifiedTime: Date.parse(f.modifiedTime ?? "") || 0,
		appProperties: f.appProperties ?? {},
	};
}

function escapeQ(s: string) {
	return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export interface DriveOptions {
	maxRetries?: number;
	log?: (msg: string) => void;
}

export class DriveClient {
	private maxRetries: number;
	private log: (msg: string) => void;

	constructor(
		private http: HttpFn,
		private tokens: TokenProvider,
		opts: DriveOptions = {},
	) {
		this.maxRetries = opts.maxRetries ?? 5;
		this.log = opts.log ?? (() => {});
	}

	/** Authenticated request with token refresh and exponential backoff on transient errors. */
	private async call(
		url: string,
		init: { method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer; contentType?: string } = {},
	): Promise<HttpResponse> {
		let refreshed = false;
		for (let attempt = 0; ; attempt++) {
			const token = await this.tokens.get();
			let res: HttpResponse;
			try {
				res = await this.http({
					url,
					method: init.method ?? "GET",
					contentType: init.contentType,
					body: init.body,
					headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
				});
			} catch (e) {
				// Network failure (offline, DNS, reset). Retry a few times, then surface.
				if (attempt >= this.maxRetries) throw new HttpError(`네트워크 오류: ${errorMessage(e)}`, 0, "network");
				await this.backoff(attempt, `network: ${errorMessage(e)}`);
				continue;
			}
			if (res.status >= 200 && res.status < 300) return res;

			const body = safeJson(res);
			const reason: string | undefined = body?.error?.errors?.[0]?.reason ?? body?.error?.status;
			const message: string = body?.error?.message ?? `HTTP ${res.status}`;

			if (res.status === 401 && !refreshed) {
				refreshed = true;
				await this.tokens.get(true);
				continue;
			}
			if (res.status === 401) throw new AuthError(`Google 인증 실패: ${message}`);

			const transient =
				res.status === 429 ||
				res.status >= 500 ||
				(res.status === 403 && (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded"));
			if (transient && attempt < this.maxRetries) {
				await this.backoff(attempt, `${res.status} ${reason ?? ""}`);
				continue;
			}
			throw new HttpError(`Drive API 오류 ${res.status}: ${message}`, res.status, reason);
		}
	}

	private async backoff(attempt: number, why: string) {
		const ms = Math.min(32_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 1000);
		this.log(`재시도 대기 ${Math.round(ms / 1000)}s (${why})`);
		await sleep(ms);
	}

	private async listAll(q: string): Promise<RemoteFile[]> {
		const out: RemoteFile[] = [];
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({
				spaces: "appDataFolder",
				q,
				fields: `nextPageToken,files(${FILE_FIELDS})`,
				pageSize: "1000",
			});
			if (pageToken) params.set("pageToken", pageToken);
			const res = await this.call(`${API}/files?${params.toString()}`);
			const body = res.json();
			for (const f of body.files ?? []) out.push(toRemote(f));
			pageToken = body.nextPageToken;
		} while (pageToken);
		return out;
	}

	/** All file entries (including tombstones) belonging to one vault. */
	listVault(vaultKey: string): Promise<RemoteFile[]> {
		return this.listAll(
			`appProperties has { key='${PROP_VAULT}' and value='${escapeQ(vaultKey)}' } and trashed = false`,
		).then((files) => files.filter((f) => !f.appProperties[PROP_KIND]));
	}

	/** Vault marker files, used to show which remote vaults exist. */
	listVaultMarkers(): Promise<RemoteFile[]> {
		return this.listAll(`appProperties has { key='${PROP_KIND}' and value='vault' } and trashed = false`);
	}

	async ensureVaultMarker(vaultKey: string, vaultName: string): Promise<void> {
		const existing = await this.listAll(
			`appProperties has { key='${PROP_KIND}' and value='vault' } and appProperties has { key='${PROP_VAULT}' and value='${escapeQ(vaultKey)}' } and trashed = false`,
		);
		if (existing.length > 0) return;
		await this.create(`.obsidrive-vault/${vaultName}`, { [PROP_KIND]: "vault", [PROP_VAULT]: vaultKey }, new ArrayBuffer(0));
	}

	/** Token marking "now" in the change feed; changes after it can be fetched with listChanges(). */
	async getStartPageToken(): Promise<string> {
		const res = await this.call(`${API}/changes/startPageToken?fields=startPageToken`);
		return res.json().startPageToken;
	}

	/** Every change in the appDataFolder since `pageToken` (all pages), plus the token to resume from. */
	async listChanges(pageToken: string): Promise<{ changes: RemoteChange[]; newStartPageToken: string }> {
		const changes: RemoteChange[] = [];
		let token = pageToken;
		for (;;) {
			const params = new URLSearchParams({
				pageToken: token,
				spaces: "appDataFolder",
				includeRemoved: "true",
				pageSize: "1000",
				fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS},trashed))`,
			});
			const body = (await this.call(`${API}/changes?${params.toString()}`)).json();
			for (const c of body.changes ?? []) {
				changes.push({
					fileId: c.fileId,
					removed: !!c.removed || !!c.file?.trashed,
					file: c.file ? toRemote(c.file) : undefined,
				});
			}
			if (body.newStartPageToken) return { changes, newStartPageToken: body.newStartPageToken };
			if (!body.nextPageToken) throw new HttpError("changes.list: 다음 페이지 토큰 없음", 500);
			token = body.nextPageToken;
		}
	}

	async getMeta(id: string): Promise<RemoteFile | null> {
		try {
			const res = await this.call(`${API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS},trashed`);
			const body = res.json();
			return body.trashed ? null : toRemote(body);
		} catch (e) {
			if (e instanceof HttpError && e.status === 404) return null;
			throw e;
		}
	}

	async download(id: string): Promise<ArrayBuffer> {
		const res = await this.call(`${API}/files/${encodeURIComponent(id)}?alt=media`);
		return res.arrayBuffer();
	}

	create(name: string, appProperties: AppProps, data: ArrayBuffer): Promise<RemoteFile> {
		return this.upload("POST", `${UPLOAD_API}/files`, { name, parents: ["appDataFolder"], appProperties }, data);
	}

	updateContent(id: string, meta: { name?: string; appProperties: AppProps }, data: ArrayBuffer): Promise<RemoteFile> {
		return this.upload("PATCH", `${UPLOAD_API}/files/${encodeURIComponent(id)}`, meta, data);
	}

	async updateMeta(id: string, meta: { name?: string; appProperties?: AppProps }): Promise<RemoteFile> {
		const res = await this.call(`${API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`, {
			method: "PATCH",
			contentType: "application/json; charset=UTF-8",
			body: JSON.stringify(meta),
		});
		return toRemote(res.json());
	}

	async remove(id: string): Promise<void> {
		try {
			await this.call(`${API}/files/${encodeURIComponent(id)}`, { method: "DELETE" });
		} catch (e) {
			if (e instanceof HttpError && e.status === 404) return; // already gone
			throw e;
		}
	}

	async about(): Promise<{ email?: string; usage?: number; limit?: number }> {
		const res = await this.call(`${API}/about?fields=user(emailAddress),storageQuota(usage,limit)`);
		const b = res.json();
		return {
			email: b.user?.emailAddress,
			usage: b.storageQuota?.usage ? Number(b.storageQuota.usage) : undefined,
			limit: b.storageQuota?.limit ? Number(b.storageQuota.limit) : undefined,
		};
	}

	private async upload(method: "POST" | "PATCH", baseUrl: string, meta: object, data: ArrayBuffer): Promise<RemoteFile> {
		if (data.byteLength <= MULTIPART_LIMIT) {
			const boundary = `obsidrive-${Math.random().toString(36).slice(2)}${Date.now()}`;
			const enc = new TextEncoder();
			const head = enc.encode(
				`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
					`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
			);
			const tail = enc.encode(`\r\n--${boundary}--`);
			const body = new Uint8Array(head.length + data.byteLength + tail.length);
			body.set(head, 0);
			body.set(new Uint8Array(data), head.length);
			body.set(tail, head.length + data.byteLength);
			const res = await this.call(`${baseUrl}?uploadType=multipart&fields=${FILE_FIELDS}`, {
				method,
				contentType: `multipart/related; boundary=${boundary}`,
				body: body.buffer,
			});
			return toRemote(res.json());
		}

		// Resumable upload, sent as a single PUT. On failure the whole upload restarts.
		const init = await this.call(`${baseUrl}?uploadType=resumable&fields=${FILE_FIELDS}`, {
			method,
			contentType: "application/json; charset=UTF-8",
			headers: { "X-Upload-Content-Type": "application/octet-stream", "X-Upload-Content-Length": String(data.byteLength) },
			body: JSON.stringify(meta),
		});
		const location = init.headers["location"];
		if (!location) throw new HttpError("resumable upload: Location 헤더 없음", init.status);
		const res = await this.call(location, { method: "PUT", contentType: "application/octet-stream", body: data });
		return toRemote(res.json());
	}
}

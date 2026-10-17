// Small, dependency-free helpers shared across the plugin.
// This file must not import "obsidian" so it can be unit tested in Node.

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return bufToHex(digest);
}

export function bufToHex(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let out = "";
	for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
	return out;
}

export async function sha256OfString(s: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(s).buffer as ArrayBuffer);
}

export function randomString(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return base64Url(bytes);
}

export function base64Url(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Run `worker` over `items` with at most `limit` promises in flight. Never rejects. */
export async function runPool<T>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<void>,
	shouldStop: () => boolean = () => false,
): Promise<void> {
	let next = 0;
	const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length && !shouldStop()) {
			const i = next++;
			await worker(items[i], i);
		}
	});
	await Promise.all(lanes);
}

export function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? path : path.slice(i + 1);
}

/** Splits "a/b/note.md" into ["a/b/note", ".md"]. Dotfiles like ".gitignore" have no extension. */
export function splitExt(path: string): [string, string] {
	const base = basename(path);
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return [path, ""];
	const cut = path.length - (base.length - dot);
	return [path.slice(0, cut), path.slice(cut)];
}

export function pad2(n: number) {
	return String(n).padStart(2, "0");
}

export function formatStamp(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** Device label safe for use in a filename. */
export function safeLabel(s: string): string {
	return s.replace(/[\\/:*?"<>|#^[\]]/g, "").trim().slice(0, 32) || "device";
}

export function conflictPath(path: string, device: string, now: number): string {
	const [stem, ext] = splitExt(path);
	return `${stem} (conflict ${formatStamp(now)} ${safeLabel(device)})${ext}`;
}

/**
 * Union of two JSON string lists, remote order first. Returns null if either side
 * is not a JSON array of strings, and `changed: false` if the result equals remote.
 */
export function mergeJsonLists(local: ArrayBuffer, remote: ArrayBuffer): { data: ArrayBuffer; changed: boolean } | null {
	const parse = (b: ArrayBuffer): string[] | null => {
		try {
			const v = JSON.parse(new TextDecoder().decode(b));
			return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
		} catch {
			return null;
		}
	};
	const l = parse(local);
	const r = parse(remote);
	if (!l || !r) return null;
	const extra = l.filter((x) => !r.includes(x));
	const merged = [...r, ...extra];
	return { data: new TextEncoder().encode(JSON.stringify(merged, null, 2)).buffer as ArrayBuffer, changed: extra.length > 0 };
}

export function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

export function humanBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Converts a user ignore pattern into a RegExp.
 * Lines wrapped in slashes ("/regex/") are raw regexes; others are globs where
 * "**" matches across folders, "*" within a segment and "?" one character.
 * A pattern without "/" matches a file or folder name at any depth.
 */
export function patternToRegExp(pattern: string): RegExp | null {
	const p = pattern.trim();
	if (!p || p.startsWith("#")) return null;
	if (p.length > 2 && p.startsWith("/") && p.endsWith("/")) {
		try {
			return new RegExp(p.slice(1, -1));
		} catch {
			return null;
		}
	}
	let glob = p.replace(/^\.\//, "");
	const anchored = glob.includes("/") && !glob.startsWith("**/");
	glob = glob.replace(/\/$/, "");
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	// Match the path itself or anything beneath it (folder patterns).
	return new RegExp(anchored ? `^${re}(/.*)?$` : `(^|/)${re}(/.*)?$`);
}

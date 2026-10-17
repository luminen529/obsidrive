// Transport abstraction so the Drive/auth code can run against Obsidian's
// requestUrl (no CORS restrictions, works on mobile) or a fake in tests.

export interface HttpRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
}

export interface HttpResponse {
	status: number;
	/** Header names are lower-cased. */
	headers: Record<string, string>;
	arrayBuffer(): ArrayBuffer;
	text(): string;
	json(): any;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export class HttpError extends Error {
	constructor(
		message: string,
		public status: number,
		public reason?: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}

/** Thrown when the stored credentials can no longer be used; the user must sign in again. */
export class AuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthError";
	}
}

export function lowerKeys(h: Record<string, string> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!h) return out;
	for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
	return out;
}

export function formBody(params: Record<string, string>): string {
	return Object.entries(params)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");
}

export function safeJson(res: HttpResponse): any {
	try {
		return res.json();
	} catch {
		return undefined;
	}
}

// Google OAuth 2.0 for installed apps (Authorization Code + PKCE).
// https://developers.google.com/identity/protocols/oauth2/native-app
//
// Desktop: a one-shot loopback HTTP server on 127.0.0.1 receives the redirect.
// Mobile (or as a fallback): the browser is redirected to a loopback URL that
// fails to load; the user copies that URL from the address bar and pastes it.

import { AuthError, formBody, HttpError, HttpFn, safeJson } from "./http";
import { base64Url, randomString } from "./util";

export const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
/** Fixed loopback URI used by the copy/paste flow. Nothing needs to listen on it. */
export const MANUAL_REDIRECT_URI = "http://127.0.0.1:42813";

export interface ClientCredentials {
	clientId: string;
	clientSecret: string;
}

export interface PkceSession {
	verifier: string;
	state: string;
	redirectUri: string;
	createdAt: number;
}

export async function createPkceSession(redirectUri: string): Promise<PkceSession> {
	return { verifier: randomString(48), state: randomString(16), redirectUri, createdAt: Date.now() };
}

export async function buildAuthUrl(clientId: string, session: PkceSession): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(session.verifier));
	const params = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: session.redirectUri,
		scope: SCOPE,
		code_challenge: base64Url(new Uint8Array(digest)),
		code_challenge_method: "S256",
		state: session.state,
		access_type: "offline",
		// Forces Google to return a refresh token even if the app was authorized before.
		prompt: "consent",
	});
	return `${AUTH_URL}?${params.toString()}`;
}

export interface RedirectResult {
	code?: string;
	state?: string;
	error?: string;
}

/** Accepts the full redirect URL (or just its query string) pasted by the user. */
export function parseRedirect(input: string): RedirectResult {
	const s = input.trim();
	const q = s.includes("?") ? s.slice(s.indexOf("?") + 1) : s;
	const params = new URLSearchParams(q.split("#")[0]);
	return {
		code: params.get("code") ?? undefined,
		state: params.get("state") ?? undefined,
		error: params.get("error") ?? undefined,
	};
}

interface TokenResponse {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
}

async function tokenRequest(http: HttpFn, params: Record<string, string>): Promise<TokenResponse> {
	const res = await http({
		url: TOKEN_URL,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: formBody(params),
	});
	const body = safeJson(res);
	if (res.status >= 200 && res.status < 300 && body?.access_token) return body as TokenResponse;
	const err = body?.error ?? `HTTP ${res.status}`;
	const desc = body?.error_description ? `: ${body.error_description}` : "";
	if (err === "invalid_grant" || err === "invalid_client" || err === "unauthorized_client") {
		throw new AuthError(`Google 인증이 만료되었거나 거부되었습니다 (${err}${desc}). 다시 로그인하세요.`);
	}
	throw new HttpError(`토큰 요청 실패 (${err}${desc})`, res.status, err);
}

export async function exchangeCode(
	http: HttpFn,
	creds: ClientCredentials,
	session: PkceSession,
	code: string,
): Promise<{ accessToken: string; expiresAt: number; refreshToken: string }> {
	const t = await tokenRequest(http, {
		grant_type: "authorization_code",
		code,
		client_id: creds.clientId,
		client_secret: creds.clientSecret,
		code_verifier: session.verifier,
		redirect_uri: session.redirectUri,
	});
	if (!t.refresh_token) {
		throw new AuthError("Google이 refresh token을 돌려주지 않았습니다. 다시 시도하세요.");
	}
	return { accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000, refreshToken: t.refresh_token };
}

export async function revokeToken(http: HttpFn, token: string): Promise<void> {
	await http({
		url: REVOKE_URL,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: formBody({ token }),
	});
}

/** Caches the short-lived access token and refreshes it on demand (single flight). */
export class TokenProvider {
	private accessToken: string | null = null;
	private expiresAt = 0;
	private inflight: Promise<string> | null = null;

	constructor(
		private http: HttpFn,
		private getCreds: () => ClientCredentials,
		private getRefreshToken: () => string | null,
	) {}

	seed(accessToken: string, expiresAt: number) {
		this.accessToken = accessToken;
		this.expiresAt = expiresAt;
	}

	clear() {
		this.accessToken = null;
		this.expiresAt = 0;
	}

	async get(forceRefresh = false): Promise<string> {
		if (!forceRefresh && this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
		if (!this.inflight) {
			this.inflight = this.refresh().finally(() => (this.inflight = null));
		}
		return this.inflight;
	}

	private async refresh(): Promise<string> {
		const refreshToken = this.getRefreshToken();
		const creds = this.getCreds();
		if (!refreshToken) throw new AuthError("Google 계정이 연결되어 있지 않습니다.");
		if (!creds.clientId || !creds.clientSecret) throw new AuthError("OAuth Client ID/Secret이 설정되지 않았습니다.");
		const t = await tokenRequest(this.http, {
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: creds.clientId,
			client_secret: creds.clientSecret,
		});
		this.accessToken = t.access_token;
		this.expiresAt = Date.now() + t.expires_in * 1000;
		return t.access_token;
	}
}

export interface LoopbackHandle {
	redirectUri: string;
	result: Promise<RedirectResult>;
	close(): void;
}

/**
 * Starts a one-shot HTTP server on 127.0.0.1 (desktop only).
 * Resolves with the query parameters of the first request that carries `code` or `error`.
 */
export async function startLoopback(timeoutMs = 5 * 60_000): Promise<LoopbackHandle> {
	// Electron exposes Node's require on desktop; never reached on mobile.
	const http = (window as any).require("http") as typeof import("http");
	const server = http.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	let timer: number | undefined;
	const close = () => {
		window.clearTimeout(timer);
		server.close();
	};
	const result = new Promise<RedirectResult>((resolve, reject) => {
		timer = window.setTimeout(() => {
			close();
			reject(new Error("로그인 시간이 초과되었습니다."));
		}, timeoutMs);
		server.on("request", (req, res) => {
			const parsed = parseRedirect(req.url ?? "");
			if (!parsed.code && !parsed.error) {
				res.writeHead(404).end();
				return;
			}
			const ok = !!parsed.code;
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(
				`<!doctype html><meta charset="utf-8"><title>ObsiDrive</title>` +
					`<body style="font-family:system-ui;padding:3em;text-align:center">` +
					`<h2>${ok ? "✅ 로그인 완료" : "❌ 로그인 실패"}</h2>` +
					`<p>${ok ? "이 창을 닫고 Obsidian으로 돌아가세요." : "Obsidian에서 다시 시도하세요."}</p></body>`,
			);
			close();
			resolve(parsed);
		});
	});
	return { redirectUri: `http://127.0.0.1:${port}`, result, close };
}

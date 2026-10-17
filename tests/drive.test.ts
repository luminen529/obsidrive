import { describe, expect, it } from "vitest";
import { parseRedirect, TokenProvider } from "../src/auth";
import { DriveClient } from "../src/drive";
import type { HttpFn, HttpRequest, HttpResponse } from "../src/http";
import { dec, enc } from "./fakes";

const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
	status,
	headers,
	arrayBuffer: () => enc(JSON.stringify(body)),
	text: () => JSON.stringify(body),
	json: () => body,
});

function setup(handler: (req: HttpRequest, n: number) => HttpResponse) {
	const reqs: HttpRequest[] = [];
	let tokenCalls = 0;
	const http: HttpFn = async (req) => {
		if (req.url.startsWith("https://oauth2.googleapis.com/token")) {
			tokenCalls++;
			return json(200, { access_token: `tok${tokenCalls}`, expires_in: 3600 });
		}
		reqs.push(req);
		return handler(req, reqs.length);
	};
	const tokens = new TokenProvider(http, () => ({ clientId: "id", clientSecret: "s" }), () => "refresh");
	return { drive: new DriveClient(http, tokens), reqs, tokenCalls: () => tokenCalls };
}

describe("DriveClient", () => {
	it("builds a valid multipart upload into appDataFolder", async () => {
		const { drive, reqs } = setup(() => json(200, { id: "f1", name: "a.md", size: "5", modifiedTime: "2026-01-01T00:00:00Z", appProperties: { ov: "v" } }));
		const f = await drive.create("a.md", { ov: "v", oh: "h" }, enc("hello"));
		expect(f).toMatchObject({ id: "f1", size: 5 });
		const r = reqs[0];
		expect(r.url).toContain("/upload/drive/v3/files?uploadType=multipart");
		expect(r.method).toBe("POST");
		const boundary = /boundary=(.+)$/.exec(r.contentType!)![1];
		const body = dec(r.body as ArrayBuffer);
		expect(body.startsWith(`--${boundary}\r\nContent-Type: application/json`)).toBe(true);
		expect(body).toContain('"parents":["appDataFolder"]');
		expect(body).toContain("\r\n\r\nhello\r\n");
		expect(body.endsWith(`--${boundary}--`)).toBe(true);
		expect(r.headers?.Authorization).toBe("Bearer tok1");
	});

	it("pages through listings and scopes them to the vault", async () => {
		const { drive, reqs } = setup((req) => {
			const page = new URL(req.url).searchParams.get("pageToken");
			return page
				? json(200, { files: [{ id: "2", name: "b.md", appProperties: { ov: "v" } }] })
				: json(200, { nextPageToken: "p2", files: [{ id: "1", name: "a.md", appProperties: { ov: "v" } }, { id: "m", name: ".obsidrive-vault/x", appProperties: { ov: "v", okind: "vault" } }] });
		});
		const files = await drive.listVault("v");
		expect(files.map((f) => f.id)).toEqual(["1", "2"]);
		const q = new URL(reqs[0].url).searchParams;
		expect(q.get("spaces")).toBe("appDataFolder");
		expect(q.get("q")).toBe("appProperties has { key='ov' and value='v' } and trashed = false");
	});

	it("refreshes the access token once on 401", async () => {
		const { drive, tokenCalls } = setup((req, n) => (n === 1 ? json(401, { error: { message: "expired" } }) : json(200, { files: [] })));
		await drive.listVault("v");
		expect(tokenCalls()).toBe(2);
	});

	it("treats 404 on delete as success", async () => {
		const { drive } = setup(() => json(404, { error: { message: "not found" } }));
		await expect(drive.remove("x")).resolves.toBeUndefined();
	});
});

describe("auth", () => {
	it("parses a pasted redirect URL", () => {
		expect(parseRedirect("http://127.0.0.1:42813/?state=abc&code=4/0Ab-x&scope=x")).toEqual({ code: "4/0Ab-x", state: "abc", error: undefined });
		expect(parseRedirect("http://127.0.0.1:42813/?error=access_denied").error).toBe("access_denied");
	});
});

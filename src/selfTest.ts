// On-device check that replacing a note through Vault.process keeps the exact
// bytes (BOM, CRLF, Korean, combining characters, emoji, NUL). Runs against
// the real Obsidian on whatever device the user starts it from.

import type { App } from "obsidian";
import { PathFilter, SELFTEST_PREFIX } from "./filter";
import { ObsidianLocalFs } from "./obsidianFs";
import type { OwnWriteTracker } from "./ownWrites";
import { sha256Hex } from "./util";

const BOM = "﻿";
const ORIGINAL = `${BOM}# ObsiDrive 자가 진단\r\nCRLF 줄바꿈\r\n한글 · 결합 문자 é · 이모지 🎉\r\nNUL:\u0000:끝\r\n`;
const NEXT = `${BOM}# ObsiDrive 자가 진단 (교체됨)\r\n줄바꿈은 그대로 CRLF\r\n한글 · 결합 문자 ä · 이모지 🧪\r\nNUL:\u0000:끝\r\n`;

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function firstDifference(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
	return a.length === b.length ? -1 : n;
}

export async function runTextReplaceSelfTest(
	app: App,
	filter: PathFilter,
	tracker: OwnWriteTracker,
): Promise<{ ok: boolean; message: string }> {
	// The prefix keeps this temporary note out of sync (see PathFilter).
	const path = `${SELFTEST_PREFIX} ${Date.now()}.md`;
	const fs = new ObsidianLocalFs(app, filter, tracker);
	try {
		await app.vault.createBinary(path, enc(ORIGINAL));
		const created = new Uint8Array(await app.vault.adapter.readBinary(path));
		if ((await sha256Hex(created.buffer as ArrayBuffer)) !== (await sha256Hex(enc(ORIGINAL)))) {
			return { ok: false, message: "테스트 노트를 만드는 단계에서 이미 바이트가 달라졌습니다." };
		}

		const res = await fs.replaceText(path, ORIGINAL, NEXT);
		if (res !== "replaced") {
			return {
				ok: false,
				message:
					"Vault.process가 읽은 텍스트가 디스크의 바이트와 다릅니다(BOM·줄바꿈 정규화 가능성). " +
					"이 기기에서는 이런 노트에 원자적 교체 대신 재검증 쓰기를 사용합니다.",
			};
		}

		const expected = new Uint8Array(enc(NEXT));
		const actual = new Uint8Array(await app.vault.adapter.readBinary(path));
		const diff = firstDifference(expected, actual);
		if (diff !== -1) {
			return {
				ok: false,
				message: `교체 후 바이트가 다릅니다: 기대 ${expected.length}바이트, 실제 ${actual.length}바이트, 첫 차이 위치 ${diff}.`,
			};
		}
		return { ok: true, message: "Vault.process 교체가 BOM·CRLF·한글·결합 문자·이모지·NUL 바이트를 그대로 보존합니다." };
	} finally {
		const f = app.vault.getAbstractFileByPath(path);
		if (f) await app.vault.delete(f, true);
	}
}

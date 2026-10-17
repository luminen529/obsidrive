import { App, ConfirmationModal, Modal, Setting, TextAreaComponent } from "obsidian";
import type { RemoteEntry, SyncReport } from "../sync/types";
import { humanBytes } from "../util";

export function confirmDialog(
	app: App,
	title: string,
	message: string | DocumentFragment,
	confirmText: string,
	destructive = false,
): Promise<boolean> {
	return new Promise((resolve) => {
		let result = false;
		const modal = new ConfirmationModal(app);
		modal.setTitle(title);
		modal.setContent(message);
		modal.addButton((btn) => {
			btn.setButtonText(confirmText);
			if (destructive) btn.setWarning();
			else btn.setCta();
			btn.onClick(() => {
				result = true;
				modal.close();
			});
		});
		modal.addCancelButton("취소");
		const onClose = modal.onClose.bind(modal);
		modal.onClose = () => {
			onClose();
			resolve(result);
		};
		modal.open();
	});
}

/** Lets the user paste the redirect URL from the browser (mobile login). */
export class PasteRedirectModal extends Modal {
	private value = "";
	constructor(
		app: App,
		private onSubmit: (value: string) => Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle("Google 로그인 완료하기");
		const { contentEl } = this;
		contentEl.createEl("p", {
			text:
				"브라우저에서 Google 로그인과 권한 허용을 마치면 '사이트에 연결할 수 없음' 페이지가 표시됩니다. " +
				"정상입니다. 그 페이지의 주소창 URL 전체(http://127.0.0.1…?code=… 로 시작)를 복사해서 아래에 붙여넣으세요.",
		});
		const ta = new TextAreaComponent(contentEl);
		ta.inputEl.rows = 4;
		ta.inputEl.style.width = "100%";
		ta.setPlaceholder("http://127.0.0.1:42813/?state=…&code=…");
		ta.onChange((v) => (this.value = v));
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("연결")
				.setCta()
				.onClick(async () => {
					b.setDisabled(true);
					try {
						await this.onSubmit(this.value);
						this.close();
					} finally {
						b.setDisabled(false);
					}
				}),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class LogModal extends Modal {
	constructor(
		app: App,
		private lines: string[],
		private report: SyncReport | null,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle("ObsiDrive 동기화 로그");
		const { contentEl } = this;
		const r = this.report;
		if (r) {
			const summary = contentEl.createDiv({ cls: "obsidrive-summary" });
			const when = new Date(r.startedAt).toLocaleString();
			summary.createEl("p", {
				text:
					`${r.dryRun ? "[미리보기] " : ""}${when} — ↑${r.uploaded.length} ↓${r.downloaded.length} ` +
					`🗑로컬 ${r.deletedLocal.length} 🗑원격 ${r.deletedRemote.length} ↔${r.renamed.length} ` +
					`⚔${r.conflicts.length} ⏭${r.skipped.length} ❌${r.errors.length}`,
			});
			if (r.aborted) summary.createEl("p", { text: `중단됨: ${r.aborted}`, cls: "mod-warning" });
			const section = (title: string, items: string[]) => {
				if (!items.length) return;
				const d = contentEl.createEl("details");
				d.createEl("summary", { text: `${title} (${items.length})` });
				const ul = d.createEl("ul");
				for (const i of items.slice(0, 500)) ul.createEl("li", { text: i });
				if (items.length > 500) ul.createEl("li", { text: `… 외 ${items.length - 500}개` });
			};
			section("충돌", r.conflicts);
			section("오류", r.errors.map((e) => `${e.path}: ${e.message}`));
			section("건너뜀", r.skipped.map((s) => `${s.path}: ${s.reason}`));
			if (r.dryRun && r.plan) {
				section(
					"예정된 작업",
					r.plan
						.filter((a) => a.kind !== "record" && a.kind !== "forget")
						.map((a) => {
							switch (a.kind) {
								case "upload":
									return `↑ ${a.path} — ${a.reason}`;
								case "download":
									return `↓ ${a.path} — ${a.reason}`;
								case "deleteLocal":
									return `🗑 로컬 삭제 ${a.path}`;
								case "deleteRemote":
									return `🗑 원격 삭제 ${a.path}`;
								case "renameLocal":
								case "renameRemote":
									return `↔ ${a.from} → ${a.to}`;
								case "conflict":
									return `⚔ ${a.path} — ${a.resolution}`;
								default:
									return "";
							}
						}),
				);
			}
		}
		const pre = contentEl.createEl("pre", { cls: "obsidrive-log" });
		pre.setText(this.lines.length ? this.lines.join("\n") : "로그 없음");
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Lists remote tombstones and restores the selected ones into the vault. */
export class RemoteTrashModal extends Modal {
	private selected = new Set<string>();

	constructor(
		app: App,
		private entries: RemoteEntry[],
		private restore: (entries: RemoteEntry[]) => Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle("원격 휴지통 (삭제된 파일 복원)");
		const { contentEl } = this;
		if (!this.entries.length) {
			contentEl.createEl("p", { text: "보관 중인 삭제 파일이 없습니다." });
			return;
		}
		contentEl.createEl("p", {
			text: "다른 기기나 이 기기에서 삭제된 파일입니다. 선택한 파일을 볼트에 되살리고 다시 동기화합니다.",
		});
		const list = contentEl.createDiv({ cls: "obsidrive-trash-list" });
		const sorted = [...this.entries].sort((a, b) => b.deletedAt - a.deletedAt);
		for (const e of sorted) {
			new Setting(list)
				.setName(e.path)
				.setDesc(`${new Date(e.deletedAt).toLocaleString()} 삭제 · ${humanBytes(e.size)}${e.device ? ` · ${e.device}` : ""}`)
				.addToggle((t) => t.onChange((v) => (v ? this.selected.add(e.id) : this.selected.delete(e.id))));
		}
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("선택한 파일 복원")
				.setCta()
				.onClick(async () => {
					const picked = this.entries.filter((e) => this.selected.has(e.id));
					if (!picked.length) return;
					b.setDisabled(true);
					try {
						await this.restore(picked);
						this.close();
					} finally {
						b.setDisabled(false);
					}
				}),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

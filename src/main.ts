import { debounce, Notice, Platform, Plugin, requestUrl, TAbstractFile } from "obsidian";
import {
	buildAuthUrl,
	createPkceSession,
	exchangeCode,
	MANUAL_REDIRECT_URI,
	parseRedirect,
	PkceSession,
	revokeToken,
	startLoopback,
	TokenProvider,
} from "./auth";
import { DriveClient } from "./drive";
import { PathFilter } from "./filter";
import { AuthError, HttpFn, lowerKeys } from "./http";
import { FileStateStore, ObsidianLocalFs } from "./obsidianFs";
import { DEFAULT_SETTINGS, ObsiDriveSettings } from "./settings";
import { SyncEngine, toRemoteEntry } from "./sync/engine";
import type { RemoteEntry, SyncReport } from "./sync/types";
import { ObsiDriveSettingTab } from "./ui/settingTab";
import { confirmDialog, LogModal, PasteRedirectModal, RemoteTrashModal } from "./ui/modals";
import { conflictPath, errorMessage, randomString, sha256OfString } from "./util";

const PKCE_STORAGE_KEY = "obsidrive-pkce";
const MAX_LOG_LINES = 1000;

type Status = { kind: "idle" | "syncing" | "error" | "offline" | "paused" | "disconnected"; text?: string };

export default class ObsiDrivePlugin extends Plugin {
	settings!: ObsiDriveSettings;
	tokens!: TokenProvider;
	drive!: DriveClient;

	private http: HttpFn = async (req) => {
		const res = await requestUrl({ ...req, throw: false });
		return {
			status: res.status,
			headers: lowerKeys(res.headers),
			arrayBuffer: () => res.arrayBuffer,
			text: () => res.text,
			json: () => res.json,
		};
	};

	private syncing: Promise<SyncReport | null> | null = null;
	private cancelRequested = false;
	private changedDuringSync = false;
	private localFs: ObsidianLocalFs | null = null;
	/** Our own writes keep producing vault events shortly after a sync ends. */
	private recentOwnWrites: Set<string> = new Set();
	private recentOwnWritesUntil = 0;
	private markerEnsuredFor = "";
	private statusEl: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;
	private intervalId: number | null = null;
	private pendingPkce: PkceSession | null = null;
	private settingTab: ObsiDriveSettingTab | null = null;
	logLines: string[] = [];
	lastReport: SyncReport | null = null;
	lastSyncAt = 0;
	status: Status = { kind: "idle" };

	private debouncedSync = debounce(() => void this.autoSync("변경 감지"), 30_000, true);

	async onload() {
		await this.loadSettings();

		this.tokens = new TokenProvider(
			this.http,
			() => ({ clientId: this.settings.clientId.trim(), clientSecret: this.getClientSecret() }),
			() => this.getRefreshToken(),
		);
		this.drive = new DriveClient(this.http, this.tokens, { log: (m) => this.log(m) });

		this.settingTab = new ObsiDriveSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.ribbonEl = this.addRibbonIcon("refresh-cw", "ObsiDrive: 지금 동기화", () => void this.syncNow());
		if (!Platform.isMobile) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("obsidrive-status");
			this.statusEl.onClickEvent(() => new LogModal(this.app, this.logLines, this.lastReport).open());
		}

		this.addCommand({ id: "sync-now", name: "지금 동기화", icon: "refresh-cw", callback: () => void this.syncNow() });
		this.addCommand({ id: "dry-run", name: "동기화 미리보기 (변경 없음)", callback: () => void this.dryRun() });
		this.addCommand({
			id: "show-log",
			name: "동기화 로그 보기",
			callback: () => new LogModal(this.app, this.logLines, this.lastReport).open(),
		});
		this.addCommand({ id: "remote-trash", name: "원격 휴지통에서 복원", callback: () => void this.openRemoteTrash() });
		this.addCommand({
			id: "toggle-pause",
			name: "자동 동기화 일시정지/재개",
			callback: async () => {
				this.settings.paused = !this.settings.paused;
				await this.saveSettings();
				new Notice(this.settings.paused ? "ObsiDrive 자동 동기화 일시정지" : "ObsiDrive 자동 동기화 재개");
			},
		});
		this.addCommand({ id: "cancel-sync", name: "진행 중인 동기화 취소", callback: () => (this.cancelRequested = true) });

		this.registerEvent(this.app.vault.on("modify", (f) => this.onVaultChange(f)));
		this.registerEvent(this.app.vault.on("create", (f) => this.onVaultChange(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => this.onVaultChange(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => this.onVaultChange(f, old)));

		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible" && this.settings.syncOnResume && Date.now() - this.lastSyncAt > 60_000) {
				void this.autoSync("앱 복귀");
			}
		});
		this.registerDomEvent(window, "online", () => void this.autoSync("네트워크 복구"));

		this.app.workspace.onLayoutReady(() => {
			this.restartScheduler();
			this.updateStatus();
			// Wait a moment so the vault index is complete before the first scan.
			if (this.settings.syncOnStartup) window.setTimeout(() => void this.autoSync("시작"), 3000);
		});
	}

	onunload() {
		this.cancelRequested = true;
		this.debouncedSync.cancel();
	}

	// ---------- settings & secrets ----------

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		let changed = false;
		if (!this.settings.remoteVaultName) {
			this.settings.remoteVaultName = this.app.vault.getName();
			changed = true;
		}
		if (!this.settings.deviceName) {
			this.settings.deviceName = Platform.isIosApp
				? "iOS"
				: Platform.isAndroidApp
					? "Android"
					: Platform.isMacOS
						? "Mac"
						: Platform.isWin
							? "Windows"
							: "Linux";
			changed = true;
		}
		if (changed) await this.saveData(this.settings);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.restartScheduler();
		this.updateStatus();
	}

	/** Called by Obsidian when data.json changed on disk (e.g. another sync tool). */
	async onExternalSettingsChange() {
		await this.loadSettings();
		this.restartScheduler();
	}

	getClientSecret(): string {
		const id = this.settings.clientSecretId;
		return (id && this.app.secretStorage.getSecret(id)) || "";
	}

	getRefreshToken(): string | null {
		const id = this.settings.tokenSecretId;
		return (id && this.app.secretStorage.getSecret(id)) || null;
	}

	isConnected(): boolean {
		return !!this.getRefreshToken();
	}

	private async setRefreshToken(token: string) {
		if (!this.settings.tokenSecretId) {
			this.settings.tokenSecretId = `obsidrive-token-${randomString(6).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
		}
		this.app.secretStorage.setSecret(this.settings.tokenSecretId, token);
		await this.saveSettings();
	}

	// ---------- authentication ----------

	private checkClientConfigured(): boolean {
		if (!this.settings.clientId.trim() || !this.getClientSecret()) {
			new Notice("먼저 설정에서 Google OAuth Client ID와 Client Secret을 입력하세요.");
			return false;
		}
		return true;
	}

	/** Desktop: loopback redirect, fully automatic. */
	async loginDesktop() {
		if (!this.checkClientConfigured()) return;
		const handle = await startLoopback();
		try {
			const session = await createPkceSession(handle.redirectUri);
			window.open(await buildAuthUrl(this.settings.clientId.trim(), session));
			new Notice("브라우저에서 Google 로그인을 완료하세요…", 8000);
			const result = await handle.result;
			await this.finishLogin(session, result.code, result.state, result.error);
		} catch (e) {
			handle.close();
			new Notice(`로그인 실패: ${errorMessage(e)}`, 10000);
		}
	}

	/** Mobile / fallback: user copies the redirect URL back from the browser. */
	async loginManual() {
		if (!this.checkClientConfigured()) return;
		const session = await createPkceSession(MANUAL_REDIRECT_URI);
		this.pendingPkce = session;
		// Survives the app being suspended while the user is in the browser.
		this.app.saveLocalStorage(PKCE_STORAGE_KEY, JSON.stringify(session));
		window.open(await buildAuthUrl(this.settings.clientId.trim(), session));
		new PasteRedirectModal(this.app, async (input) => {
			const s = this.pendingPkce ?? this.loadPendingPkce();
			if (!s) {
				new Notice("로그인 세션이 만료되었습니다. 다시 시도하세요.");
				return;
			}
			const r = parseRedirect(input);
			await this.finishLogin(s, r.code, r.state, r.error);
		}).open();
	}

	private loadPendingPkce(): PkceSession | null {
		try {
			const raw = this.app.loadLocalStorage(PKCE_STORAGE_KEY);
			const s = raw ? (JSON.parse(raw) as PkceSession) : null;
			return s && Date.now() - s.createdAt < 15 * 60_000 ? s : null;
		} catch {
			return null;
		}
	}

	private async finishLogin(session: PkceSession, code?: string, state?: string, error?: string) {
		try {
			if (error) throw new Error(`Google이 거부함: ${error}`);
			if (!code) throw new Error("URL에서 인증 코드를 찾을 수 없습니다.");
			if (state !== session.state) throw new Error("state 값이 일치하지 않습니다. 처음부터 다시 시도하세요.");
			const creds = { clientId: this.settings.clientId.trim(), clientSecret: this.getClientSecret() };
			const t = await exchangeCode(this.http, creds, session, code);
			this.tokens.seed(t.accessToken, t.expiresAt);
			await this.setRefreshToken(t.refreshToken);
			this.pendingPkce = null;
			this.app.saveLocalStorage(PKCE_STORAGE_KEY, null);
			try {
				const about = await this.drive.about();
				this.settings.accountEmail = about.email ?? "";
			} catch {
				this.settings.accountEmail = "";
			}
			await this.saveSettings();
			new Notice(`✅ Google Drive 연결됨${this.settings.accountEmail ? `: ${this.settings.accountEmail}` : ""}`);
			this.refreshSettingTab();
		} catch (e) {
			new Notice(`로그인 실패: ${errorMessage(e)}`, 10000);
			throw e;
		}
	}

	async logout() {
		const token = this.getRefreshToken();
		if (token) await revokeToken(this.http, token).catch(() => {});
		if (this.settings.tokenSecretId) this.app.secretStorage.setSecret(this.settings.tokenSecretId, "");
		this.tokens.clear();
		this.settings.accountEmail = "";
		await this.saveSettings();
		new Notice("Google Drive 연결 해제됨");
		this.refreshSettingTab();
	}

	refreshSettingTab() {
		this.settingTab?.update();
	}

	// ---------- sync ----------

	async vaultKey(): Promise<string> {
		return (await sha256OfString(`obsidrive:${this.settings.remoteVaultName.trim()}`)).slice(0, 24);
	}

	private onVaultChange(file: TAbstractFile, oldPath?: string) {
		if (!this.isConnected() || this.settings.paused) return;
		const isOwn = (set: Set<string> | undefined) => !!set && (set.has(file.path) || (!!oldPath && set.has(oldPath)));
		if (this.syncing) {
			if (isOwn(this.localFs?.ownWrites)) return;
			this.changedDuringSync = true;
			return;
		}
		if (Date.now() < this.recentOwnWritesUntil && isOwn(this.recentOwnWrites)) return;
		if (this.settings.syncAfterChangeSeconds > 0) this.debouncedSync();
	}

	restartScheduler() {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.intervalId = null;
		const minutes = this.settings.intervalMinutes;
		if (minutes > 0) {
			this.intervalId = this.registerInterval(window.setInterval(() => void this.autoSync("주기"), minutes * 60_000));
		}
		const secs = Math.max(5, this.settings.syncAfterChangeSeconds || 30);
		this.debouncedSync.cancel();
		this.debouncedSync = debounce(() => void this.autoSync("변경 감지"), secs * 1000, true);
	}

	async autoSync(trigger: string) {
		if (this.settings.paused || !this.isConnected() || this.syncing) return;
		if (!navigator.onLine) {
			this.setStatus({ kind: "offline" });
			return;
		}
		await this.runSync({ trigger, interactive: false });
	}

	async syncNow() {
		if (!this.isConnected()) {
			new Notice("Google Drive가 연결되어 있지 않습니다. 설정에서 로그인하세요.");
			return;
		}
		if (this.syncing) {
			new Notice("이미 동기화 중입니다.");
			return;
		}
		const r = await this.runSync({ trigger: "수동", interactive: true });
		if (r && !r.aborted && !r.errors.length) {
			new Notice(`ObsiDrive: 동기화 완료 (↑${r.uploaded.length} ↓${r.downloaded.length} 🗑${r.deletedLocal.length + r.deletedRemote.length})`);
		}
	}

	async dryRun() {
		if (!this.isConnected()) {
			new Notice("Google Drive가 연결되어 있지 않습니다.");
			return;
		}
		const r = await this.runSync({ trigger: "미리보기", interactive: true, dryRun: true });
		if (r) new LogModal(this.app, this.logLines, r).open();
	}

	private runSync(opts: { trigger: string; interactive: boolean; dryRun?: boolean }): Promise<SyncReport | null> {
		if (this.syncing) return this.syncing;
		this.syncing = this.doSync(opts).finally(() => {
			this.syncing = null;
			// Something changed while we were busy: run again soon.
			if (this.changedDuringSync && !opts.dryRun) {
				this.changedDuringSync = false;
				this.debouncedSync();
			}
		});
		return this.syncing;
	}

	private async doSync(opts: { trigger: string; interactive: boolean; dryRun?: boolean }): Promise<SyncReport | null> {
		this.cancelRequested = false;
		this.changedDuringSync = false;
		const s = this.settings;
		const filter = new PathFilter(this.app.vault.configDir, s, this.manifest.id);
		const localFs = new ObsidianLocalFs(this.app, filter);
		this.localFs = localFs;
		const vaultKey = await this.vaultKey();
		const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		const store = new FileStateStore(this.app, `${pluginDir}/sync-state.json`);

		const engine = new SyncEngine(localFs, this.drive, store, {
			vaultKey,
			device: s.deviceName || "device",
			planOptions: {
				strategy: s.conflictStrategy,
				configStrategy: s.configConflictStrategy,
				isConfigPath: (p) => filter.isConfigPath(p),
			},
			includes: (p) => filter.includes(p),
			maxBytes: filter.maxBytes,
			concurrency: Math.min(8, Math.max(1, s.concurrency)),
			deletionGuardPercent: s.deletionGuardPercent,
			tombstoneMaxAgeMs: Math.max(1, s.tombstoneDays) * 86_400_000,
			confirmDeletions: async ({ local, remote, tracked }) => {
				if (!opts.interactive) {
					new Notice(
						`ObsiDrive: 많은 파일(${local.length + remote.length}/${tracked})이 삭제될 예정이라 자동 동기화를 멈췄습니다. ` +
							`'동기화 미리보기'로 확인 후 '지금 동기화'를 실행하세요.`,
						0,
					);
					return false;
				}
				const frag = createFragment((f) => {
					f.createEl("p", { text: `추적 중인 ${tracked}개 중 다음 파일이 삭제됩니다. 계속할까요?` });
					f.createEl("p", { text: `로컬에서 삭제(휴지통으로): ${local.length}개 · 원격에서 삭제(보관): ${remote.length}개` });
					const ul = f.createEl("ul");
					for (const p of [...local.map((x) => `로컬: ${x}`), ...remote.map((x) => `원격: ${x}`)].slice(0, 30)) {
						ul.createEl("li", { text: p });
					}
				});
				return confirmDialog(this.app, "대량 삭제 확인", frag, "삭제하고 계속", true);
			},
			log: (m) => this.log(m),
			onProgress: (done, total) => this.setStatus({ kind: "syncing", text: `${done}/${total}` }),
			isCancelled: () => this.cancelRequested,
		});

		this.log(`── 동기화 시작 (${opts.trigger}${opts.dryRun ? ", 미리보기" : ""}) ──`);
		this.setStatus({ kind: "syncing" });
		try {
			if (!opts.dryRun && this.markerEnsuredFor !== vaultKey) {
				await this.drive.ensureVaultMarker(vaultKey, s.remoteVaultName.trim());
				this.markerEnsuredFor = vaultKey;
			}
			const report = await engine.run(!!opts.dryRun);
			this.lastReport = report;
			if (!opts.dryRun) this.lastSyncAt = Date.now();
			this.afterSync(report, opts.interactive);
			return report;
		} catch (e) {
			const report = (e as { report?: SyncReport }).report ?? null;
			if (report) this.lastReport = report;
			this.log(`동기화 실패: ${errorMessage(e)}`);
			if (e instanceof AuthError) {
				this.setStatus({ kind: "disconnected", text: "재로그인 필요" });
				new Notice(`ObsiDrive: ${e.message}`, 0);
			} else {
				this.setStatus({ kind: "error", text: errorMessage(e) });
				if (opts.interactive || navigator.onLine) new Notice(`ObsiDrive 동기화 실패: ${errorMessage(e)}`, 10000);
			}
			return report;
		} finally {
			this.recentOwnWrites = localFs.ownWrites;
			this.recentOwnWritesUntil = Date.now() + 5000;
			this.localFs = null;
		}
	}

	private afterSync(r: SyncReport, interactive: boolean) {
		const secs = ((r.finishedAt - r.startedAt) / 1000).toFixed(1);
		this.log(
			`── 완료 ${secs}s: ↑${r.uploaded.length} ↓${r.downloaded.length} 🗑${r.deletedLocal.length}/${r.deletedRemote.length} ` +
				`↔${r.renamed.length} ⚔${r.conflicts.length} ⏭${r.skipped.length} ❌${r.errors.length}${r.aborted ? ` (중단: ${r.aborted})` : ""}`,
		);
		if (r.aborted) {
			this.setStatus({ kind: "error", text: "중단됨" });
			if (interactive) new Notice(`ObsiDrive: ${r.aborted}`, 10000);
			return;
		}
		this.setStatus(r.errors.length ? { kind: "error", text: `오류 ${r.errors.length}건` } : { kind: "idle" });
		if (r.dryRun) return;

		if (r.conflicts.length) {
			new Notice(`ObsiDrive: 충돌 ${r.conflicts.length}건 — 두 버전을 모두 보관했습니다.\n${r.conflicts.slice(0, 5).join("\n")}`, 15000);
		}
		if (r.errors.length) {
			new Notice(`ObsiDrive: ${r.errors.length}개 파일 동기화 실패. 로그를 확인하세요.`, 10000);
		}
		if (r.configChanged) {
			const frag = createFragment((f) => {
				f.appendText("ObsiDrive: Obsidian 설정/플러그인이 다른 기기에서 변경되었습니다. 적용하려면 다시 로드하세요. ");
				const btn = f.createEl("button", { text: "지금 다시 로드" });
				btn.onclick = () => (this.app as any).commands?.executeCommandById?.("app:reload");
			});
			new Notice(frag, 0);
		}
		if (!interactive && this.settings.notifyOnSuccess && (r.uploaded.length || r.downloaded.length || r.deletedLocal.length)) {
			new Notice(`ObsiDrive: ↑${r.uploaded.length} ↓${r.downloaded.length} 🗑${r.deletedLocal.length}`);
		}
	}

	// ---------- remote trash ----------

	async openRemoteTrash() {
		if (!this.isConnected()) {
			new Notice("Google Drive가 연결되어 있지 않습니다.");
			return;
		}
		try {
			const vaultKey = await this.vaultKey();
			const entries = (await this.drive.listVault(vaultKey)).map(toRemoteEntry).filter((e) => e.deleted);
			new RemoteTrashModal(this.app, entries, (picked) => this.restoreFromTrash(picked)).open();
		} catch (e) {
			new Notice(`원격 휴지통을 불러오지 못했습니다: ${errorMessage(e)}`);
		}
	}

	private async restoreFromTrash(picked: RemoteEntry[]) {
		const filter = new PathFilter(this.app.vault.configDir, this.settings, this.manifest.id);
		const fs = new ObsidianLocalFs(this.app, filter);
		let ok = 0;
		for (const e of picked) {
			try {
				const data = await this.drive.download(e.id);
				// Never overwrite: if the path is taken, restore next to it.
				let target = e.path;
				if (await fs.stat(target)) target = conflictPath(e.path, "restored", Date.now());
				await fs.write(target, data, e.mtime);
				ok++;
			} catch (err) {
				new Notice(`복원 실패 ${e.path}: ${errorMessage(err)}`);
			}
		}
		new Notice(`${ok}개 파일을 복원했습니다. 동기화를 시작합니다.`);
		void this.syncNow();
	}

	async deleteRemoteVault() {
		const name = this.settings.remoteVaultName;
		const ok = await confirmDialog(
			this.app,
			"원격 데이터 전체 삭제",
			`Google Drive 숨김 폴더에서 원격 볼트 "${name}"의 모든 파일(삭제 보관본 포함)을 영구 삭제합니다. ` +
				`로컬 파일은 그대로 유지됩니다. 되돌릴 수 없습니다.`,
			"영구 삭제",
			true,
		);
		if (!ok) return;
		try {
			const vaultKey = await this.vaultKey();
			const files = await this.drive.listVault(vaultKey);
			const markers = (await this.drive.listVaultMarkers()).filter((m) => m.appProperties["ov"] === vaultKey);
			for (const f of [...files, ...markers]) await this.drive.remove(f.id);
			await this.resetSyncState(false);
			new Notice(`원격 파일 ${files.length}개를 삭제했습니다.`);
		} catch (e) {
			new Notice(`삭제 실패: ${errorMessage(e)}`);
		}
	}

	async resetSyncState(notify = true) {
		const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		await new FileStateStore(this.app, `${pluginDir}/sync-state.json`).clear();
		if (notify) new Notice("동기화 기준 상태를 초기화했습니다. 다음 동기화에서 전체 비교를 수행합니다.");
	}

	// ---------- status & logging ----------

	log(msg: string) {
		const line = `${new Date().toLocaleTimeString()} ${msg}`;
		this.logLines.push(line);
		if (this.logLines.length > MAX_LOG_LINES) this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES);
		console.debug(`[ObsiDrive] ${msg}`);
	}

	private setStatus(s: Status) {
		this.status = s;
		this.updateStatus();
	}

	updateStatus() {
		let s = this.status;
		if (s.kind === "idle" && !this.isConnected()) s = { kind: "disconnected" };
		if (s.kind === "idle" && this.settings.paused) s = { kind: "paused" };
		const label: Record<Status["kind"], string> = {
			idle: this.lastSyncAt ? `☁ ${new Date(this.lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "☁",
			syncing: "⟳ 동기화 중",
			error: "⚠ 동기화 오류",
			offline: "☁ 오프라인",
			paused: "⏸ 일시정지",
			disconnected: "☁ 연결 안 됨",
		};
		const text = `${label[s.kind]}${s.text && s.kind !== "idle" ? ` ${s.text}` : ""}`;
		this.statusEl?.setText(text);
		this.statusEl?.setAttr("aria-label", "ObsiDrive — 클릭해서 로그 보기");
		this.ribbonEl?.toggleClass("obsidrive-spinning", s.kind === "syncing");
	}
}

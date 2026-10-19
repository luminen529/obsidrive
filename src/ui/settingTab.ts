// Declarative settings tab (Obsidian 1.13+ getSettingDefinitions API).

import { App, Notice, Platform, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import type ObsiDrivePlugin from "../main";
import type { ObsiDriveSettings } from "../settings";
import { errorMessage, humanBytes } from "../util";

type Key = keyof ObsiDriveSettings;

export class ObsiDriveSettingTab extends PluginSettingTab {
	icon = "cloud";
	private remoteVaults: string[] | null = null;
	private quota: string | null = null;

	constructor(
		app: App,
		private plugin: ObsiDrivePlugin,
	) {
		super(app, plugin);
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as Key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
		if (key === "clientSecretId" || key === "clientId") this.plugin.tokens.clear();
		this.refreshDomState();
	}

	private syncStatusText(): string {
		const p = this.plugin;
		if (p.isSyncing()) return "동기화 중입니다…";
		if (p.needsFirstSync()) {
			return `첫 동기화가 필요합니다. 아래 원격 볼트 이름("${p.settings.remoteVaultName}")이 다른 기기와 같은지 확인한 뒤 누르세요. 그 전에는 자동 동기화가 돌지 않습니다.`;
		}
		const last = p.lastSyncAt ? `마지막 동기화: ${new Date(p.lastSyncAt).toLocaleString()}` : "아직 동기화하지 않았습니다.";
		const r = p.lastReport;
		const tail = r?.aborted ? ` · 중단됨: ${r.aborted}` : r?.errors.length ? ` · 오류 ${r.errors.length}건 (로그 확인)` : "";
		return `${last}${tail}`;
	}

	getSettingDefinitions(): SettingDefinitionItem<Key>[] {
		const p = this.plugin;
		const connected = () => p.isConnected();

		return [
			{
				type: "group",
				heading: "Google 계정",
				items: [
					{
						name: "OAuth Client ID",
						desc: "Google Cloud Console에서 만든 'Desktop app' 유형의 OAuth 클라이언트 ID. (README의 설정 가이드 참고)",
						control: { type: "text", key: "clientId", placeholder: "xxxxxxxx.apps.googleusercontent.com" },
					},
					{
						name: "OAuth Client Secret",
						desc: "Client Secret은 OS 키체인(Obsidian Secret Storage)에 저장되며 data.json에는 남지 않습니다.",
						control: { type: "secret", key: "clientSecretId" },
					},
					{
						name: "연결 상태",
						desc: connected()
							? `연결됨${p.settings.accountEmail ? `: ${p.settings.accountEmail}` : ""}${this.quota ? ` · ${this.quota}` : ""}`
							: "연결되지 않음",
						render: (setting) => {
							if (connected()) {
								setting.addButton((b) =>
									b.setButtonText("저장 용량 확인").onClick(async () => {
										try {
											const a = await p.drive.about();
											this.quota =
												a.usage !== undefined
													? `Drive 사용량 ${humanBytes(a.usage)}${a.limit ? ` / ${humanBytes(a.limit)}` : ""}`
													: null;
											this.update();
										} catch (e) {
											new Notice(errorMessage(e));
										}
									}),
								);
								setting.addButton((b) => b.setButtonText("연결 해제").setWarning().onClick(() => void p.logout()));
							} else {
								if (Platform.isDesktopApp) {
									setting.addButton((b) => b.setButtonText("Google 로그인").setCta().onClick(() => void p.loginDesktop()));
								}
								setting.addButton((b) => {
									b.setButtonText(Platform.isDesktopApp ? "수동 로그인 (URL 붙여넣기)" : "Google 로그인");
									if (!Platform.isDesktopApp) b.setCta();
									b.onClick(() => void p.loginManual());
								});
							}
						},
					},
				],
			},
			{
				type: "group",
				heading: "동기화",
				visible: () => connected(),
				items: [
					{
						name: "지금 동기화",
						desc: this.syncStatusText(),
						render: (setting) => {
							setting.addButton((b) => {
								b.setButtonText(p.isSyncing() ? "동기화 중…" : "지금 동기화")
									.setCta()
									.setDisabled(p.isSyncing())
									.onClick(async () => {
										b.setDisabled(true).setButtonText("동기화 중…");
										try {
											await p.syncNow();
										} finally {
											this.update();
										}
									});
							});
							setting.addButton((b) => b.setButtonText("미리보기").onClick(() => void p.dryRun()));
						},
					},
				],
			},
			{
				type: "group",
				heading: "원격 볼트",
				items: [
					{
						name: "원격 볼트 이름",
						desc:
							"Google Drive의 숨김 앱 폴더(appDataFolder) 안에서 이 볼트를 구분하는 이름. 같은 볼트를 동기화할 모든 기기에서 동일하게 설정하세요. " +
							"변경하면 다른 원격 볼트로 전환됩니다(기존 기준 상태는 무시되며, 삭제는 발생하지 않습니다).",
						control: {
							type: "text",
							key: "remoteVaultName",
							validate: (v) => (v.trim() ? undefined : "비워둘 수 없습니다."),
						},
					},
					{
						name: "원격에 있는 볼트",
						desc: this.remoteVaults
							? this.remoteVaults.length
								? this.remoteVaults.join(", ")
								: "없음"
							: "불러오기를 눌러 이 Google 계정의 원격 볼트 목록을 확인합니다.",
						visible: () => connected(),
						render: (setting) => {
							setting.addButton((b) =>
								b.setButtonText("불러오기").onClick(async () => {
									try {
										const markers = await p.drive.listVaultMarkers();
										this.remoteVaults = markers.map((m) => m.name.replace(/^\.obsidrive-vault\//, ""));
										this.update();
									} catch (e) {
										new Notice(errorMessage(e));
									}
								}),
							);
						},
					},
					{
						name: "기기 이름",
						desc: "충돌 사본 파일명과 로그에 표시됩니다.",
						control: { type: "text", key: "deviceName" },
					},
				],
			},
			{
				type: "group",
				heading: "자동 동기화",
				items: [
					{ name: "시작 시 동기화", control: { type: "toggle", key: "syncOnStartup" } },
					{
						name: "주기적 동기화 (분)",
						desc: "0이면 사용 안 함.",
						control: { type: "number", key: "intervalMinutes", min: 0, max: 1440 },
					},
					{
						name: "편집 후 동기화 (초)",
						desc: "마지막 변경 후 이 시간 동안 추가 변경이 없으면 동기화합니다. 0이면 사용 안 함.",
						control: { type: "number", key: "syncAfterChangeSeconds", min: 0, max: 3600 },
					},
					{
						name: "앱으로 돌아올 때 동기화",
						desc: "모바일에서 앱을 다시 열거나 창이 다시 보일 때 동기화합니다.",
						control: { type: "toggle", key: "syncOnResume" },
					},
					{ name: "자동 동기화 일시정지", control: { type: "toggle", key: "paused" } },
					{
						name: "자동 동기화 결과 알림",
						desc: "변경이 있을 때마다 알림을 표시합니다. (오류·충돌은 항상 표시)",
						control: { type: "toggle", key: "notifyOnSuccess" },
					},
				],
			},
			{
				type: "group",
				heading: "동기화 대상",
				items: [
					{
						name: "Obsidian 설정",
						desc: "설정 폴더의 app.json, appearance.json, hotkeys.json, core-plugins.json 등.",
						control: { type: "toggle", key: "syncCoreSettings" },
					},
					{ name: "테마", control: { type: "toggle", key: "syncThemes" } },
					{ name: "CSS 스니펫", control: { type: "toggle", key: "syncSnippets" } },
					{
						name: "커뮤니티 플러그인",
						desc: "플러그인 코드(main.js, manifest.json, styles.css). 켜고 끄는 건 기기마다 따로 정하고, 다른 기기에서 새로 설치된 플러그인은 자동으로 켜집니다.",
						control: { type: "toggle", key: "syncPlugins" },
					},
					{
						name: "플러그인 설정 (data.json)",
						desc: "각 플러그인의 data.json. ObsiDrive 자신의 설정·토큰은 절대 동기화되지 않습니다.",
						control: { type: "toggle", key: "syncPluginData", disabled: () => !p.settings.syncPlugins },
					},
					{
						name: "제외할 플러그인 ID",
						desc: "쉼표 또는 줄바꿈으로 구분. 예: obsidian-git, 기기별로 다르게 쓰는 플러그인.",
						control: {
							type: "textarea",
							key: "excludedPlugins",
							placeholder: "obsidian-git",
							disabled: () => !p.settings.syncPlugins,
						},
					},
					{
						name: "워크스페이스 레이아웃",
						desc: "workspace.json / workspace-mobile.json (열린 탭, 패널 배치). 기기마다 자주 바뀌므로 기본은 끔.",
						control: { type: "toggle", key: "syncWorkspace" },
					},
					{
						name: "제외 패턴",
						desc: "한 줄에 하나. glob(예: Archive/**, *.tmp, Private/) 또는 /정규식/. '/'가 없는 패턴은 모든 위치의 이름과 일치합니다.",
						control: { type: "textarea", key: "ignorePatterns", placeholder: "Archive/**\n*.tmp" },
					},
					{
						name: "최대 파일 크기 (MB)",
						desc: "이보다 큰 파일은 양쪽 모두에서 무시됩니다(삭제되지 않음). 모바일 메모리를 고려하세요.",
						control: { type: "number", key: "maxFileSizeMB", min: 1, max: 2048 },
					},
				],
			},
			{
				type: "group",
				heading: "충돌 처리 및 안전장치",
				items: [
					{
						name: "노트 충돌 처리",
						desc: "두 기기에서 같은 파일을 서로 다르게 수정했을 때.",
						control: {
							type: "dropdown",
							key: "conflictStrategy",
							options: {
								keepBoth: "둘 다 보관 (충돌 사본 생성, 권장)",
								newer: "더 최근 수정본 사용",
								local: "항상 이 기기 버전 사용",
								remote: "항상 원격 버전 사용",
							},
						},
					},
					{
						name: "설정 파일 충돌 처리",
						desc: "설정 폴더(.obsidian) 내 파일은 충돌 사본이 의미가 없으므로 한쪽을 선택합니다.",
						control: {
							type: "dropdown",
							key: "configConflictStrategy",
							options: { newer: "더 최근 수정본 사용 (권장)", local: "항상 이 기기 버전", remote: "항상 원격 버전" },
						},
					},
					{
						name: "대량 삭제 보호 (%)",
						desc: "한 번의 동기화에서 추적 중인 파일의 이 비율 이상(그리고 5개 초과)이 삭제될 예정이면 확인을 요청하고, 자동 동기화는 중단합니다.",
						control: { type: "number", key: "deletionGuardPercent", min: 1, max: 100 },
					},
					{
						name: "원격 삭제 보관 기간 (일)",
						desc: "원격에서 삭제된 파일은 이 기간 동안 숨김 폴더에 보관되어 '원격 휴지통에서 복원'으로 되살릴 수 있습니다.",
						control: { type: "number", key: "tombstoneDays", min: 1, max: 3650 },
					},
					{
						name: "동시 전송 수",
						desc: "1~8. 모바일이나 느린 네트워크에서는 낮추세요.",
						control: { type: "number", key: "concurrency", min: 1, max: 8 },
					},
				],
			},
			{
				type: "group",
				heading: "도구",
				items: [
					{
						name: "동기화 미리보기",
						desc: "아무것도 바꾸지 않고 다음 동기화에서 일어날 작업을 보여줍니다. 첫 동기화 전에 권장.",
						visible: () => connected(),
						render: (s) => {
							s.addButton((b) => b.setButtonText("미리보기").onClick(() => void p.dryRun()));
						},
					},
					{
						name: "원격 휴지통",
						desc: "삭제된 파일을 원격 보관본에서 복원합니다.",
						visible: () => connected(),
						render: (s) => {
							s.addButton((b) => b.setButtonText("열기").onClick(() => void p.openRemoteTrash()));
						},
					},
					{
						name: "동기화 기준 상태 초기화",
						desc: "다음 동기화에서 모든 파일을 내용(해시)으로 다시 비교합니다. 삭제는 발생하지 않으며, 내용이 다른 파일은 충돌로 처리됩니다.",
						render: (s) => {
							s.addButton((b) => b.setButtonText("초기화").onClick(() => void p.resetSyncState()));
						},
					},
					{
						name: "이 원격 볼트 데이터 영구 삭제",
						desc: "숨김 폴더에서 이 원격 볼트의 모든 파일을 지웁니다. 로컬 파일은 유지됩니다.",
						visible: () => connected(),
						render: (s) => {
							s.addButton((b) => b.setButtonText("원격 데이터 삭제").setWarning().onClick(() => void p.deleteRemoteVault()));
						},
					},
				],
			},
		];
	}
}

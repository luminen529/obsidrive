import type { ConflictStrategy } from "./sync/types";

export interface ObsiDriveSettings {
	// Google account
	clientId: string;
	/** SecretStorage id that holds the OAuth client secret (chosen by the user). */
	clientSecretId: string;
	/** SecretStorage id that holds the refresh token (managed by the plugin). */
	tokenSecretId: string;
	accountEmail: string;

	// Remote
	remoteVaultName: string;
	deviceName: string;

	// Automation
	syncOnStartup: boolean;
	intervalMinutes: number;
	syncAfterChangeSeconds: number;
	syncOnResume: boolean;
	paused: boolean;

	// What to sync
	syncCoreSettings: boolean;
	syncThemes: boolean;
	syncSnippets: boolean;
	syncPlugins: boolean;
	syncPluginData: boolean;
	syncWorkspace: boolean;
	excludedPlugins: string;
	ignorePatterns: string;
	maxFileSizeMB: number;

	// Conflicts & safety
	conflictStrategy: ConflictStrategy;
	configConflictStrategy: Exclude<ConflictStrategy, "keepBoth">;
	deletionGuardPercent: number;
	tombstoneDays: number;
	concurrency: number;
	notifyOnSuccess: boolean;
}

export const DEFAULT_SETTINGS: ObsiDriveSettings = {
	clientId: "",
	clientSecretId: "",
	tokenSecretId: "",
	accountEmail: "",

	remoteVaultName: "",
	deviceName: "",

	syncOnStartup: true,
	intervalMinutes: 5,
	syncAfterChangeSeconds: 30,
	syncOnResume: true,
	paused: false,

	syncCoreSettings: true,
	syncThemes: true,
	syncSnippets: true,
	syncPlugins: true,
	syncPluginData: true,
	syncWorkspace: false,
	excludedPlugins: "",
	ignorePatterns: "",
	maxFileSizeMB: 100,

	conflictStrategy: "keepBoth",
	configConflictStrategy: "newer",
	deletionGuardPercent: 30,
	tombstoneDays: 30,
	concurrency: 4,
	notifyOnSuccess: false,
};

export function splitList(s: string): string[] {
	return s
		.split(/[\n,]/)
		.map((x) => x.trim())
		.filter(Boolean);
}

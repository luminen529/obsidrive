// Which community plugins are enabled is decided per device: community-plugins.json
// is never synced. Installs, updates and removals still follow the other devices,
// because the plugin files themselves are synced. After a sync, plugins that sync
// installed here are enabled, and plugins that sync removed are disabled.

import type { App, PluginManifest } from "obsidian";
import type { SyncReport } from "./sync/types";

/** Obsidian's internal plugin manager (not part of the public API). */
interface PluginManager {
	enabledPlugins: Set<string>;
	plugins: Record<string, unknown>;
	saveConfig?: () => Promise<void>;
	disablePlugin?: (id: string) => Promise<void>;
}

const MANIFEST = "manifest.json";

/** Ids of plugin folders that hold a manifest.json. */
export async function installedPluginIds(app: App): Promise<Set<string>> {
	const adapter = app.vault.adapter;
	const root = `${app.vault.configDir}/plugins`;
	const ids = new Set<string>();
	if (!(await adapter.exists(root))) return ids;
	for (const folder of (await adapter.list(root)).folders) {
		if (await adapter.exists(`${folder}/${MANIFEST}`)) ids.add(folder.slice(root.length + 1));
	}
	return ids;
}

/**
 * Decides which plugins to switch on or off on this device after a sync.
 * - First sync with a remote vault: every synced plugin is enabled.
 * - Later syncs: a plugin is enabled only when sync installed it (its manifest was
 *   downloaded and it was not installed before). Updates keep the device's choice.
 * - A plugin whose manifest sync deleted, and which is gone now, is disabled.
 */
export function planPluginStates(o: {
	configDir: string;
	before: Set<string>;
	after: Set<string>;
	report: Pick<SyncReport, "downloaded" | "deletedLocal">;
	firstSync: boolean;
	enabled: Set<string>;
	isSynced: (manifestPath: string) => boolean;
}): { enable: string[]; disable: string[] } {
	const prefix = `${o.configDir}/plugins/`;
	const idOf = (path: string) => {
		if (!path.startsWith(prefix) || !path.endsWith(`/${MANIFEST}`)) return null;
		const id = path.slice(prefix.length, -MANIFEST.length - 1);
		return id && !id.includes("/") ? id : null;
	};
	const manifestPath = (id: string) => `${prefix}${id}/${MANIFEST}`;

	const installed = o.report.downloaded.map(idOf).filter((id): id is string => !!id && !o.before.has(id));
	const candidates = o.firstSync ? [...o.after].filter((id) => o.isSynced(manifestPath(id))) : installed;
	const enable = [...new Set(candidates)].filter((id) => o.after.has(id) && !o.enabled.has(id));

	const removed = o.report.deletedLocal.map(idOf).filter((id): id is string => !!id && !o.after.has(id));
	const disable = [...new Set(removed)].filter((id) => o.enabled.has(id));
	return { enable, disable };
}

/** Applies the decision through Obsidian's plugin manager. Enabled plugins load on the next reload. */
export async function applyPluginStates(
	app: App,
	o: { before: Set<string>; report: SyncReport; firstSync: boolean; isMobile: boolean; isSynced: (path: string) => boolean },
	log: (msg: string) => void,
): Promise<boolean> {
	const pm = (app as unknown as { plugins?: PluginManager }).plugins;
	if (!pm?.enabledPlugins) return false;
	const configDir = app.vault.configDir;
	const after = await installedPluginIds(app);
	const { enable, disable } = planPluginStates({
		configDir,
		before: o.before,
		after,
		report: o.report,
		firstSync: o.firstSync,
		enabled: pm.enabledPlugins,
		isSynced: o.isSynced,
	});

	const enabled: string[] = [];
	for (const id of enable) {
		if (o.isMobile && (await readManifest(app, id))?.isDesktopOnly) {
			log(`플러그인 활성화 건너뜀 (데스크톱 전용): ${id}`);
			continue;
		}
		pm.enabledPlugins.add(id);
		enabled.push(id);
	}
	for (const id of disable) {
		// Unload code that is still running even though its files are gone.
		if (pm.plugins[id]) await pm.disablePlugin?.(id).catch(() => {});
		pm.enabledPlugins.delete(id);
	}
	if (!enabled.length && !disable.length) return false;

	if (pm.saveConfig) await pm.saveConfig();
	else await app.vault.adapter.write(`${configDir}/community-plugins.json`, JSON.stringify([...pm.enabledPlugins], null, 2));
	if (enabled.length) log(`이 기기에서 플러그인 활성화: ${enabled.join(", ")}`);
	if (disable.length) log(`삭제된 플러그인 비활성화: ${disable.join(", ")}`);
	return enabled.length > 0;
}

async function readManifest(app: App, id: string): Promise<PluginManifest | null> {
	try {
		return JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/plugins/${id}/${MANIFEST}`)) as PluginManifest;
	} catch {
		return null;
	}
}

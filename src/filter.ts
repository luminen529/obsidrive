// Decides which paths take part in sync. Must be deterministic and applied
// identically to local, remote and base paths, otherwise a path excluded on
// one side would look "deleted" to the planner.

import { ObsiDriveSettings, splitList } from "./settings";
import { basename, patternToRegExp } from "./util";

const PLUGIN_CODE_FILES = new Set(["main.js", "manifest.json", "styles.css"]);
const DEVICE_LOCAL_CONFIG = new Set(["workspace.json", "workspace-mobile.json"]);
const JUNK_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
/** Temporary notes created by the "text replace self-test" command; never synced. */
export const SELFTEST_PREFIX = "__obsidrive_selftest__";

export class PathFilter {
	private ignore: RegExp[];
	private excludedPlugins: Set<string>;
	private configPrefix: string;

	constructor(
		configDir: string,
		private s: ObsiDriveSettings,
		ownPluginId: string,
	) {
		this.configPrefix = `${configDir}/`;
		this.ignore = splitList(s.ignorePatterns.replace(/,/g, "\n"))
			.map(patternToRegExp)
			.filter((r): r is RegExp => r !== null);
		this.excludedPlugins = new Set(splitList(s.excludedPlugins));
		this.excludedPlugins.add(ownPluginId);
	}

	get maxBytes() {
		return Math.max(1, this.s.maxFileSizeMB) * 1024 * 1024;
	}

	isConfigPath(path: string): boolean {
		return path.startsWith(this.configPrefix);
	}

	/** Which sub-folders of the config dir need to be walked locally. */
	configScanRoots(): { topLevel: boolean; themes: boolean; snippets: boolean; plugins: boolean } {
		const s = this.s;
		return {
			topLevel: s.syncCoreSettings || s.syncWorkspace || s.syncPlugins,
			themes: s.syncThemes,
			snippets: s.syncSnippets,
			plugins: s.syncPlugins,
		};
	}

	includes(path: string): boolean {
		if (!path || path.startsWith("/") || path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
			return false;
		}
		if (JUNK_NAMES.has(basename(path)) || basename(path).startsWith(SELFTEST_PREFIX)) return false;
		if (this.ignore.some((r) => r.test(path))) return false;

		if (!this.isConfigPath(path)) {
			// Regular vault content. Obsidian itself ignores dot-folders, so do we.
			return !path.split("/").some((seg) => seg.startsWith("."));
		}

		const rel = path.slice(this.configPrefix.length);
		const parts = rel.split("/");
		const s = this.s;

		if (parts.length === 1) {
			const name = parts[0];
			if (!name.endsWith(".json")) return false;
			if (DEVICE_LOCAL_CONFIG.has(name)) return s.syncWorkspace;
			if (name === "community-plugins.json") return s.syncPlugins;
			return s.syncCoreSettings;
		}
		if (parts[0] === "themes") return s.syncThemes && parts.length === 3;
		if (parts[0] === "snippets") return s.syncSnippets && parts.length === 2 && rel.endsWith(".css");
		if (parts[0] === "plugins" && parts.length === 3) {
			const [, id, file] = parts;
			if (!s.syncPlugins || this.excludedPlugins.has(id)) return false;
			if (PLUGIN_CODE_FILES.has(file)) return true;
			if (file === "data.json") return s.syncPluginData;
		}
		return false;
	}
}

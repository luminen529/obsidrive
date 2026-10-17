// Publishes a GitHub Release with the built plugin files (for BRAT installs).
// Runs locally with git + gh; no GitHub Actions involved.
//
//   npm run release                  # release notes generated from commits
//   npm run release -- "notes text"  # custom release notes
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ASSETS = ["dist/main.js", "dist/manifest.json", "dist/styles.css"];

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryOut = (cmd, args) => {
	try {
		return out(cmd, args);
	} catch {
		return null;
	}
};
const fail = (msg) => {
	console.error(`\n✖ ${msg}`);
	process.exit(1);
};
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const manifest = readJson("manifest.json");
const pkg = readJson("package.json");
const versions = readJson("versions.json");
const version = manifest.version;
const tag = version; // Obsidian convention: tag equals the version, no "v" prefix.

if (pkg.version !== version) fail(`package.json (${pkg.version}) and manifest.json (${version}) versions differ.`);
if (versions[version] !== manifest.minAppVersion) fail(`versions.json has no entry "${version}": "${manifest.minAppVersion}".`);
if (out("git", ["status", "--porcelain"])) fail("Working tree is not clean. Commit or stash first.");
if (tryOut("gh", ["release", "view", tag, "--json", "tagName"])) fail(`Release ${tag} already exists. Bump the version first (npm version patch).`);

const head = out("git", ["rev-parse", "HEAD"]);
const localTag = tryOut("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]);
if (localTag && localTag !== head) fail(`Local tag ${tag} points to another commit.`);

console.log(`\n▶ Testing and building ${version}…`);
execSync("npm test", { stdio: "inherit" });
execSync("npm run build", { stdio: "inherit" });

console.log(`\n▶ Pushing branch and tag ${tag}…`);
if (!localTag) run("git", ["tag", "-a", tag, "-m", tag]);
run("git", ["push", "origin", "HEAD"]);
run("git", ["push", "origin", `refs/tags/${tag}`]);

console.log(`\n▶ Creating GitHub release ${tag}…`);
const notes = process.argv.slice(2).join(" ").trim();
run("gh", ["release", "create", tag, ...ASSETS, "--verify-tag", "--title", tag, ...(notes ? ["--notes", notes] : ["--generate-notes"])]);

console.log(`\n✔ Released ${tag}`);

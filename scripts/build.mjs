// Bundles the plugin into dist/ together with manifest.json and styles.css,
// i.e. exactly the files Obsidian loads (and the release uploads).
//
//   node scripts/build.mjs             # watch mode for development
//   node scripts/build.mjs production  # one-off minified build
import esbuild from "esbuild";
import builtins from "builtin-modules";
import { copyFileSync, mkdirSync } from "node:fs";
import process from "node:process";

const prod = process.argv[2] === "production";
const OUT = "dist";

const copyStatic = {
	name: "copy-static",
	setup(build) {
		build.onEnd(() => {
			mkdirSync(OUT, { recursive: true });
			copyFileSync("manifest.json", `${OUT}/manifest.json`);
			copyFileSync("src/styles.css", `${OUT}/styles.css`);
		});
	},
};

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
	format: "cjs",
	target: "es2021",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	outfile: `${OUT}/main.js`,
	plugins: [copyStatic],
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}

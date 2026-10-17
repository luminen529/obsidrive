import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: fileURLToPath(new URL("..", import.meta.url)),
	// The real "obsidian" package has no runtime code; tests use a small in-memory stand-in.
	resolve: { alias: { obsidian: fileURLToPath(new URL("./obsidianStub.ts", import.meta.url)) } },
	test: { include: ["tests/**/*.test.ts"] },
});

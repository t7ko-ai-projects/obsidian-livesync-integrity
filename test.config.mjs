import { obsidianStubPlugin } from "./tests/helpers/obsidian-stub.mjs";
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const outputDir = await mkdtemp(join(tmpdir(), "livesync-integrity-tests-"));
const testFiles = readdirSync("tests")
	.filter((name) => name.endsWith(".test.ts"))
	.sort();
const outputFiles = testFiles.map((name) =>
	join(outputDir, name.replace(/\.ts$/, ".mjs")),
);

try {
	await build({
		entryPoints: testFiles.map((name) => `tests/${name}`),
		bundle: true,
		platform: "node",
		format: "esm",
		outdir: outputDir,
		outExtension: { ".js": ".mjs" },
		logLevel: "silent",
		plugins: [obsidianStubPlugin],
	});
	const exitCode = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--test", ...outputFiles], {
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code) => resolve(code ?? 1));
	});
	if (exitCode !== 0) {
		process.exitCode = exitCode;
	}
} finally {
	await rm(outputDir, { recursive: true, force: true });
}

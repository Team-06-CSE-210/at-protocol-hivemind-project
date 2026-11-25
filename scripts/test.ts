import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const npm = process.env.npm_execpath;
if (!npm) {
	throw new Error("Run the test suite with npm test");
}

const options = {
	cwd: join(import.meta.dirname, ".."),
	stdio: "inherit",
} as const;
const dist = join(options.cwd, "dist");
mkdirSync(dist, { recursive: true });
const outDir = mkdtempSync(join(dist, "test-"));

try {
	const build = spawnSync(
		process.execPath,
		[npm, "run", "build", "--", "--outDir", outDir],
		options,
	);
	if (build.error) throw build.error;
	process.exitCode = build.status ?? 1;
	if (process.exitCode === 0) {
		const test = spawnSync(
			process.execPath,
			["--test", `${outDir}/tests/**/*.test.js`],
			options,
		);
		if (test.error) throw test.error;
		process.exitCode = test.status ?? 1;
	}
} finally {
	rmSync(outDir, { recursive: true, force: true });
}

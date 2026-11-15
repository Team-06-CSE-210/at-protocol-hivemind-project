/*
 * Generates TypeScript types and validators from all Hivemind lexicons.
 *
 * The lexicons live in several folders (general message types, one folder per
 * application, external interfaces) whose paths do not mirror the NSIDs. This
 * script collects them, places each one at the path its `id` implies, and runs
 * `lex build` on that merged tree. Output: protocol/generated/ (not committed).
 *
 * Run with: npm run lex:build
 */
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const protocolDir = join(import.meta.dirname, "..", "protocol");
const outputDir = join(protocolDir, "generated");
const applicationsDir = join(
	protocolDir,
	"type_definition/msg_types/applications",
);

/* Every folder that holds lexicons. Each application folder is its own root. */
const lexiconRoots = [
	join(protocolDir, "type_definition/msg_types/general"),
	...readdirSync(applicationsDir).map((name) => join(applicationsDir, name)),
	join(protocolDir, "interfaces/external"),
];

function listJsonFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) {
			return listJsonFiles(path);
		}
		return path.endsWith(".json") ? [path] : [];
	});
}

/* Copy each lexicon to <merged>/<nsid as path>.json and refuse duplicate NSIDs. */
const mergedDir = mkdtempSync(join(tmpdir(), "hivemind-lexicons-"));
const sourceById = new Map<string, string>();
for (const root of lexiconRoots.filter((root) => existsSync(root))) {
	for (const file of listJsonFiles(root)) {
		const document = JSON.parse(readFileSync(file, "utf8"));
		if (document.lexicon !== 1 || typeof document.id !== "string") {
			throw new Error(`Not a lexicon (missing "lexicon": 1 or "id"): ${file}`);
		}
		const previous = sourceById.get(document.id);
		if (previous) {
			throw new Error(
				`NSID ${document.id} is defined twice: ${previous} and ${file}`,
			);
		}
		sourceById.set(document.id, file);
		const target = join(mergedDir, `${document.id.replaceAll(".", "/")}.json`);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(file, target);
	}
}

/* Generate the code. --clear empties the output folder first. */
const result = spawnSync(
	"npx",
	[
		"--no-install",
		"lex",
		"build",
		"--lexicons",
		mergedDir,
		"--out",
		outputDir,
		"--index-file",
		"--clear",
	],
	{ stdio: "inherit" },
);
rmSync(mergedDir, { recursive: true, force: true });
if (result.status !== 0) {
	process.exit(result.status ?? 1);
}
console.log(`Generated ${sourceById.size} lexicons into ${outputDir}`);

import * as fs from "node:fs";
import * as path from "node:path";
import * as orchestrator from "../workspaces/orchestrator.js";

// Bump this when plugin-owned workspace files change (SOUL/IDENTITY/AGENTS).
// On first boot (no version file), all plugin-owned files are written.
// On subsequent boots, files are only seeded if missing — UI edits are preserved.
const WORKSPACE_VERSION = "8";
const VERSION_FILE = ".plugin-version";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
}

function writeIfMissing(filePath: string, content: string): void {
	if (!fs.existsSync(filePath)) writeFile(filePath, content);
}

export function bootstrapWorkspaces(workspaceBase: string, logger: Logger): void {
	const dir = path.join(workspaceBase, "orchestrator");
	const versionPath = path.join(dir, VERSION_FILE);

	const diskVersion = fs.existsSync(versionPath)
		? fs.readFileSync(versionPath, "utf8").trim()
		: null;
	const firstBoot = diskVersion === null;

	// First boot: write all files unconditionally to seed the workspace.
	// Subsequent boots: only write files that are missing so UI edits are preserved.
	const write = firstBoot ? writeFile : writeIfMissing;

	if (diskVersion !== WORKSPACE_VERSION) {
		logger.info(
			firstBoot
				? `claw-mafia-finance: seeding workspace v${WORKSPACE_VERSION} for orchestrator`
				: `claw-mafia-finance: ensuring workspace files for orchestrator (v${diskVersion} → v${WORKSPACE_VERSION})`,
		);
		write(path.join(dir, "SOUL.md"), orchestrator.SOUL);
		write(path.join(dir, "IDENTITY.md"), orchestrator.IDENTITY);
		write(path.join(dir, "AGENTS.md"), orchestrator.AGENTS);
		writeFile(versionPath, WORKSPACE_VERSION);
	}
	logger.info("claw-mafia-finance: orchestrator workspace bootstrapped");
}

/** Resolve the workspace base directory.
 * Respects OPENCLAW_WORKSPACE_DIR env var (set by Railway/Docker wrapper),
 * falling back to {stateDir}/workspace for local development.
 */
export function resolveWorkspaceBase(stateDir: string): string {
	const envDir = process.env.OPENCLAW_WORKSPACE_DIR?.trim();
	if (envDir) return envDir;
	return path.join(stateDir, "workspace");
}

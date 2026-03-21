import * as fs from "node:fs";
import * as path from "node:path";
import { SHARED_AGENTS_MD } from "../workspaces/_shared.js";
import * as orchestrator from "../workspaces/orchestrator.js";
import * as marketData from "../workspaces/market-data.js";
import * as strategyResearch from "../workspaces/strategy-research.js";
import * as backtester from "../workspaces/backtester.js";
import * as riskManager from "../workspaces/risk-manager.js";
import * as paperExecutor from "../workspaces/paper-executor.js";
import * as reviewer from "../workspaces/reviewer.js";

// Bump this when plugin-owned workspace files change (SOUL/IDENTITY/TOOLS/HEARTBEAT/WORKFLOW/AGENTS).
// On boot, if the version on disk differs, all plugin-owned files are rewritten.
// Never touches USER.md or MEMORY.md — those are owned by OpenClaw.
const WORKSPACE_VERSION = "3";
const VERSION_FILE = ".plugin-version";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

type AgentWorkspace = {
	id: string;
	soul: string;
	identity: string;
	tools: string;
	heartbeat?: string;
};

type AgentWorkspaceExtended = AgentWorkspace & { workflow?: string };

const AGENT_WORKSPACES: AgentWorkspaceExtended[] = [
	{ id: "orchestrator",      soul: orchestrator.SOUL,      identity: orchestrator.IDENTITY,      tools: orchestrator.TOOLS,      heartbeat: orchestrator.HEARTBEAT, workflow: orchestrator.WORKFLOW },
	{ id: "market-data",       soul: marketData.SOUL,        identity: marketData.IDENTITY,        tools: marketData.TOOLS },
	{ id: "strategy-research", soul: strategyResearch.SOUL,  identity: strategyResearch.IDENTITY,  tools: strategyResearch.TOOLS },
	{ id: "backtester",        soul: backtester.SOUL,        identity: backtester.IDENTITY,        tools: backtester.TOOLS },
	{ id: "risk-manager",      soul: riskManager.SOUL,       identity: riskManager.IDENTITY,       tools: riskManager.TOOLS,       heartbeat: riskManager.HEARTBEAT },
	{ id: "paper-executor",    soul: paperExecutor.SOUL,     identity: paperExecutor.IDENTITY,     tools: paperExecutor.TOOLS,     heartbeat: paperExecutor.HEARTBEAT },
	{ id: "reviewer",          soul: reviewer.SOUL,          identity: reviewer.IDENTITY,          tools: reviewer.TOOLS },
];

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
}

function writeIfMissing(filePath: string, content: string): void {
	if (!fs.existsSync(filePath)) writeFile(filePath, content);
}

export function bootstrapWorkspaces(workspaceBase: string, logger: Logger): void {
	for (const agent of AGENT_WORKSPACES) {
		const dir = path.join(workspaceBase, agent.id);
		const versionPath = path.join(dir, VERSION_FILE);

		// Check if plugin-owned files need to be (re)written
		const diskVersion = fs.existsSync(versionPath)
			? fs.readFileSync(versionPath, "utf8").trim()
			: null;
		const needsWrite = diskVersion !== WORKSPACE_VERSION;

		if (needsWrite) {
			logger.info(`claw-mafia-finance: writing workspace v${WORKSPACE_VERSION} for agent ${agent.id}`);
			writeFile(path.join(dir, "SOUL.md"),     agent.soul);
			writeFile(path.join(dir, "IDENTITY.md"), agent.identity);
			writeFile(path.join(dir, "AGENTS.md"),   SHARED_AGENTS_MD);
			writeFile(path.join(dir, "TOOLS.md"),    agent.tools);
			if (agent.heartbeat) writeFile(path.join(dir, "HEARTBEAT.md"), agent.heartbeat);
			if ((agent as AgentWorkspaceExtended).workflow) {
				writeFile(path.join(dir, "WORKFLOW.md"), (agent as AgentWorkspaceExtended).workflow!);
			}
			writeFile(versionPath, WORKSPACE_VERSION);
		}
	}
	logger.info("claw-mafia-finance: agent workspaces bootstrapped");
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

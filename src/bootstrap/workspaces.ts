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

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

type AgentWorkspace = {
	id: string;
	soul: string;
	identity: string;
	tools: string;
	heartbeat?: string;
};

const AGENT_WORKSPACES: AgentWorkspace[] = [
	{ id: "orchestrator",      soul: orchestrator.SOUL,      identity: orchestrator.IDENTITY,      tools: orchestrator.TOOLS,      heartbeat: orchestrator.HEARTBEAT },
	{ id: "market-data",       soul: marketData.SOUL,        identity: marketData.IDENTITY,        tools: marketData.TOOLS },
	{ id: "strategy-research", soul: strategyResearch.SOUL,  identity: strategyResearch.IDENTITY,  tools: strategyResearch.TOOLS },
	{ id: "backtester",        soul: backtester.SOUL,        identity: backtester.IDENTITY,        tools: backtester.TOOLS },
	{ id: "risk-manager",      soul: riskManager.SOUL,       identity: riskManager.IDENTITY,       tools: riskManager.TOOLS,       heartbeat: riskManager.HEARTBEAT },
	{ id: "paper-executor",    soul: paperExecutor.SOUL,     identity: paperExecutor.IDENTITY,     tools: paperExecutor.TOOLS,     heartbeat: paperExecutor.HEARTBEAT },
	{ id: "reviewer",          soul: reviewer.SOUL,          identity: reviewer.IDENTITY,          tools: reviewer.TOOLS },
];

function writeIfMissing(filePath: string, content: string): void {
	if (!fs.existsSync(filePath)) {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, content, "utf8");
	}
}

export function bootstrapWorkspaces(workspaceBase: string, logger: Logger): void {
	for (const agent of AGENT_WORKSPACES) {
		const dir = path.join(workspaceBase, agent.id);
		writeIfMissing(path.join(dir, "SOUL.md"),     agent.soul);
		writeIfMissing(path.join(dir, "IDENTITY.md"), agent.identity);
		writeIfMissing(path.join(dir, "AGENTS.md"),   SHARED_AGENTS_MD);
		writeIfMissing(path.join(dir, "TOOLS.md"),    agent.tools);
		if (agent.heartbeat) {
			writeIfMissing(path.join(dir, "HEARTBEAT.md"), agent.heartbeat);
		}
	}
	logger.info("claw-mafia-finance: agent workspaces bootstrapped");
}

/** Resolve the workspace base directory from the OpenClaw state dir. */
export function resolveWorkspaceBase(stateDir: string): string {
	return path.join(stateDir, "workspace");
}

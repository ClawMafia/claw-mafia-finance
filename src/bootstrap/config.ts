import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

// Tool allowlists per agent (from docs/AGENTS.md)
const TOOLS_ALLOW: Record<string, string[]> = {
	"orchestrator": [
		"sessions_spawn", "sessions_send", "sessions_list", "agents_list",
		"message", "cron", "strategy_registry_read", "web_search",
	],
	"market-data": [
		"get_stock_quote", "get_options_chain", "get_historical_ohlcv",
		"get_iv_surface", "get_earnings_calendar", "get_economic_calendar",
		"get_risk_free_rate", "get_dividend_history", "web_fetch", "message",
	],
	"strategy-research": [
		"get_stock_quote", "get_options_chain", "get_iv_surface",
		"options_payoff_calculator", "black_scholes_pricer", "greeks_calculator",
		"strategy_template_lookup", "strategy_spec_validator",
		"web_search", "web_fetch", "message",
	],
	"backtester": [
		"run_backtest", "get_backtest_status", "get_backtest_results",
		"parameter_sweep", "compare_backtests", "get_historical_ohlcv", "message",
	],
	"risk-manager": [
		"calculate_portfolio_var", "check_position_limits", "stress_test_scenario",
		"correlation_matrix", "exposure_report", "get_backtest_results",
		"paper_get_positions", "paper_get_pnl",
		"get_risk_config", "set_risk_config", "trigger_kill_switch", "message",
	],
	"paper-executor": [
		"paper_submit_order", "paper_cancel_order", "paper_get_positions",
		"paper_get_pnl", "paper_roll_position", "paper_get_order_history",
		"get_stock_quote", "get_options_chain", "message",
	],
	"reviewer": [
		"generate_daily_report", "compare_thesis_vs_actual",
		"write_journal_entry", "get_journal_entries",
		"get_backtest_results", "paper_get_pnl", "paper_get_order_history", "message",
	],
};

// Subagents each agent is allowed to spawn via sessions_spawn
const AGENT_SUBAGENTS: Record<string, string[]> = {
	"orchestrator": ["market-data", "strategy-research", "backtester", "risk-manager", "paper-executor", "reviewer"],
	"risk-manager": ["backtester"],
};

// Per-agent heartbeat overrides (agents with HEARTBEAT.md content)
const AGENT_HEARTBEAT: Record<string, object> = {
	"orchestrator": {
		every: "30m",
		activeHours: { start: "08:00", end: "18:00", timezone: "America/New_York" },
		lightContext: true,
		isolatedSession: true,
	},
	"risk-manager": {
		every: "15m",
		activeHours: { start: "09:30", end: "16:00", timezone: "America/New_York" },
		lightContext: true,
		isolatedSession: true,
	},
	"paper-executor": {
		every: "30m",
		activeHours: { start: "09:30", end: "16:30", timezone: "America/New_York" },
		lightContext: true,
		isolatedSession: true,
	},
};

const AGENT_IDS = Object.keys(TOOLS_ALLOW) as Array<keyof typeof TOOLS_ALLOW>;

export async function bootstrapOpenClawConfig(
	api: OpenClawPluginApi,
	workspaceBase: string,
	logger: Logger,
): Promise<void> {
	const cfg = api.runtime.config.loadConfig();

	const existingList = cfg.agents?.list ?? [];
	const orchestratorEntry = existingList.find((a) => a.id === "orchestrator");

	// Guard: skip entirely only if orchestrator is already configured with subagents
	// AND the workspace path matches the current resolved workspace base
	const expectedWorkspace = `${workspaceBase}/orchestrator`;
	const existingWorkspace = (orchestratorEntry as Record<string, unknown> | undefined)?.["workspace"] as string | undefined;
	if (
		orchestratorEntry &&
		(orchestratorEntry as Record<string, unknown>)["subagents"] &&
		existingWorkspace === expectedWorkspace
	) {
		logger.info("claw-mafia-finance: openclaw.json agent config already present, skipping");
		return;
	}

	// Build fresh agent entries (no model override — inherit gateway default)
	const freshAgentList = AGENT_IDS.map((id) => ({
		id,
		workspace: `${workspaceBase}/${id}`,
		tools: { allow: TOOLS_ALLOW[id] },
		...(AGENT_HEARTBEAT[id] ? { heartbeat: AGENT_HEARTBEAT[id] } : {}),
		...(AGENT_SUBAGENTS[id] ? { subagents: { allowAgents: AGENT_SUBAGENTS[id] } } : {}),
	}));

	// If agents already exist (missing subagents or workspace), merge updates into existing entries
	const agentList = existingList.length > 0
		? existingList.map((existing) => {
			const fresh = freshAgentList.find((f) => f.id === existing.id);
			if (!fresh) return existing;
			return {
				...existing,
				workspace: fresh.workspace,
				...(fresh.subagents ? { subagents: fresh.subagents } : {}),
			};
		})
		: freshAgentList;

	// Only add the catch-all binding if this is a fresh bootstrap (no existing agents)
	const existingBindings = cfg.bindings ?? [];
	const hasCatchAll = existingBindings.some(
		(b) => b.agentId === "orchestrator" && b.match.channel === "discord",
	);
	const newBindings = hasCatchAll ? [] : [
		{
			agentId: "orchestrator",
			comment: "Route all Discord messages to orchestrator (refine with channel IDs in CLA-9)",
			match: { channel: "discord" },
		},
	];

	const patch = {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				heartbeat: {
					...cfg.agents?.defaults?.heartbeat,
					lightContext: true,
					isolatedSession: true,
				},
			},
			list: agentList,
		},
		bindings: [...existingBindings, ...newBindings],
	};

	await api.runtime.config.writeConfigFile(patch as Parameters<typeof api.runtime.config.writeConfigFile>[0]);
	logger.info("claw-mafia-finance: openclaw.json agent config bootstrapped");
}

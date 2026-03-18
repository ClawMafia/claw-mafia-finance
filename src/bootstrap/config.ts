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

	// Guard: skip if we already bootstrapped (orchestrator entry is present)
	if (cfg.agents?.list?.some((a) => a.id === "orchestrator")) {
		logger.info("claw-mafia-finance: openclaw.json agent config already present, skipping");
		return;
	}

	const agentList = AGENT_IDS.map((id) => ({
		id,
		workspace: `${workspaceBase}/${id}`,
		model: "claude-sonnet-4-6",
		tools: { allow: TOOLS_ALLOW[id] },
		...(AGENT_HEARTBEAT[id] ? { heartbeat: AGENT_HEARTBEAT[id] } : {}),
	}));

	// Single catch-all Discord binding → orchestrator.
	// Specific per-channel bindings (guildId, peer.id) are added in CLA-9 Discord setup.
	const newBindings = [
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
				// Conservative global heartbeat defaults; individual agents override via agents.list
				heartbeat: {
					...cfg.agents?.defaults?.heartbeat,
					lightContext: true,
					isolatedSession: true,
				},
			},
			list: [...(cfg.agents?.list ?? []), ...agentList],
		},
		bindings: [...(cfg.bindings ?? []), ...newBindings],
	};

	await api.runtime.config.writeConfigFile(patch as Parameters<typeof api.runtime.config.writeConfigFile>[0]);
	logger.info("claw-mafia-finance: openclaw.json agent config bootstrapped");
}

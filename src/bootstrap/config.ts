import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

// Discord server + channel IDs
const GUILD_ID = "1475048230973865985";
const PAPER_TRADING_CHANNEL_ID = "1503954201414340729";

// Bot owner Discord user ID
const OWNER_DISCORD_ID = "1107894529719271474";

// Preserved for future use — orchestrator agent tool list is no longer wired
// into openclaw.json (paper-trading agent below is the active agent now).
const ORCHESTRATOR_TOOLS_ALSO_ALLOW = [
	// Market data
	"get_stock_quote", "get_options_chain", "get_historical_ohlcv",
	"get_iv_surface", "get_earnings_calendar", "get_economic_calendar",
	"get_risk_free_rate", "get_dividend_history",
	// Options pricing
	"options_payoff_calculator", "black_scholes_pricer", "greeks_calculator",
	// Strategy
	"strategy_template_lookup", "strategy_spec_validator",
	// Backtest
	"run_backtest", "get_backtest_status", "get_backtest_results",
	"parameter_sweep", "compare_backtests",
	// Risk
	"calculate_portfolio_var", "check_position_limits", "stress_test_scenario",
	"correlation_matrix", "exposure_report",
	"get_risk_config", "set_risk_config", "trigger_kill_switch",
	// Paper trading (IBKR)
	"ibkr_submit_order", "ibkr_cancel_order", "ibkr_get_positions",
	"ibkr_get_pnl", "ibkr_get_order_history", "ibkr_get_quote",
	// Review / trading journals
	"generate_daily_report", "compare_thesis_vs_actual",
	"ibkr_record_fills", "attach_reasoning", "ibkr_get_positions_book", "ibkr_refresh_marks",
	// Discord + web
	"message", "web_search", "web_fetch",
];
void ORCHESTRATOR_TOOLS_ALSO_ALLOW;

// Active agent: paper-trading. Tools narrowed to paper execution + EODHD market
// data + Discord/web. To re-enable the broader orchestrator, swap the agent
// entry below and use ORCHESTRATOR_TOOLS_ALSO_ALLOW.
const PAPER_TRADING_TOOLS_ALSO_ALLOW = [
	// Paper trading (IBKR)
	"ibkr_submit_order", "ibkr_cancel_order", "ibkr_get_positions",
	"ibkr_get_pnl", "ibkr_get_order_history", "ibkr_get_quote",
	"ibkr_reconnect",
	// Trading journals (ledger)
	"ibkr_record_fills", "attach_reasoning", "ibkr_get_positions_book", "ibkr_refresh_marks",
	// EODHD market data
	"eodhd_search_symbols", "eodhd_get_fundamentals", "eodhd_get_historical_eod",
	// Discord + web
	"message", "web_search", "web_fetch",
	// Shell access for the ibkr-api-direct skill. Used for IBKR operations
	// the typed ibkr_* tools don't cover (futures, combos, contract lookups).
	"bash",
];

const PAPER_TRADING_AGENT_ID = "paper-trading";

export async function bootstrapOpenClawConfig(
	api: OpenClawPluginApi,
	workspaceBase: string,
	logger: Logger,
): Promise<void> {
	const cfg = api.runtime.config.loadConfig();

	const existingList = cfg.agents?.list ?? [];
	const paperEntry = existingList.find((a) => a.id === PAPER_TRADING_AGENT_ID);

	// Reuse the orchestrator workspace (SOUL/IDENTITY/AGENTS prompts seeded by
	// bootstrapWorkspaces). New agent ID, same prompts.
	const expectedWorkspace = `${workspaceBase}/orchestrator`;
	const existingWorkspace = (paperEntry as Record<string, unknown> | undefined)?.["workspace"] as string | undefined;
	const existingBindings = cfg.bindings ?? [];
	const hasPmDeskBinding = existingBindings.some(
		(b) => b.agentId === PAPER_TRADING_AGENT_ID && (b.match as Record<string, unknown>)?.["peer"] !== undefined &&
			((b.match as Record<string, unknown>)["peer"] as Record<string, unknown>)?.["id"] === PAPER_TRADING_CHANNEL_ID,
	);
	const discordCfg = (cfg.channels as Record<string, unknown> | undefined)
		?.["discord"] as Record<string, unknown> | undefined;
	const hasPmDeskChannelConfig = !!(
		(discordCfg?.["guilds"] as Record<string, unknown> | undefined)
			?.[GUILD_ID] as Record<string, unknown> | undefined
	)?.["channels"];
	const paperTools = (paperEntry as Record<string, unknown> | undefined)?.["tools"] as Record<string, unknown> | undefined;
	const usesProfileFormat = paperTools?.["profile"] !== undefined || paperTools?.["alsoAllow"] !== undefined;

	if (
		paperEntry &&
		existingWorkspace === expectedWorkspace &&
		hasPmDeskBinding &&
		hasPmDeskChannelConfig &&
		usesProfileFormat
	) {
		logger.info("claw-mafia-finance: openclaw.json agent config already present, skipping");
		return;
	}

	// Build paper-trading agent entry
	const freshPaperTrading = {
		id: PAPER_TRADING_AGENT_ID,
		workspace: expectedWorkspace,
		tools: { profile: "minimal", alsoAllow: PAPER_TRADING_TOOLS_ALSO_ALLOW },
	};

	// Merge with existing config if present (preserve UI edits to the tool list)
	const paperTradingAgent = (() => {
		if (!paperEntry) return freshPaperTrading;
		const existingTools = (paperEntry as Record<string, unknown>)["tools"] as Record<string, unknown> | undefined;
		const isOldAllowFormat = existingTools?.["allow"] && !existingTools?.["profile"];
		return {
			...paperEntry,
			workspace: freshPaperTrading.workspace,
			tools: isOldAllowFormat ? freshPaperTrading.tools : (existingTools ?? freshPaperTrading.tools),
		};
	})();

	// Build agent list: our paper-trading agent + any pre-existing agents we
	// don't own. (Any old "orchestrator" entry from prior installs is preserved
	// as-is but no longer receives bindings.)
	const agentList = [
		paperTradingAgent,
		...existingList.filter((e) => e.id !== PAPER_TRADING_AGENT_ID),
	];

	// #paper-trading peer binding — drop any prior orchestrator catch-all or
	// orchestrator-targeted paper-trading binding so the new agent is the sole route.
	const bindingsToRemove = (b: typeof existingBindings[number]) => {
		const isOrchestratorCatchAll = b.agentId === "orchestrator" &&
			b.match.channel === "discord" &&
			!(b.match as Record<string, unknown>)["peer"];
		const isOrchestratorPmDesk = b.agentId === "orchestrator" &&
			((b.match as Record<string, unknown>)?.["peer"] as Record<string, unknown> | undefined)?.["id"] === PAPER_TRADING_CHANNEL_ID;
		return isOrchestratorCatchAll || isOrchestratorPmDesk;
	};
	const bindingsWithoutOldRoutes = existingBindings.filter((b) => !bindingsToRemove(b));
	const newBindings = hasPmDeskBinding ? [] : [
		{
			agentId: PAPER_TRADING_AGENT_ID,
			comment: "Route #paper-trading inbound messages to paper-trading agent",
			match: { channel: "discord", peer: { kind: "channel", id: PAPER_TRADING_CHANNEL_ID } },
		},
	];

	// Per-channel Discord config for #paper-trading: requireMention + autoThread
	const existingDiscord = (cfg.channels as Record<string, unknown> | undefined)?.["discord"] as Record<string, unknown> ?? {};
	const existingGuilds = existingDiscord["guilds"] as Record<string, unknown> ?? {};
	const existingGuild = existingGuilds[GUILD_ID] as Record<string, unknown> ?? {};
	const existingChannels = existingGuild["channels"] as Record<string, unknown> ?? {};
	const existingPaperTrading = existingChannels[PAPER_TRADING_CHANNEL_ID] as Record<string, unknown> ?? {};
	const guildConfig = {
		...existingGuild,
		channels: {
			...existingChannels,
			[PAPER_TRADING_CHANNEL_ID]: {
				...existingPaperTrading,
				enabled: true,
				requireMention: true,
				autoThread: true,
			},
		},
	};

	const existingCommandAllowFrom = (cfg.commands?.allowFrom ?? {}) as Record<string, string[]>;
	const discordAllowFrom = existingCommandAllowFrom["discord"] ?? [];
	const commandsAllowFrom = discordAllowFrom.includes(OWNER_DISCORD_ID)
		? existingCommandAllowFrom
		: { ...existingCommandAllowFrom, discord: [...discordAllowFrom, OWNER_DISCORD_ID] };

	const patch = {
		...cfg,
		agents: {
			...cfg.agents,
			list: agentList,
		},
		bindings: [...bindingsWithoutOldRoutes, ...newBindings],
		channels: {
			...(cfg.channels as Record<string, unknown> ?? {}),
			discord: {
				...existingDiscord,
				guilds: {
					...existingGuilds,
					[GUILD_ID]: guildConfig,
				},
			},
		},
		commands: {
			...cfg.commands,
			allowFrom: commandsAllowFrom,
		},
	};

	await api.runtime.config.writeConfigFile(patch as Parameters<typeof api.runtime.config.writeConfigFile>[0]);
	logger.info("claw-mafia-finance: openclaw.json agent config bootstrapped");
}

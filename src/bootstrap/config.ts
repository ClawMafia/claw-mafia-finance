import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

// Discord server + channel IDs
const GUILD_ID = "1475048230973865985";
const PM_DESK_CHANNEL_ID = "1483706704821485599";

// Bot owner Discord user ID
const OWNER_DISCORD_ID = "1107894529719271474";

// All finance tools available to the orchestrator agent.
// Uses profile + alsoAllow so the UI Tools tab can toggle individual tools.
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
	// Paper trading
	"paper_submit_order", "paper_cancel_order", "paper_get_positions",
	"paper_get_pnl", "paper_get_order_history", "paper_roll_position",
	// Review
	"generate_daily_report", "compare_thesis_vs_actual",
	"write_journal_entry", "get_journal_entries",
	// Discord + web
	"message", "web_search", "web_fetch",
];

export async function bootstrapOpenClawConfig(
	api: OpenClawPluginApi,
	workspaceBase: string,
	logger: Logger,
): Promise<void> {
	const cfg = api.runtime.config.loadConfig();

	const existingList = cfg.agents?.list ?? [];
	const orchestratorEntry = existingList.find((a) => a.id === "orchestrator");

	const expectedWorkspace = `${workspaceBase}/orchestrator`;
	const existingWorkspace = (orchestratorEntry as Record<string, unknown> | undefined)?.["workspace"] as string | undefined;
	const existingBindings = cfg.bindings ?? [];
	const hasPmDeskBinding = existingBindings.some(
		(b) => b.agentId === "orchestrator" && (b.match as Record<string, unknown>)?.["peer"] !== undefined &&
			((b.match as Record<string, unknown>)["peer"] as Record<string, unknown>)?.["id"] === PM_DESK_CHANNEL_ID,
	);
	const discordCfg = (cfg.channels as Record<string, unknown> | undefined)
		?.["discord"] as Record<string, unknown> | undefined;
	const hasPmDeskChannelConfig = !!(
		(discordCfg?.["guilds"] as Record<string, unknown> | undefined)
			?.[GUILD_ID] as Record<string, unknown> | undefined
	)?.["channels"];
	const orchestratorTools = (orchestratorEntry as Record<string, unknown> | undefined)?.["tools"] as Record<string, unknown> | undefined;
	const usesProfileFormat = orchestratorTools?.["profile"] !== undefined || orchestratorTools?.["alsoAllow"] !== undefined;

	if (
		orchestratorEntry &&
		existingWorkspace === expectedWorkspace &&
		hasPmDeskBinding &&
		hasPmDeskChannelConfig &&
		usesProfileFormat
	) {
		logger.info("claw-mafia-finance: openclaw.json agent config already present, skipping");
		return;
	}

	// Build orchestrator agent entry
	const freshOrchestrator = {
		id: "orchestrator",
		workspace: `${workspaceBase}/orchestrator`,
		tools: { profile: "minimal", alsoAllow: ORCHESTRATOR_TOOLS_ALSO_ALLOW },
	};

	// Merge with existing config if present (preserve UI edits)
	const orchestratorAgent = (() => {
		if (!orchestratorEntry) return freshOrchestrator;
		const existingTools = (orchestratorEntry as Record<string, unknown>)["tools"] as Record<string, unknown> | undefined;
		const isOldAllowFormat = existingTools?.["allow"] && !existingTools?.["profile"];
		return {
			...orchestratorEntry,
			workspace: freshOrchestrator.workspace,
			tools: isOldAllowFormat ? freshOrchestrator.tools : (existingTools ?? freshOrchestrator.tools),
		};
	})();

	// Build agent list: our orchestrator + any pre-existing agents we don't own
	const agentList = [
		orchestratorAgent,
		...existingList.filter((e) => e.id !== "orchestrator"),
	];

	// #pm-desk peer binding
	const bindingsWithoutOldCatchAll = existingBindings.filter(
		(b) => !(b.agentId === "orchestrator" &&
			b.match.channel === "discord" &&
			!(b.match as Record<string, unknown>)["peer"]),
	);
	const newBindings = hasPmDeskBinding ? [] : [
		{
			agentId: "orchestrator",
			comment: "Route #pm-desk inbound messages to orchestrator",
			match: { channel: "discord", peer: { kind: "channel", id: PM_DESK_CHANNEL_ID } },
		},
	];

	// Per-channel Discord config for #pm-desk: requireMention + autoThread
	const existingDiscord = (cfg.channels as Record<string, unknown> | undefined)?.["discord"] as Record<string, unknown> ?? {};
	const existingGuilds = existingDiscord["guilds"] as Record<string, unknown> ?? {};
	const existingGuild = existingGuilds[GUILD_ID] as Record<string, unknown> ?? {};
	const existingChannels = existingGuild["channels"] as Record<string, unknown> ?? {};
	const existingPmDesk = existingChannels[PM_DESK_CHANNEL_ID] as Record<string, unknown> ?? {};
	const guildConfig = {
		...existingGuild,
		channels: {
			...existingChannels,
			[PM_DESK_CHANNEL_ID]: {
				...existingPmDesk,
				allow: true,
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
		bindings: [...bindingsWithoutOldCatchAll, ...newBindings],
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

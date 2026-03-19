import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

// Discord server + channel IDs (from docs/DISCORD-CHANNELS.md)
const GUILD_ID = "1475048230973865985";
const PM_DESK_CHANNEL_ID = "1483706704821485599";
// Output-only channels — agents write here via the message tool; bot does not handle inbound.
// IDs are referenced in workspace files (IDENTITY/HEARTBEAT) and cron job targets.
export const PAPER_TRADING_CHANNEL_ID = "1484045430932242554";
export const RISK_WATCH_CHANNEL_ID = "1484045395746230292";

// Bot owner Discord user ID
const OWNER_DISCORD_ID = "1107894529719271474";

// Tool allowlists per agent (from docs/AGENTS.md)
const TOOLS_ALLOW: Record<string, string[]> = {
	"orchestrator": [
		"sessions_spawn", "sessions_send", "sessions_list", "agents_list",
		"message", "cron", "strategy_registry_read", "web_search",
	],
	"market-data": [
		"get_stock_quote", "get_options_chain", "get_historical_ohlcv",
		"get_iv_surface", "get_earnings_calendar", "get_economic_calendar",
		"get_risk_free_rate", "get_dividend_history", "web_fetch",
		// no `message` — response is posted to thread by OpenClaw automatically
	],
	"strategy-research": [
		"get_stock_quote", "get_options_chain", "get_iv_surface",
		"options_payoff_calculator", "black_scholes_pricer", "greeks_calculator",
		"strategy_template_lookup", "strategy_spec_validator",
		"web_search", "web_fetch",
		// no `message` — response is posted to thread by OpenClaw automatically
	],
	"backtester": [
		"run_backtest", "get_backtest_status", "get_backtest_results",
		"parameter_sweep", "compare_backtests", "get_historical_ohlcv",
		// no `message` — response is posted to thread by OpenClaw automatically
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

	// Guard: skip if orchestrator is correctly configured, pm-desk binding exists,
	// and pm-desk channel config (requireMention) is set
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
	const hasThreadBindings = !!(discordCfg?.["threadBindings"] as Record<string, unknown> | undefined)
		?.["spawnSubagentSessions"];
	if (
		orchestratorEntry &&
		(orchestratorEntry as Record<string, unknown>)["subagents"] &&
		existingWorkspace === expectedWorkspace &&
		hasPmDeskBinding &&
		hasPmDeskChannelConfig &&
		hasThreadBindings
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

	// Build merged agent list:
	// 1. All 7 of our agents (fresh config, merged with any existing fields)
	// 2. Any pre-existing agents not in our list (e.g. the "main" default agent)
	const agentList = [
		...freshAgentList.map((fresh) => {
			const existing = existingList.find((e) => e.id === fresh.id);
			if (!existing) return fresh;
			return {
				...existing,
				workspace: fresh.workspace,
				...(fresh.subagents ? { subagents: fresh.subagents } : {}),
			};
		}),
		...existingList.filter((e) => !freshAgentList.find((f) => f.id === e.id)),
	];

	// Replace old catch-all binding with specific #pm-desk peer binding.
	// Per design (docs/DISCORD-CHANNELS.md): only #pm-desk receives inbound commands;
	// all other channels are output-only.
	const bindingsWithoutCatchAll = existingBindings.filter(
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
		bindings: [...bindingsWithoutCatchAll, ...newBindings],
		channels: {
			...(cfg.channels as Record<string, unknown> ?? {}),
			discord: {
				...existingDiscord,
				// Enable thread-based sub-agent spawning (docs/DISCORD-CHANNELS.md)
				threadBindings: {
					...(existingDiscord["threadBindings"] as Record<string, unknown> ?? {}),
					enabled: true,
					spawnSubagentSessions: true,
				},
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

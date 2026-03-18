import * as fs from "node:fs";
import * as path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

type ChannelSpec = {
	name: string;
	topic: string;
	autoThread?: true;
};

// Channels to create in the Discord guild
const DISCORD_CHANNELS: ChannelSpec[] = [
	{ name: "pm-desk",       topic: "Strategy requests and portfolio management", autoThread: true },
	{ name: "research-lab",  topic: "Research results and backtest reports" },
	{ name: "paper-trading", topic: "Paper trading activity and order fills" },
	{ name: "risk-watch",    topic: "Risk alerts and position monitoring" },
	{ name: "daily-journal", topic: "Daily performance reviews and lessons" },
	{ name: "system-logs",   topic: "System events and agent activity" },
];

// Per-channel agent routing
const CHANNEL_ROUTING: Record<string, string> = {
	"pm-desk":       "orchestrator",
	"research-lab":  "strategy-research",
	"paper-trading": "paper-executor",
	"risk-watch":    "risk-manager",
	"daily-journal": "reviewer",
	"system-logs":   "orchestrator",
};

type SecretInput = string | { source: string; provider: string; id: string };

function resolveToken(token: SecretInput | undefined): string | null {
	if (!token) return null;
	if (typeof token === "string") return token;
	if (token.source === "env") return process.env[token.id] ?? null;
	return null;
}

type DiscordAPIChannel = { id: string; name: string; type: number };

export async function bootstrapDiscordChannels(
	api: OpenClawPluginApi,
	stateDir: string,
	logger: Logger,
): Promise<void> {
	// Guard: skip if channels already bootstrapped
	const guardFile = path.join(stateDir, "discord-channels-bootstrapped");
	if (fs.existsSync(guardFile)) {
		logger.info("claw-mafia-finance: Discord channels already bootstrapped, skipping");
		return;
	}

	const cfg = api.runtime.config.loadConfig();
	const discordCfg = cfg.channels?.discord as Record<string, unknown> | undefined;

	if (!discordCfg) {
		logger.warn("claw-mafia-finance: no Discord config found, skipping channel bootstrap");
		return;
	}

	const rawToken = discordCfg["token"] as SecretInput | undefined;
	const token = resolveToken(rawToken);
	if (!token) {
		logger.warn("claw-mafia-finance: Discord token not resolvable, skipping channel bootstrap");
		return;
	}

	// Find the guild ID from discord.guilds config
	const guilds = (discordCfg["guilds"] ?? {}) as Record<string, unknown>;
	const guildIds = Object.keys(guilds);
	if (guildIds.length === 0) {
		logger.warn("claw-mafia-finance: no Discord guild configured, skipping channel bootstrap");
		return;
	}
	const guildId = guildIds[0];

	// Fetch existing channels from Discord
	const existingRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
		headers: { "Authorization": `Bot ${token}` },
	});
	if (!existingRes.ok) {
		logger.warn(`claw-mafia-finance: Discord API error fetching channels: ${existingRes.status}`);
		return;
	}

	const existingChannels = await existingRes.json() as DiscordAPIChannel[];
	const existingByName = new Map(
		existingChannels.filter(c => c.type === 0).map(c => [c.name, c.id]),
	);

	// Create missing channels and collect IDs
	const channelIds: Record<string, string> = {};
	for (const ch of DISCORD_CHANNELS) {
		if (existingByName.has(ch.name)) {
			channelIds[ch.name] = existingByName.get(ch.name)!;
			logger.info(`claw-mafia-finance: Discord #${ch.name} already exists (${channelIds[ch.name]})`);
		} else {
			const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
				method: "POST",
				headers: {
					"Authorization": `Bot ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ name: ch.name, type: 0, topic: ch.topic }),
			});
			if (res.ok) {
				const created = await res.json() as { id: string; name: string };
				channelIds[ch.name] = created.id;
				logger.info(`claw-mafia-finance: created Discord #${ch.name} (${created.id})`);
			} else {
				logger.warn(`claw-mafia-finance: failed to create Discord #${ch.name}: ${res.status}`);
			}
		}
	}

	if (Object.keys(channelIds).length === 0) {
		logger.warn("claw-mafia-finance: no channel IDs obtained, skipping config update");
		return;
	}

	// Build per-channel guild config (channel ID → DiscordGuildChannelConfig)
	const channelConfigs: Record<string, unknown> = {};
	for (const ch of DISCORD_CHANNELS) {
		if (channelIds[ch.name]) {
			channelConfigs[channelIds[ch.name]] = {
				allow: true,
				...(ch.autoThread ? { autoThread: true } : {}),
			};
		}
	}

	// Build per-channel route bindings
	const channelBindings = Object.entries(CHANNEL_ROUTING)
		.filter(([name]) => channelIds[name])
		.map(([name, agentId]) => ({
			type: "route" as const,
			agentId,
			comment: `Route #${name} to ${agentId}`,
			match: {
				channel: "discord",
				guildId,
				peer: { kind: "channel" as const, id: channelIds[name] },
			},
		}));

	// Remove old catch-all Discord binding and replace with per-channel ones
	const existingBindings = cfg.bindings ?? [];
	const filteredBindings = existingBindings.filter(
		b => !(b.agentId === "orchestrator" && b.match.channel === "discord" && !b.match.peer),
	);

	const patch = {
		...cfg,
		channels: {
			...cfg.channels,
			discord: {
				...discordCfg,
				guilds: {
					...guilds,
					[guildId]: {
						...(guilds[guildId] as Record<string, unknown> ?? {}),
						channels: {
							...((guilds[guildId] as Record<string, unknown> | undefined)?.["channels"] as Record<string, unknown> | undefined ?? {}),
							...channelConfigs,
						},
					},
				},
			},
		},
		bindings: [
			...filteredBindings,
			...channelBindings,
			// Keep a catch-all for Discord DMs and unrouted messages
			{
				type: "route" as const,
				agentId: "orchestrator",
				comment: "Catch-all for Discord DMs and unrouted messages",
				match: { channel: "discord" },
			},
		],
	};

	await api.runtime.config.writeConfigFile(patch as Parameters<typeof api.runtime.config.writeConfigFile>[0]);

	// Write guard file to skip on next boot
	fs.mkdirSync(path.dirname(guardFile), { recursive: true });
	fs.writeFileSync(guardFile, new Date().toISOString(), "utf8");

	logger.info(`claw-mafia-finance: Discord channels bootstrapped (${Object.keys(channelIds).length} channels in guild ${guildId})`);
}

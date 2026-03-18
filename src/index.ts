import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerMarketDataTools } from "./tools/market-data.js";
import { registerOptionsPricingTools } from "./tools/options-pricing.js";
import { registerStrategyTools } from "./tools/strategy.js";
import { registerBacktestTools } from "./tools/backtest.js";
import { registerRiskTools } from "./tools/risk.js";
import { registerPaperTradingTools } from "./tools/paper-trading.js";
import { registerReviewTools } from "./tools/review.js";
import { bootstrapWorkspaces, resolveWorkspaceBase } from "./bootstrap/workspaces.js";
import { bootstrapOpenClawConfig } from "./bootstrap/config.js";
import { bootstrapDiscordChannels } from "./bootstrap/discord-channels.js";

export type FinancePluginConfig = {
	polygonApiKey: string;
	fredApiKey?: string;
	dataDir?: string;
	paperAccountCapital?: number;
};

export default async function register(api: OpenClawPluginApi) {
	const config = (api.pluginConfig ?? {}) as FinancePluginConfig;

	if (!config.polygonApiKey) {
		api.logger.warn("polygonApiKey not set — market data tools will be unavailable");
	}

	const dataDir = config.dataDir ?? api.resolvePath("./data");

	const ctx = {
		config,
		dataDir,
		logger: api.logger,
	};

	// Bootstrap: write agent workspace files and openclaw.json config on first boot
	const stateDir = api.runtime.state.resolveStateDir();
	const workspaceBase = resolveWorkspaceBase(stateDir);
	bootstrapWorkspaces(workspaceBase, api.logger);
	await bootstrapOpenClawConfig(api, workspaceBase, api.logger);

	// Phase 1: Market data + options pricing
	registerMarketDataTools(api, ctx);
	registerOptionsPricingTools(api, ctx);

	// Phase 2: Strategy + backtest
	registerStrategyTools(api, ctx);
	registerBacktestTools(api, ctx);

	// Phase 3: Risk + paper trading
	registerRiskTools(api, ctx);
	registerPaperTradingTools(api, ctx);

	// Phase 4: Review
	registerReviewTools(api, ctx);

	// Bootstrap Discord channels on gateway start (after bot is connected)
	const capturedStateDir = stateDir;
	api.on("gateway_start", async () => {
		await bootstrapDiscordChannels(api, capturedStateDir, api.logger);
	});

	api.logger.info("claw-mafia-finance plugin loaded");
}

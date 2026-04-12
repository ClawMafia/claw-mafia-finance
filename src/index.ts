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

export type FinancePluginConfig = {
	alpacaApiKey: string;
	alpacaApiSecret: string;
	alpacaBaseUrl?: string;
	ibkrHost?: string;
	ibkrPort?: number;
	fredApiKey?: string;
	dataDir?: string;
	paperAccountCapital?: number;
};

export default function register(api: OpenClawPluginApi) {
	const config = (api.pluginConfig ?? {}) as FinancePluginConfig;

	if (!config.alpacaApiKey || !config.alpacaApiSecret) {
		api.logger.warn("alpacaApiKey / alpacaApiSecret not set — US real-time quotes will fall back to yfinance");
	}

	if (!config.ibkrHost) {
		api.logger.warn("ibkrHost not set — IBKR tools will target localhost:4000");
	}

	const dataDir = config.dataDir ?? api.resolvePath("./data");

	const ctx = {
		config,
		dataDir,
		logger: api.logger,
	};

	// Bootstrap: write orchestrator workspace files and openclaw.json config
	const stateDir = api.runtime.state.resolveStateDir();
	const workspaceBase = resolveWorkspaceBase(stateDir);
	bootstrapWorkspaces(workspaceBase, api.logger);
	// Fire-and-forget: plugin loader ignores async registration
	bootstrapOpenClawConfig(api, workspaceBase, api.logger).catch((err) =>
		api.logger.warn(`claw-mafia-finance: config bootstrap failed: ${err}`),
	);

	// Register all tools
	registerMarketDataTools(api, ctx);
	registerOptionsPricingTools(api, ctx);
	registerStrategyTools(api, ctx);
	registerBacktestTools(api, ctx);
	registerRiskTools(api, ctx);
	registerPaperTradingTools(api, ctx);
	registerReviewTools(api, ctx);

	// Background services — keepalive not needed with IB Gateway (session managed by IBC)

	api.logger.info("claw-mafia-finance plugin loaded");
}

import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { LedgerStore } from "./data/ledger-store.js";
import { IBKRClient } from "./data/ibkr-client.js";
import { FlexClient } from "./data/flex-client.js";
import { registerMarketDataTools } from "./tools/market-data.js";
import { registerOptionsPricingTools } from "./tools/options-pricing.js";
import { registerStrategyTools } from "./tools/strategy.js";
import { registerBacktestTools } from "./tools/backtest.js";
import { registerRiskTools } from "./tools/risk.js";
import { registerIbkrTradingTools } from "./tools/ibkr-trading.js";
import { registerReviewTools } from "./tools/review.js";
import { bootstrapWorkspaces, resolveWorkspaceBase } from "./bootstrap/workspaces.js";
import { bootstrapOpenClawConfig } from "./bootstrap/config.js";

export type FinancePluginConfig = {
	alpacaApiKey: string;
	alpacaApiSecret: string;
	alpacaBaseUrl?: string;
	ibkrHost?: string;
	ibkrPort?: number;
	ibkrFlexToken?: string;
	ibkrFlexQueryId?: string;
	fredApiKey?: string;
	dataDir?: string;
	/** Ledger DB path. Defaults to {stateDir}/finance/ledger.sqlite. */
	ledgerDbPath?: string;
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
	const stateDir = api.runtime.state.resolveStateDir();

	// Ledger DB: the structured system of record for the trading journals. Lives
	// in the persistent plugin state dir (not the vault, not the market-data
	// cache) — the reasoning column is the one irreplaceable field.
	const ledgerDbPath = config.ledgerDbPath ?? join(stateDir, "finance", "ledger.sqlite");
	const store = new LedgerStore(ledgerDbPath, api.logger);

	// One shared TWS socket + Flex client for every tool (avoids competing
	// clientId sessions evicting each other).
	const ibkr = new IBKRClient(config.ibkrHost ?? "localhost", config.ibkrPort ?? 4000, api.logger);
	const flex = new FlexClient(config.ibkrFlexToken ?? "", api.logger);

	const ctx = {
		config,
		dataDir,
		stateDir,
		store,
		ibkr,
		flex,
		logger: api.logger,
	};

	// Bootstrap: write orchestrator workspace files and openclaw.json config
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
	registerIbkrTradingTools(api, ctx);
	registerReviewTools(api, ctx);

	// Background services — keepalive not needed with IB Gateway (session managed by IBC)

	api.logger.info("claw-mafia-finance plugin loaded");
}

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";
import { AlpacaClient } from "../data/alpaca-client.js";
import { FredClient } from "../data/fred-client.js";
import { jsonResult } from "./result.js";

export function registerMarketDataTools(api: OpenClawPluginApi, ctx: PluginContext) {
	const alpaca = new AlpacaClient(
		ctx.config.alpacaApiKey,
		ctx.config.alpacaApiSecret,
		ctx.logger,
		ctx.dataDir,
		ctx.config.alpacaBaseUrl,
	);
	const fred = ctx.config.fredApiKey ? new FredClient(ctx.config.fredApiKey, ctx.logger) : null;

	// ── get_stock_quote ──
	api.registerTool(
		{
			name: "get_stock_quote",
			label: "Get Stock Quote",
			description:
				"Get current stock quote including price, bid/ask, volume, and daily bar. " +
				"Real-time via Alpaca IEX feed. Use for quick price checks on individual symbols.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Ticker symbol (e.g. SPY, AAPL, QQQ)" },
				},
				required: ["symbol"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbol = (params.symbol as string).toUpperCase();
				return jsonResult(await alpaca.getQuote(symbol));
			},
		},
		{ optional: true },
	);

	// ── get_options_chain ──
	api.registerTool(
		{
			name: "get_options_chain",
			label: "Get Options Chain",
			description:
				"Fetch options chain for a symbol. " +
				"NOTE: Not available on Alpaca free tier. Returns an unavailable notice. " +
				"Add yfinance integration to enable this tool.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Underlying ticker symbol" },
					expiration: { type: "string", description: "Filter by expiration date (YYYY-MM-DD). Optional." },
					strike_range_pct: { type: "number", description: "Percentage range around ATM to include." },
					option_type: { type: "string", enum: ["call", "put"] },
				},
				required: ["symbol"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				return jsonResult({
					symbol: (params.symbol as string).toUpperCase(),
					available: false,
					message: "Options chain data is not available on the Alpaca free tier. Integrate yfinance to enable this tool.",
				});
			},
		},
		{ optional: true },
	);

	// ── get_historical_ohlcv ──
	api.registerTool(
		{
			name: "get_historical_ohlcv",
			label: "Get Historical OHLCV",
			description:
				"Fetch historical OHLCV bars for a symbol via Alpaca IEX feed. " +
				"Data is cached locally after first fetch. Default interval is daily.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Ticker symbol" },
					start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
					end_date: { type: "string", description: "End date (YYYY-MM-DD). Default: today." },
					interval: {
						type: "string",
						description: "Bar interval: '1d' (default), '1h', '5m'",
						enum: ["1d", "1h", "5m"],
					},
				},
				required: ["symbol", "start_date"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbol = (params.symbol as string).toUpperCase();
				return jsonResult(await alpaca.getHistoricalOHLCV(symbol, {
					startDate: params.start_date as string,
					endDate: params.end_date as string | undefined,
					interval: (params.interval as string) ?? "1d",
				}));
			},
		},
		{ optional: true },
	);

	// ── get_iv_surface ──
	api.registerTool(
		{
			name: "get_iv_surface",
			label: "Get IV Surface",
			description:
				"Get implied volatility surface for a symbol. " +
				"NOTE: Not available on Alpaca free tier. Returns an unavailable notice.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Underlying ticker symbol" },
				},
				required: ["symbol"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				return jsonResult({
					symbol: (params.symbol as string).toUpperCase(),
					available: false,
					message: "IV surface data is not available on the Alpaca free tier. Integrate yfinance to enable this tool.",
				});
			},
		},
		{ optional: true },
	);

	// ── get_earnings_calendar ──
	api.registerTool(
		{
			name: "get_earnings_calendar",
			label: "Get Earnings Calendar",
			description:
				"Get upcoming earnings dates for specified symbols. " +
				"NOTE: Not available on Alpaca free tier. Returns an unavailable notice.",
			parameters: {
				type: "object",
				properties: {
					symbols: { type: "array", items: { type: "string" }, description: "List of symbols to check." },
					days_ahead: { type: "number", description: "How many days ahead to look. Default: 14." },
				},
			},
			async execute(_toolCallId: string, _params: Record<string, unknown>) {
				return jsonResult({
					available: false,
					message: "Earnings calendar is not available on the Alpaca free tier. Integrate yfinance to enable this tool.",
				});
			},
		},
		{ optional: true },
	);

	// ── get_risk_free_rate ──
	api.registerTool(
		{
			name: "get_risk_free_rate",
			label: "Get Risk-Free Rate",
			description:
				"Get current US Treasury risk-free rates from FRED. " +
				"Used for options pricing (Black-Scholes) and discount rates.",
			parameters: {
				type: "object",
				properties: {
					tenor: {
						type: "string",
						description: "Treasury tenor: '3m', '6m', '1y', '2y', '5y', '10y', '30y'. Default: '3m'.",
						enum: ["3m", "6m", "1y", "2y", "5y", "10y", "30y"],
					},
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				if (!fred) {
					return jsonResult({ error: "FRED API key not configured. Set fredApiKey in plugin config." });
				}
				const tenor = (params.tenor as string) ?? "3m";
				return jsonResult(await fred.getRiskFreeRate(tenor));
			},
		},
		{ optional: true },
	);

	// ── get_dividend_history ──
	api.registerTool(
		{
			name: "get_dividend_history",
			label: "Get Dividend History",
			description:
				"Get dividend history for a symbol. " +
				"NOTE: Not available on Alpaca free tier. Returns an unavailable notice.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Ticker symbol" },
					years: { type: "number", description: "How many years of history. Default: 3." },
				},
				required: ["symbol"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				return jsonResult({
					symbol: (params.symbol as string).toUpperCase(),
					available: false,
					message: "Dividend history is not available on the Alpaca free tier. Integrate yfinance to enable this tool.",
				});
			},
		},
		{ optional: true },
	);

	// ── get_economic_calendar ──
	api.registerTool(
		{
			name: "get_economic_calendar",
			label: "Get Economic Calendar",
			description:
				"Get upcoming economic events (FOMC, CPI, NFP, etc.) from FRED. " +
				"Useful for timing strategies around macro events.",
			parameters: {
				type: "object",
				properties: {
					days_ahead: { type: "number", description: "Days ahead to look. Default: 14." },
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				if (!fred) {
					return jsonResult({ error: "FRED API key not configured." });
				}
				const daysAhead = (params.days_ahead as number) ?? 14;
				return jsonResult(await fred.getEconomicCalendar(daysAhead));
			},
		},
		{ optional: true },
	);
}

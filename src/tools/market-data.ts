import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";
import { PolygonClient } from "../data/polygon-client.js";
import { FredClient } from "../data/fred-client.js";
import { jsonResult } from "./result.js";

export function registerMarketDataTools(api: OpenClawPluginApi, ctx: PluginContext) {
	const polygon = new PolygonClient(ctx.config.polygonApiKey, ctx.logger, ctx.dataDir);
	const fred = ctx.config.fredApiKey ? new FredClient(ctx.config.fredApiKey, ctx.logger) : null;

	// ── get_stock_quote ──
	api.registerTool(
		{
			name: "get_stock_quote",
			label: "Get Stock Quote",
			description:
				"Get current stock quote including price, volume, change, and basic stats. " +
				"Use this for quick price checks on individual symbols.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Ticker symbol (e.g. SPY, AAPL, QQQ)" },
				},
				required: ["symbol"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbol = (params.symbol as string).toUpperCase();
				return jsonResult(await polygon.getQuote(symbol));
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
				"Fetch options chain for a symbol. Returns strikes, expiries, IV, greeks, OI. " +
				"Optionally filter by expiration date or strike range around ATM.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Underlying ticker symbol" },
					expiration: { type: "string", description: "Filter by expiration date (YYYY-MM-DD). Optional." },
					strike_range_pct: {
						type: "number",
						description: "Percentage range around ATM to include (e.g. 10 = +/-10%). Default: 20.",
					},
					option_type: {
						type: "string",
						description: "Filter by option type: 'call', 'put', or omit for both.",
						enum: ["call", "put"],
					},
				},
				required: ["symbol"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbol = (params.symbol as string).toUpperCase();
				return jsonResult(await polygon.getOptionsChain(symbol, {
					expiration: params.expiration as string | undefined,
					strikeRangePct: (params.strike_range_pct as number) ?? 20,
					optionType: params.option_type as "call" | "put" | undefined,
				}));
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
				"Fetch historical OHLCV (open, high, low, close, volume) bars for a symbol. " +
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
				return jsonResult(await polygon.getHistoricalOHLCV(symbol, {
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
				"Get implied volatility surface for a symbol — IV by strike and expiration. " +
				"Useful for analyzing term structure and skew.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Underlying ticker symbol" },
				},
				required: ["symbol"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbol = (params.symbol as string).toUpperCase();
				return jsonResult(await polygon.getIVSurface(symbol));
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
				"Get upcoming earnings dates for specified symbols or the market. " +
				"Important for options strategies around earnings events.",
			parameters: {
				type: "object",
				properties: {
					symbols: {
						type: "array",
						items: { type: "string" },
						description: "List of symbols to check. Omit for broad market.",
					},
					days_ahead: { type: "number", description: "How many days ahead to look. Default: 14." },
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbols = params.symbols as string[] | undefined;
				const daysAhead = (params.days_ahead as number) ?? 14;
				return jsonResult(await polygon.getEarningsCalendar(symbols, daysAhead));
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
				"Get dividend history for a symbol including ex-dates, payment dates, and amounts. " +
				"Important for covered call and collar strategy modeling.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Ticker symbol" },
					years: { type: "number", description: "How many years of history. Default: 3." },
				},
				required: ["symbol"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbol = (params.symbol as string).toUpperCase();
				const years = (params.years as number) ?? 3;
				return jsonResult(await polygon.getDividendHistory(symbol, years));
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
				"Get upcoming economic events (FOMC, CPI, NFP, etc.). " +
				"Useful for timing volatility strategies around macro events.",
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

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";
import { AlpacaClient } from "../data/alpaca-client.js";
import { IBKRClient } from "../data/ibkr-client.js";
import { YFinanceClient } from "../data/yfinance-client.js";
import { MarketDataRouter } from "../data/symbol-router.js";
import { FredClient } from "../data/fred-client.js";
import { jsonResult } from "./result.js";

export function registerMarketDataTools(api: OpenClawPluginApi, ctx: PluginContext) {
	const alpaca = ctx.config.alpacaApiKey
		? new AlpacaClient(
				ctx.config.alpacaApiKey,
				ctx.config.alpacaApiSecret,
				ctx.logger,
				ctx.dataDir,
				ctx.config.alpacaBaseUrl,
			)
		: null;
	const ibkr = new IBKRClient(
		ctx.config.ibkrHost ?? "localhost",
		ctx.config.ibkrPort ?? 4000,
		ctx.logger,
	);
	const yfinance = new YFinanceClient(ctx);
	const router = new MarketDataRouter(alpaca, ibkr, yfinance, ctx.logger);
	const fred = ctx.config.fredApiKey ? new FredClient(ctx.config.fredApiKey, ctx.logger) : null;

	// ── get_stock_quote ──
	api.registerTool(
		{
			name: "get_stock_quote",
			label: "Get Stock Quote",
			description:
				"Get current stock quote including price, bid/ask, volume, and daily bar. " +
				"Supports US equities (via Alpaca IEX) and international markets via IBKR/yfinance " +
				"(HK, London, Euronext, Tokyo, etc.).",
			parameters: {
				type: "object",
				properties: {
					symbol: {
						type: "string",
						description:
							"Ticker symbol. US: SPY, AAPL. International: 0941.HK, 0823.HK, BATS.L, DG.PA, 7203.T",
					},
				},
				required: ["symbol"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbol = (params.symbol as string).toUpperCase();
				return jsonResult(await router.getQuote(symbol));
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
				"Fetch options chain for a symbol via yfinance. " +
				"Includes strikes, bids, asks, volume, open interest, and implied volatility. " +
				"Typically available for US-listed equities only.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Underlying ticker symbol" },
					expiration: { type: "string", description: "Filter by expiration date (YYYY-MM-DD). Optional." },
					strike_range_pct: { type: "number", description: "Percentage range around ATM to include. Default: 20." },
					option_type: { type: "string", enum: ["call", "put"], description: "Filter by call or put. Optional." },
				},
				required: ["symbol"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbol = (params.symbol as string).toUpperCase();
				return jsonResult(await yfinance.getOptionsChain(symbol, {
					expiration: params.expiration as string | undefined,
					strikeRangePct: params.strike_range_pct as number | undefined,
					optionType: params.option_type as string | undefined,
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
				"Fetch historical OHLCV bars for a symbol. " +
				"US equities use Alpaca IEX (with local caching); international symbols use IBKR or yfinance. " +
				"Supports daily, hourly, 5-minute, weekly, and monthly intervals. Up to 10 years of history.",
			parameters: {
				type: "object",
				properties: {
					symbol: {
						type: "string",
						description:
							"Ticker symbol. US: SPY, AAPL. International: 0941.HK, BATS.L, DG.PA",
					},
					start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
					end_date: { type: "string", description: "End date (YYYY-MM-DD). Default: today." },
					interval: {
						type: "string",
						description: "Bar interval: '1d' (default), '1h', '5m', '1wk', '1mo'",
						enum: ["1d", "1h", "5m", "1wk", "1mo"],
					},
				},
				required: ["symbol", "start_date"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbol = (params.symbol as string).toUpperCase();
				return jsonResult(await router.getHistoricalOHLCV(symbol, {
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
				"Get implied volatility surface for a symbol via yfinance. " +
				"Returns IV by (expiration, strike) across available option expirations. " +
				"Typically available for US-listed equities only.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Underlying ticker symbol" },
				},
				required: ["symbol"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbol = (params.symbol as string).toUpperCase();
				return jsonResult(await yfinance.getIVSurface(symbol));
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
				"Get upcoming earnings dates and estimates for specified symbols via yfinance.",
			parameters: {
				type: "object",
				properties: {
					symbols: { type: "array", items: { type: "string" }, description: "List of symbols to check." },
					days_ahead: { type: "number", description: "How many days ahead to look. Default: 14." },
				},
				required: ["symbols"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbols = (params.symbols as string[]).map((s) => s.toUpperCase());
				const daysAhead = (params.days_ahead as number) ?? 14;
				return jsonResult(await yfinance.getEarningsCalendar(symbols, daysAhead));
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
				"Get dividend history for a symbol via yfinance. " +
				"Includes payment dates, amounts, and computed yield.",
			parameters: {
				type: "object",
				properties: {
					symbol: {
						type: "string",
						description: "Ticker symbol. Works for US and international equities.",
					},
					years: { type: "number", description: "How many years of history. Default: 3." },
				},
				required: ["symbol"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbol = (params.symbol as string).toUpperCase();
				const years = (params.years as number) ?? 3;
				return jsonResult(await yfinance.getDividendHistory(symbol, years));
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

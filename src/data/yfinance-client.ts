/**
 * TypeScript bridge to the Python yfinance client.
 * Uses the subprocess engine-runner pattern (same as options_pricer).
 */
import { runPythonEngine } from "../engine-runner.js";
import type { PluginContext } from "../types.js";

export class YFinanceClient {
	constructor(private ctx: PluginContext) {}

	async getQuote(symbol: string): Promise<unknown> {
		return runPythonEngine("yfinance_client", "get_quote", { symbol }, this.ctx);
	}

	async getHistoricalOHLCV(
		symbol: string,
		params: { startDate: string; endDate?: string; interval?: string },
	): Promise<unknown> {
		return runPythonEngine("yfinance_client", "get_historical_ohlcv", {
			symbol,
			start_date: params.startDate,
			end_date: params.endDate,
			interval: params.interval ?? "1d",
		}, this.ctx);
	}

	async getOptionsChain(
		symbol: string,
		params: { expiration?: string; strikeRangePct?: number; optionType?: string },
	): Promise<unknown> {
		return runPythonEngine("yfinance_client", "get_options_chain", {
			symbol,
			expiration: params.expiration,
			strike_range_pct: params.strikeRangePct ?? 20,
			option_type: params.optionType,
		}, this.ctx);
	}

	async getIVSurface(symbol: string): Promise<unknown> {
		return runPythonEngine("yfinance_client", "get_iv_surface", { symbol }, this.ctx);
	}

	async getEarningsCalendar(symbols: string[], daysAhead?: number): Promise<unknown> {
		return runPythonEngine("yfinance_client", "get_earnings_calendar", {
			symbols,
			days_ahead: daysAhead ?? 14,
		}, this.ctx);
	}

	async getDividendHistory(symbol: string, years?: number): Promise<unknown> {
		return runPythonEngine("yfinance_client", "get_dividend_history", {
			symbol,
			years: years ?? 3,
		}, this.ctx);
	}
}

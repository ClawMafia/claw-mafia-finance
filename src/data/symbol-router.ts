/**
 * Routes market data requests to the appropriate provider:
 *   - International symbols (e.g. 941.HK, BATS.L, DG.PA) -> yfinance
 *   - US symbols with Alpaca credentials available       -> Alpaca (faster, real-time)
 *   - US symbols without Alpaca credentials              -> yfinance (fallback)
 */
import type { AlpacaClient } from "./alpaca-client.js";
import type { YFinanceClient } from "./yfinance-client.js";

// Exchange suffixes that indicate an international symbol.
// US dual-class shares like BRK.A, BRK.B are excluded.
const US_DUAL_CLASS = /^[A-Z]+\.[A-B]$/;

export function isInternationalSymbol(symbol: string): boolean {
	if (US_DUAL_CLASS.test(symbol)) return false;
	return /\.\w{1,4}$/.test(symbol);
}

export class MarketDataRouter {
	constructor(
		private alpaca: AlpacaClient | null,
		private yfinance: YFinanceClient,
	) {}

	async getQuote(symbol: string): Promise<unknown> {
		if (isInternationalSymbol(symbol) || !this.alpaca) {
			return this.yfinance.getQuote(symbol);
		}
		try {
			return await this.alpaca.getQuote(symbol);
		} catch {
			// Alpaca may not have data for some symbols (OTC, etc.)
			return this.yfinance.getQuote(symbol);
		}
	}

	async getHistoricalOHLCV(
		symbol: string,
		params: { startDate: string; endDate?: string; interval?: string },
	): Promise<unknown> {
		if (isInternationalSymbol(symbol) || !this.alpaca) {
			return this.yfinance.getHistoricalOHLCV(symbol, params);
		}
		try {
			return await this.alpaca.getHistoricalOHLCV(symbol, params);
		} catch {
			return this.yfinance.getHistoricalOHLCV(symbol, params);
		}
	}
}

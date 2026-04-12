/**
 * Routes market data requests to the appropriate provider:
 *
 * Quotes:
 *   - International symbols → IBKR (delayed but covers all exchanges) → yfinance fallback
 *   - US symbols            → Alpaca IEX (free real-time) → IBKR → yfinance fallback
 *
 * Historical OHLCV:
 *   - International symbols → IBKR (up to 10y) → yfinance fallback
 *   - US symbols            → Alpaca (free, cached) → IBKR → yfinance fallback
 */
import { BarSizeSetting } from "@stoqey/ib";
import type { AlpacaClient } from "./alpaca-client.js";
import type { IBKRClient } from "./ibkr-client.js";
import type { YFinanceClient } from "./yfinance-client.js";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

// Exchange suffixes that indicate an international symbol.
// US dual-class shares like BRK.A, BRK.B are excluded.
const US_DUAL_CLASS = /^[A-Z]+\.[A-B]$/;

export function isInternationalSymbol(symbol: string): boolean {
	if (US_DUAL_CLASS.test(symbol)) return false;
	return /\.\w{1,4}$/.test(symbol);
}

/**
 * Map user-facing intervals to TWS API BarSizeSetting and duration strings.
 */
const INTERVAL_MAP: Record<string, { barSize: BarSizeSetting }> = {
	"5m": { barSize: BarSizeSetting.MINUTES_FIVE },
	"1h": { barSize: BarSizeSetting.HOURS_ONE },
	"1d": { barSize: BarSizeSetting.DAYS_ONE },
	"1wk": { barSize: BarSizeSetting.WEEKS_ONE },
	"1mo": { barSize: BarSizeSetting.MONTHS_ONE },
};

/**
 * Convert start/end date range to a TWS API duration string.
 * TWS accepts: "N S", "N D", "N W", "N M", "N Y"
 */
function dateRangeToTWSDuration(startDate: string, endDate?: string): string {
	const start = new Date(startDate).getTime();
	const end = endDate ? new Date(endDate).getTime() : Date.now();
	const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

	if (days <= 7) return `${days} D`;
	if (days <= 365) return `${Math.ceil(days / 30)} M`;
	return `${Math.ceil(days / 365)} Y`;
}

export class MarketDataRouter {
	constructor(
		private alpaca: AlpacaClient | null,
		private ibkr: IBKRClient,
		private yfinance: YFinanceClient,
		private logger: Logger,
	) {}

	async getQuote(symbol: string): Promise<unknown> {
		const international = isInternationalSymbol(symbol);

		// US → Alpaca first (free real-time IEX)
		if (!international && this.alpaca) {
			try {
				return await this.alpaca.getQuote(symbol);
			} catch {
				// fall through to IBKR
			}
		}

		// IBKR for international (primary) or US (fallback)
		try {
			const snap = await this.ibkr.getSnapshot(symbol);
			if (snap.last || snap.close) {
				return {
					symbol,
					price: snap.last ?? snap.close,
					bid: snap.bid,
					ask: snap.ask,
					high: snap.high,
					low: snap.low,
					open: snap.open,
					close: snap.close,
					source: "ibkr",
				};
			}
		} catch (e) {
			this.logger.warn(`IBKR quote failed for ${symbol}: ${(e as Error).message}`);
		}

		// Final fallback: yfinance
		return this.yfinance.getQuote(symbol);
	}

	async getHistoricalOHLCV(
		symbol: string,
		params: { startDate: string; endDate?: string; interval?: string },
	): Promise<unknown> {
		const international = isInternationalSymbol(symbol);
		const interval = params.interval ?? "1d";

		// US → try Alpaca first (free, cached, no rate limit issues)
		if (!international && this.alpaca) {
			try {
				return await this.alpaca.getHistoricalOHLCV(symbol, params);
			} catch {
				// fall through
			}
		}

		// IBKR for international (primary) or US (fallback)
		const mapping = INTERVAL_MAP[interval];
		if (mapping) {
			try {
				const duration = dateRangeToTWSDuration(params.startDate, params.endDate);
				const result = await this.ibkr.getHistoricalBars(
					symbol, duration, mapping.barSize,
				);
				if (result.bars.length > 0) {
					return {
						symbol,
						start_date: params.startDate,
						end_date: params.endDate ?? new Date().toISOString().slice(0, 10),
						interval,
						source: "ibkr",
						bars: result.bars.map((b) => ({
							t: b.time,
							o: b.open,
							h: b.high,
							l: b.low,
							c: b.close,
							v: b.volume,
						})),
						count: result.bars.length,
					};
				}
			} catch (e) {
				this.logger.warn(`IBKR history failed for ${symbol}: ${(e as Error).message}`);
			}
		}

		// Final fallback: yfinance
		return this.yfinance.getHistoricalOHLCV(symbol, params);
	}
}

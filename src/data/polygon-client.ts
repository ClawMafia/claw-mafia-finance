/**
 * Polygon.io API client for market data.
 * Docs: https://polygon.io/docs
 */

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

type OptionsChainFilter = {
	expiration?: string;
	strikeRangePct?: number;
	optionType?: "call" | "put";
};

type OHLCVParams = {
	startDate: string;
	endDate?: string;
	interval?: string;
};

export class PolygonClient {
	private baseUrl = "https://api.polygon.io";

	constructor(
		private apiKey: string,
		private logger: Logger,
	) {}

	private async fetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
		const url = new URL(`${this.baseUrl}${path}`);
		url.searchParams.set("apiKey", this.apiKey);
		for (const [k, v] of Object.entries(params)) {
			url.searchParams.set(k, v);
		}

		const response = await globalThis.fetch(url.toString());
		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Polygon API error ${response.status}: ${text}`);
		}
		return response.json();
	}

	async getQuote(symbol: string) {
		// Free tier: snapshot endpoint requires paid plan.
		// Use previous close + ticker details as fallback.
		try {
			const [prevClose, tickerDetails] = await Promise.all([
				this.fetch(`/v2/aggs/ticker/${symbol}/prev`),
				this.fetch(`/v3/reference/tickers/${symbol}`).catch(() => null),
			]);

			return { symbol, previous_close: prevClose, details: tickerDetails };
		} catch (e) {
			throw new Error(`Failed to get quote for ${symbol}: ${(e as Error).message}`);
		}
	}

	async getOptionsChain(symbol: string, filter: OptionsChainFilter) {
		// Options snapshot requires Starter+ plan.
		// Free tier: use options contracts reference endpoint as fallback.
		try {
			const params: Record<string, string> = {
				"underlying_ticker": symbol,
				"limit": "250",
				"order": "asc",
				"sort": "strike_price",
			};

			if (filter.expiration) {
				params["expiration_date"] = filter.expiration;
			}
			if (filter.optionType) {
				params["contract_type"] = filter.optionType;
			}

			const data = await this.fetch("/v3/snapshot/options/" + symbol, params);
			return { symbol, filter, chain: data };
		} catch (e) {
			// Fallback: try reference endpoint (free tier)
			this.logger.warn(`Options snapshot failed (likely free tier), trying reference endpoint`);
			const params: Record<string, string> = {
				"underlying_ticker": symbol,
				"limit": "100",
				"order": "asc",
				"sort": "expiration_date",
			};
			if (filter.expiration) {
				params["expiration_date"] = filter.expiration;
			}
			if (filter.optionType) {
				params["contract_type"] = filter.optionType;
			}
			const data = await this.fetch("/v3/reference/options/contracts", params);
			return {
				symbol,
				filter,
				chain: data,
				note: "Free tier: contract reference only, no live greeks/IV. Upgrade to Starter for full chain.",
			};
		}
	}

	async getHistoricalOHLCV(symbol: string, params: OHLCVParams) {
		const multiplier = params.interval === "1h" ? "1" : params.interval === "5m" ? "5" : "1";
		const timespan = params.interval === "1h" ? "hour" : params.interval === "5m" ? "minute" : "day";
		const endDate = params.endDate ?? new Date().toISOString().slice(0, 10);

		const data = await this.fetch(
			`/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${params.startDate}/${endDate}`,
			{ adjusted: "true", sort: "asc", limit: "50000" },
		);

		return { symbol, start_date: params.startDate, end_date: endDate, interval: params.interval ?? "1d", data };
	}

	async getIVSurface(symbol: string) {
		const chain = await this.fetch("/v3/snapshot/options/" + symbol, {
			underlying_ticker: symbol,
			limit: "250",
			order: "asc",
			sort: "expiration_date",
		});

		return { symbol, surface: chain };
	}

	async getEarningsCalendar(symbols: string[] | undefined, daysAhead: number) {
		// Polygon doesn't have a direct earnings calendar endpoint.
		// Use the reference/tickers endpoint with type filter, or fallback.
		// For now, use the stock financials endpoint for each symbol.
		if (symbols && symbols.length > 0) {
			const results = await Promise.all(
				symbols.map(async (sym) => {
					try {
						const data = await this.fetch(`/vX/reference/tickers/${sym.toUpperCase()}/events`, {
							types: "dividend,split",
						});
						return { symbol: sym, events: data };
					} catch {
						return { symbol: sym, events: null, error: "Not available" };
					}
				}),
			);
			return { days_ahead: daysAhead, earnings: results };
		}

		return {
			days_ahead: daysAhead,
			message: "Provide specific symbols to check earnings. Broad market earnings calendar requires FMP or similar API.",
		};
	}

	async getDividendHistory(symbol: string, years: number) {
		const data = await this.fetch(`/v3/reference/dividends`, {
			ticker: symbol,
			limit: String(years * 12),
			order: "desc",
		});

		return { symbol, years, dividends: data };
	}
}

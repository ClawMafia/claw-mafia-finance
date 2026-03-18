/**
 * Polygon.io API client for market data.
 * Docs: https://polygon.io/docs
 */
import * as fs from "node:fs";
import * as path from "node:path";

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

type PolygonBar = {
	t: number; // timestamp ms
	o: number;
	h: number;
	l: number;
	c: number;
	v: number;
	vw?: number;
	n?: number;
};

export class PolygonClient {
	private baseUrl = "https://api.polygon.io";

	constructor(
		private apiKey: string,
		private logger: Logger,
		private cacheDir?: string,
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

	// ── OHLCV cache helpers ──

	private getCacheFile(symbol: string, interval: string): string {
		return path.join(this.cacheDir!, "ohlcv", `${symbol}-${interval}.json`);
	}

	private loadOHLCVCache(symbol: string, interval: string): PolygonBar[] | null {
		if (!this.cacheDir) return null;
		const file = this.getCacheFile(symbol, interval);
		try {
			if (!fs.existsSync(file)) return null;
			return JSON.parse(fs.readFileSync(file, "utf-8")) as PolygonBar[];
		} catch {
			return null;
		}
	}

	private saveOHLCVCache(symbol: string, interval: string, bars: PolygonBar[]): void {
		if (!this.cacheDir) return;
		const dir = path.join(this.cacheDir, "ohlcv");
		try {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(this.getCacheFile(symbol, interval), JSON.stringify(bars));
		} catch (e) {
			this.logger.warn(`OHLCV cache write failed: ${(e as Error).message}`);
		}
	}

	/** Returns true if sorted bars array fully covers [startDate, endDate] and endDate is > 2 days old. */
	private cacheCovers(bars: PolygonBar[], startDate: string, endDate: string): boolean {
		if (bars.length === 0) return false;
		const startMs = new Date(startDate).getTime();
		const endMs = new Date(endDate).getTime();
		const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
		// Always fetch fresh for recent/live data
		if (endMs > Date.now() - twoDaysMs) return false;
		return bars[0].t <= startMs && bars[bars.length - 1].t >= endMs;
	}

	private filterBars(bars: PolygonBar[], startDate: string, endDate: string): PolygonBar[] {
		const startMs = new Date(startDate).getTime();
		const endMs = new Date(endDate).getTime() + 86400000; // include full end day
		return bars.filter((b) => b.t >= startMs && b.t < endMs);
	}

	private mergeBars(existing: PolygonBar[], newBars: PolygonBar[]): PolygonBar[] {
		const map = new Map<number, PolygonBar>();
		for (const b of existing) map.set(b.t, b);
		for (const b of newBars) map.set(b.t, b);
		return Array.from(map.values()).sort((a, b) => a.t - b.t);
	}

	// ── Public methods ──

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
			// Note: underlyingAsset is path-only; do not repeat as query param.
			const params: Record<string, string> = {
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
		const interval = params.interval ?? "1d";
		const endDate = params.endDate ?? new Date().toISOString().slice(0, 10);

		// Check cache first
		const cached = this.loadOHLCVCache(symbol, interval);
		if (cached && this.cacheCovers(cached, params.startDate, endDate)) {
			this.logger.info(`OHLCV cache hit: ${symbol} ${interval}`);
			const filtered = this.filterBars(cached, params.startDate, endDate);
			return {
				symbol,
				start_date: params.startDate,
				end_date: endDate,
				interval,
				source: "cache",
				data: { ticker: symbol, status: "OK", resultsCount: filtered.length, results: filtered },
			};
		}

		const multiplier = interval === "1h" ? "1" : interval === "5m" ? "5" : "1";
		const timespan = interval === "1h" ? "hour" : interval === "5m" ? "minute" : "day";

		const data = await this.fetch(
			`/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${params.startDate}/${endDate}`,
			{ adjusted: "true", sort: "asc", limit: "50000" },
		) as { results?: PolygonBar[] };

		// Merge fetched bars into cache
		if (data.results && data.results.length > 0) {
			const merged = cached ? this.mergeBars(cached, data.results) : data.results;
			this.saveOHLCVCache(symbol, interval, merged);
		}

		return { symbol, start_date: params.startDate, end_date: endDate, interval, source: "api", data };
	}

	async getIVSurface(symbol: string) {
		// Note: underlyingAsset is path-only; do not repeat as query param.
		const chain = await this.fetch("/v3/snapshot/options/" + symbol, {
			limit: "250",
			order: "asc",
			sort: "expiration_date",
		});

		return { symbol, surface: chain };
	}

	async getEarningsCalendar(symbols: string[] | undefined, daysAhead: number) {
		// Polygon free tier: use /vX/reference/financials to get most recent quarterly
		// period end date and estimate the next earnings date as +90 days.
		if (symbols && symbols.length > 0) {
			type FinancialResult = { period_of_report_date?: string; fiscal_period?: string; fiscal_year?: string };
			const results = await Promise.all(
				symbols.map(async (sym) => {
					try {
						const data = await this.fetch(`/vX/reference/financials`, {
							ticker: sym.toUpperCase(),
							timeframe: "quarterly",
							sort: "period_of_report_date",
							order: "desc",
							limit: "2",
						}) as { results?: FinancialResult[] };

						const recent = data.results?.[0];
						let estimated_next: string | null = null;
						if (recent?.period_of_report_date) {
							const nextDate = new Date(recent.period_of_report_date);
							nextDate.setDate(nextDate.getDate() + 90);
							estimated_next = nextDate.toISOString().slice(0, 10);
						}

						return {
							symbol: sym,
							most_recent_period: recent?.period_of_report_date ?? null,
							fiscal_period: recent?.fiscal_period ?? null,
							fiscal_year: recent?.fiscal_year ?? null,
							estimated_next_earnings: estimated_next,
							note: "Estimated: last period end + 90 days. Actual date may differ — verify with an official earnings calendar.",
						};
					} catch {
						return { symbol: sym, error: "Earnings data not available for this symbol on free tier." };
					}
				}),
			);
			return { days_ahead: daysAhead, earnings: results };
		}

		return {
			days_ahead: daysAhead,
			message: "Provide specific symbols to check earnings. Broad market earnings calendar requires FMP or a dedicated calendar API.",
		};
	}

	async getDividendHistory(symbol: string, years: number) {
		// Note: /v3/reference/dividends has no 'order' param; direction is a suffix on 'sort'.
		const data = await this.fetch(`/v3/reference/dividends`, {
			ticker: symbol,
			limit: String(years * 12),
			sort: "ex_dividend_date.desc",
		});

		return { symbol, years, dividends: data };
	}
}

/**
 * Alpaca API client for market data (IEX feed) and paper trading.
 * Docs: https://docs.alpaca.markets/reference
 *
 * Two base URLs:
 *   Trading: https://paper-api.alpaca.markets/v2  (orders, positions, account)
 *   Data:    https://data.alpaca.markets/v2        (quotes, bars, snapshots)
 */
import * as fs from "node:fs";
import * as path from "node:path";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

type OHLCVParams = {
	startDate: string;
	endDate?: string;
	interval?: string;
};

type AlpacaBar = {
	t: string; // ISO timestamp
	o: number;
	h: number;
	l: number;
	c: number;
	v: number;
	vw?: number;
	n?: number;
};

export class AlpacaClient {
	private dataUrl = "https://data.alpaca.markets";
	private tradingUrl: string;

	constructor(
		private apiKey: string,
		private apiSecret: string,
		private logger: Logger,
		private cacheDir?: string,
		tradingBaseUrl = "https://paper-api.alpaca.markets",
	) {
		this.tradingUrl = tradingBaseUrl;
	}

	private get authHeaders(): Record<string, string> {
		return {
			"APCA-API-KEY-ID": this.apiKey,
			"APCA-API-SECRET-KEY": this.apiSecret,
			"Content-Type": "application/json",
		};
	}

	private async fetchTrading(endpoint: string, options: RequestInit = {}): Promise<unknown> {
		const url = `${this.tradingUrl}/v2${endpoint}`;
		const response = await globalThis.fetch(url, {
			...options,
			headers: { ...this.authHeaders, ...((options.headers as Record<string, string>) ?? {}) },
		});
		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Alpaca trading API error ${response.status} at ${endpoint}: ${text}`);
		}
		// DELETE /orders/{id} returns 204 No Content
		if (response.status === 204) return {};
		return response.json();
	}

	private async fetchData(endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
		const url = new URL(`${this.dataUrl}/v2${endpoint}`);
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
		const response = await globalThis.fetch(url.toString(), { headers: this.authHeaders });
		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Alpaca data API error ${response.status} at ${endpoint}: ${text}`);
		}
		return response.json();
	}

	// ── OHLCV cache helpers ──

	private getCacheFile(symbol: string, interval: string): string {
		return path.join(this.cacheDir!, "ohlcv", `${symbol}-${interval}.json`);
	}

	private loadOHLCVCache(symbol: string, interval: string): AlpacaBar[] | null {
		if (!this.cacheDir) return null;
		const file = this.getCacheFile(symbol, interval);
		try {
			if (!fs.existsSync(file)) return null;
			return JSON.parse(fs.readFileSync(file, "utf-8")) as AlpacaBar[];
		} catch {
			return null;
		}
	}

	private saveOHLCVCache(symbol: string, interval: string, bars: AlpacaBar[]): void {
		if (!this.cacheDir) return;
		const dir = path.join(this.cacheDir, "ohlcv");
		try {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(this.getCacheFile(symbol, interval), JSON.stringify(bars));
		} catch (e) {
			this.logger.warn(`OHLCV cache write failed: ${(e as Error).message}`);
		}
	}

	private cacheCovers(bars: AlpacaBar[], startDate: string, endDate: string): boolean {
		if (bars.length === 0) return false;
		const startMs = new Date(startDate).getTime();
		const endMs = new Date(endDate).getTime();
		const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
		if (endMs > Date.now() - twoDaysMs) return false;
		const firstT = new Date(bars[0].t).getTime();
		const lastT = new Date(bars[bars.length - 1].t).getTime();
		return firstT <= startMs && lastT >= endMs;
	}

	private filterBars(bars: AlpacaBar[], startDate: string, endDate: string): AlpacaBar[] {
		const startMs = new Date(startDate).getTime();
		const endMs = new Date(endDate).getTime() + 86400000;
		return bars.filter((b) => {
			const t = new Date(b.t).getTime();
			return t >= startMs && t < endMs;
		});
	}

	private mergeBars(existing: AlpacaBar[], newBars: AlpacaBar[]): AlpacaBar[] {
		const map = new Map<string, AlpacaBar>();
		for (const b of existing) map.set(b.t, b);
		for (const b of newBars) map.set(b.t, b);
		return Array.from(map.values()).sort((a, b) => (a.t < b.t ? -1 : 1));
	}

	// ── Strategy order tracking (local state) ──
	// Alpaca doesn't natively tag orders by strategy. We embed strategy_id in
	// client_order_id ("{strategy_id}--{timestamp}") and persist the mapping locally.

	private getStrategyOrdersFile(): string {
		return path.join(this.cacheDir ?? "/tmp", "paper-trading", "strategy-orders.json");
	}

	private loadStrategyOrders(): Record<string, string> {
		try {
			const file = this.getStrategyOrdersFile();
			if (!fs.existsSync(file)) return {};
			return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, string>;
		} catch {
			return {};
		}
	}

	private saveStrategyOrder(orderId: string, strategyId: string): void {
		try {
			const file = this.getStrategyOrdersFile();
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const map = this.loadStrategyOrders();
			map[orderId] = strategyId;
			fs.writeFileSync(file, JSON.stringify(map));
		} catch (e) {
			this.logger.warn(`Strategy order tracking save failed: ${(e as Error).message}`);
		}
	}

	// ── Market Data ──

	async getQuote(symbol: string) {
		try {
			const snapshot = await this.fetchData(`/stocks/${symbol}/snapshot`, { feed: "iex" }) as {
				latestTrade: { p: number; s: number; t: string };
				latestQuote: { ap: number; bp: number; as: number; bs: number };
				dailyBar: { o: number; h: number; l: number; c: number; v: number };
				prevDailyBar: { c: number };
			};
			return {
				symbol,
				price: snapshot.latestTrade?.p,
				bid: snapshot.latestQuote?.bp,
				ask: snapshot.latestQuote?.ap,
				open: snapshot.dailyBar?.o,
				high: snapshot.dailyBar?.h,
				low: snapshot.dailyBar?.l,
				close: snapshot.dailyBar?.c,
				volume: snapshot.dailyBar?.v,
				prev_close: snapshot.prevDailyBar?.c,
				timestamp: snapshot.latestTrade?.t,
				source: "alpaca_iex",
			};
		} catch (e) {
			throw new Error(`Failed to get quote for ${symbol}: ${(e as Error).message}`);
		}
	}

	async getHistoricalOHLCV(symbol: string, params: OHLCVParams) {
		const interval = params.interval ?? "1d";
		const endDate = params.endDate ?? new Date().toISOString().slice(0, 10);

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
				bars: filtered,
				count: filtered.length,
			};
		}

		const timeframeMap: Record<string, string> = { "1d": "1Day", "1h": "1Hour", "5m": "5Min" };
		const timeframe = timeframeMap[interval] ?? "1Day";

		const allBars: AlpacaBar[] = [];
		let nextPageToken: string | undefined;

		do {
			const queryParams: Record<string, string> = {
				timeframe,
				start: params.startDate,
				end: endDate,
				adjustment: "all",
				feed: "iex",
				limit: "10000",
			};
			if (nextPageToken) queryParams.page_token = nextPageToken;

			const data = await this.fetchData(`/stocks/${symbol}/bars`, queryParams) as {
				bars: AlpacaBar[];
				next_page_token?: string;
			};

			allBars.push(...(data.bars ?? []));
			nextPageToken = data.next_page_token ?? undefined;
		} while (nextPageToken);

		if (allBars.length > 0) {
			const merged = cached ? this.mergeBars(cached, allBars) : allBars;
			this.saveOHLCVCache(symbol, interval, merged);
		}

		return {
			symbol,
			start_date: params.startDate,
			end_date: endDate,
			interval,
			source: "alpaca_iex",
			bars: allBars,
			count: allBars.length,
		};
	}

	// ── Paper Trading ──

	async getAccount() {
		return this.fetchTrading("/account");
	}

	async submitOrder(params: {
		symbol: string;
		side: "buy" | "sell";
		quantity: number;
		order_type: "market" | "limit";
		limit_price?: number;
		strategy_id: string;
	}) {
		const body: Record<string, unknown> = {
			symbol: params.symbol,
			side: params.side,
			qty: params.quantity,
			type: params.order_type,
			time_in_force: "day",
			client_order_id: `${params.strategy_id}--${Date.now()}`,
		};
		if (params.order_type === "limit" && params.limit_price != null) {
			body.limit_price = params.limit_price;
		}

		const order = await this.fetchTrading("/orders", {
			method: "POST",
			body: JSON.stringify(body),
		}) as { id: string };

		if (order.id) {
			this.saveStrategyOrder(order.id, params.strategy_id);
		}

		return order;
	}

	async cancelOrder(orderId: string) {
		await this.fetchTrading(`/orders/${orderId}`, { method: "DELETE" });
		return { cancelled: true, order_id: orderId };
	}

	async getPositions(strategyId?: string) {
		const positions = await this.fetchTrading("/positions");
		return {
			positions,
			strategy_filter: strategyId ?? null,
			...(strategyId
				? { note: "Alpaca does not natively filter positions by strategy. Showing all positions; use get_paper_order_history to filter activity by strategy." }
				: {}),
		};
	}

	async getPnL(period = "today") {
		const periodMap: Record<string, string> = {
			today: "1D",
			mtd: "1M",
			ytd: "1A",
			inception: "all",
		};
		const alpacaPeriod = periodMap[period] ?? "1D";

		const [account, history] = await Promise.all([
			this.fetchTrading("/account"),
			this.fetchTrading(`/account/portfolio/history?period=${alpacaPeriod}&extended_hours=false`),
		]);

		const acc = account as { equity: string; last_equity: string; cash: string };
		const hist = history as {
			equity: number[];
			profit_loss: number[];
			profit_loss_pct: number[];
			timestamp: number[];
		};

		const lastPL = hist.profit_loss?.[hist.profit_loss.length - 1] ?? 0;
		const lastPLPct = hist.profit_loss_pct?.[hist.profit_loss_pct.length - 1] ?? 0;

		return {
			period,
			equity: parseFloat(acc.equity),
			cash: parseFloat(acc.cash),
			pnl: lastPL,
			pnl_pct: lastPLPct,
			source: "alpaca_paper",
		};
	}

	async getOrders(params: { strategy_id?: string; start_date?: string; end_date?: string }) {
		const qs = new URLSearchParams({ status: "all", limit: "500", direction: "desc" });
		if (params.start_date) qs.set("after", params.start_date);
		if (params.end_date) qs.set("until", params.end_date);

		const orders = await this.fetchTrading(`/orders?${qs.toString()}`) as Array<{
			id: string;
			client_order_id: string;
			symbol: string;
			side: string;
			qty: string;
			type: string;
			status: string;
			filled_avg_price: string | null;
			filled_at: string | null;
			created_at: string;
		}>;

		if (params.strategy_id) {
			return orders.filter((o) => o.client_order_id?.startsWith(`${params.strategy_id}--`));
		}
		return orders;
	}
}

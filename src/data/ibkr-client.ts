/**
 * IBKR TWS API client via IB Gateway socket connection.
 * Uses @stoqey/ib to communicate over the TWS protocol.
 *
 * Connects to IB Gateway (e.g. heshiming/ibga Docker container)
 * on the configured host:port (default localhost:4000).
 */
import { IBApi, EventName, Contract, Order, OrderAction, OrderType, TimeInForce, SecType, BarSizeSetting, WhatToShow } from "@stoqey/ib";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

export type IBKRPosition = {
	symbol: string;
	conid: number;
	quantity: number;
	avgCost: number;
	account: string;
	secType: string;
	currency: string;
};

export type IBKROrderResult = {
	orderId: number;
	status: string;
	filled: number;
	remaining: number;
	avgFillPrice: number;
	symbol?: string;
};

export class IBKRClient {
	private api: IBApi;
	private connected = false;
	private nextOrderId = 0;
	private connectPromise: Promise<void> | null = null;

	constructor(
		private host: string,
		private port: number,
		private logger: Logger,
		private clientId = 0,
	) {
		this.api = new IBApi({ host, port, clientId });

		this.api.on(EventName.nextValidId, (orderId: number) => {
			this.nextOrderId = orderId;
		});

		this.api.on(EventName.error, (err: Error, code: number, reqId: number) => {
			// Filter out informational messages (data farm connections)
			if (code === 2104 || code === 2106 || code === 2158) return;
			this.logger.error(`IBKR error [code=${code}, reqId=${reqId}]: ${err.message}`);
		});
	}

	// ── Connection ──

	async ensureConnected(): Promise<void> {
		if (this.connected) return;
		if (this.connectPromise) return this.connectPromise;

		this.connectPromise = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`IBKR connection timeout (${this.host}:${this.port})`));
			}, 10_000);

			this.api.once(EventName.connected, () => {
				this.connected = true;
				this.api.reqMarketDataType(3); // Use delayed data (free for paper)
				clearTimeout(timeout);
				this.logger.info(`IBKR connected to ${this.host}:${this.port}`);
				resolve();
			});

			this.api.once(EventName.disconnected, () => {
				this.connected = false;
				this.connectPromise = null;
			});

			this.api.connect();
		});

		return this.connectPromise;
	}

	disconnect(): void {
		if (this.connected) {
			this.api.disconnect();
			this.connected = false;
			this.connectPromise = null;
		}
	}

	// ── Account ──

	async getAccountSummary(): Promise<Record<string, string>> {
		await this.ensureConnected();
		return new Promise((resolve, reject) => {
			const reqId = this.nextReqId();
			const result: Record<string, string> = {};
			const timeout = setTimeout(() => {
				this.api.cancelAccountSummary(reqId);
				reject(new Error("Account summary timeout"));
			}, 10_000);

			this.api.on(EventName.accountSummary, (id: number, account: string, tag: string, value: string, currency: string) => {
				if (id === reqId) {
					result[tag] = value;
					result[`${tag}_currency`] = currency;
					result.account = account;
				}
			});

			this.api.once(EventName.accountSummaryEnd, () => {
				clearTimeout(timeout);
				this.api.cancelAccountSummary(reqId);
				resolve(result);
			});

			this.api.reqAccountSummary(
				reqId, "All",
				"NetLiquidation,TotalCashValue,BuyingPower,UnrealizedPnL,RealizedPnL",
			);
		});
	}

	// ── Positions ──

	async getPositions(): Promise<IBKRPosition[]> {
		await this.ensureConnected();
		return new Promise((resolve, reject) => {
			const positions: IBKRPosition[] = [];
			const timeout = setTimeout(() => {
				this.api.cancelPositions();
				reject(new Error("Positions request timeout"));
			}, 10_000);

			const onPosition = (account: string, contract: Contract, pos: number, avgCost: number | undefined) => {
				if (pos !== 0) {
					positions.push({
						symbol: contract.symbol ?? "",
						conid: contract.conId ?? 0,
						quantity: pos,
						avgCost: avgCost ?? 0,
						account,
						secType: contract.secType ?? "",
						currency: contract.currency ?? "",
					});
				}
			};

			const onEnd = () => {
				clearTimeout(timeout);
				this.api.cancelPositions();
				this.api.removeListener(EventName.position, onPosition);
				resolve(positions);
			};

			this.api.on(EventName.position, onPosition);
			this.api.once(EventName.positionEnd, onEnd);
			this.api.reqPositions();
		});
	}

	// ── Market Data (Snapshot) ──

	async getSnapshot(symbol: string, currency = "USD"): Promise<Record<string, number>> {
		await this.ensureConnected();
		const contract: Contract = {
			symbol,
			secType: SecType.STK,
			exchange: "SMART",
			currency,
		};

		return new Promise((resolve, reject) => {
			const reqId = this.nextReqId();
			const prices: Record<string, number> = {};
			const timeout = setTimeout(() => {
				this.api.cancelMktData(reqId);
				resolve(prices); // Return whatever we have
			}, 8_000);

			const tickNames: Record<number, string> = {
				1: "bid", 2: "ask", 4: "last", 6: "high", 7: "low", 9: "close", 14: "open",
				66: "bid", 67: "ask", 68: "last", 72: "high", 73: "low", 75: "close", 76: "open",
			};

			const onTick = (id: number, tickType: number, price: number) => {
				if (id === reqId && tickNames[tickType] && price > 0) {
					prices[tickNames[tickType]] = price;
				}
			};

			const onEnd = (id: number) => {
				if (id === reqId) {
					clearTimeout(timeout);
					this.api.cancelMktData(reqId);
					this.api.removeListener(EventName.tickPrice, onTick);
					this.api.removeListener(EventName.tickSnapshotEnd, onEnd);
					resolve(prices);
				}
			};

			this.api.on(EventName.tickPrice, onTick);
			this.api.on(EventName.tickSnapshotEnd, onEnd);
			this.api.reqMktData(reqId, contract, "", true, false);
		});
	}

	// ── Historical Data ──

	/**
	 * Get historical OHLCV bars.
	 * @param durationStr - e.g. "1 Y", "6 M", "30 D", "1 W"
	 * @param barSize - e.g. "1 day", "1 hour", "5 mins"
	 */
	async getHistoricalBars(
		symbol: string,
		durationStr = "1 Y",
		barSize: BarSizeSetting = BarSizeSetting.DAYS_ONE,
		currency = "USD",
	): Promise<{
		symbol: string;
		bars: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }>;
		source: string;
	}> {
		await this.ensureConnected();
		const contract: Contract = {
			symbol,
			secType: SecType.STK,
			exchange: "SMART",
			currency,
		};

		return new Promise((resolve, reject) => {
			const reqId = this.nextReqId();
			const bars: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }> = [];
			const timeout = setTimeout(() => {
				reject(new Error(`Historical data timeout for ${symbol}`));
			}, 30_000);

			const onBar = (id: number, time: string, open: number, high: number, low: number, close: number, volume: number) => {
				if (id !== reqId) return;
				// TWS signals end of data with time starting with "finished"
				if (time.startsWith("finished")) {
					clearTimeout(timeout);
					this.api.removeListener(EventName.historicalData, onBar);
					resolve({ symbol, bars, source: "ibkr" });
					return;
				}
				bars.push({ time, open, high, low, close, volume });
			};

			this.api.on(EventName.historicalData, onBar);
			this.api.reqHistoricalData(
				reqId, contract, "", durationStr, barSize,
				WhatToShow.TRADES, 1, 1, false,
			);
		});
	}

	// ── Orders ──

	async placeOrder(params: {
		symbol: string;
		side: "BUY" | "SELL";
		quantity: number;
		orderType: "MKT" | "LMT";
		limitPrice?: number;
		strategyId?: string;
		currency?: string;
	}): Promise<IBKROrderResult> {
		await this.ensureConnected();

		const contract: Contract = {
			symbol: params.symbol,
			secType: SecType.STK,
			exchange: "SMART",
			currency: params.currency ?? "USD",
		};

		const order: Order = {
			action: params.side as OrderAction,
			orderType: params.orderType as OrderType,
			totalQuantity: params.quantity,
			tif: TimeInForce.DAY,
		};

		if (params.orderType === "LMT" && params.limitPrice != null) {
			order.lmtPrice = params.limitPrice;
		}
		if (params.strategyId) {
			order.orderRef = params.strategyId;
		}

		const orderId = this.nextOrderId++;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`Order timeout for ${params.symbol}`));
			}, 15_000);

			const onStatus = (
				id: number, status: string, filled: number, remaining: number,
				avgFillPrice: number,
			) => {
				if (id === orderId) {
					clearTimeout(timeout);
					this.api.removeListener(EventName.orderStatus, onStatus);
					resolve({
						orderId: id,
						status,
						filled,
						remaining,
						avgFillPrice,
						symbol: params.symbol,
					});
				}
			};

			this.api.on(EventName.orderStatus, onStatus);
			this.api.placeOrder(orderId, contract, order);
		});
	}

	async cancelOrder(orderId: number): Promise<void> {
		await this.ensureConnected();
		this.api.cancelOrder(orderId);
	}

	async getOpenOrders(): Promise<Array<{
		orderId: number;
		symbol: string;
		side: string;
		orderType: string;
		totalQty: number;
		status: string;
		filled: number;
		remaining: number;
		avgFillPrice: number;
	}>> {
		await this.ensureConnected();
		return new Promise((resolve) => {
			const orders: Array<{
				orderId: number; symbol: string; side: string; orderType: string;
				totalQty: number; status: string; filled: number; remaining: number; avgFillPrice: number;
			}> = [];

			const orderMap = new Map<number, { symbol: string; side: string; orderType: string; totalQty: number }>();
			const timeout = setTimeout(() => {
				resolve(orders);
			}, 10_000);

			const onOpen = (orderId: number, contract: Contract, order: Order) => {
				orderMap.set(orderId, {
					symbol: contract.symbol ?? "",
					side: order.action ?? "",
					orderType: order.orderType ?? "",
					totalQty: typeof order.totalQuantity === "number" ? order.totalQuantity : 0,
				});
			};

			const onStatus = (
				orderId: number, status: string, filled: number, remaining: number,
				avgFillPrice: number,
			) => {
				const info = orderMap.get(orderId);
				if (info) {
					orders.push({ orderId, ...info, status, filled, remaining, avgFillPrice });
				}
			};

			const onEnd = () => {
				clearTimeout(timeout);
				this.api.removeListener(EventName.openOrder, onOpen);
				this.api.removeListener(EventName.orderStatus, onStatus);
				resolve(orders);
			};

			this.api.on(EventName.openOrder, onOpen);
			this.api.on(EventName.orderStatus, onStatus);
			this.api.once(EventName.openOrderEnd, onEnd);
			this.api.reqAllOpenOrders();
		});
	}

	// ── Helpers ──

	private _reqIdCounter = 1000;
	private nextReqId(): number {
		return this._reqIdCounter++;
	}
}

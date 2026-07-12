/**
 * IBKR TWS API client via IB Gateway socket connection.
 * Uses @stoqey/ib to communicate over the TWS protocol.
 *
 * Connects to IB Gateway (e.g. heshiming/ibga Docker container)
 * on the configured host:port (default localhost:4000).
 */
import { IBApi, EventName, Contract, Order, OrderAction, OrderType, TimeInForce, SecType, BarSizeSetting, WhatToShow, Execution, CommissionReport } from "@stoqey/ib";

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

export type IBKRExecution = {
	execId: string;
	orderId: number;
	time: string;
	symbol: string;
	secType: string;
	/** BOT (bought) or SLD (sold). */
	side: string;
	shares: number;
	price: number;
	cumQty: number;
	avgPrice: number;
	exchange: string;
	currency: string;
	/** Options only: P or C. */
	right: string;
	/** Options only: strike price. */
	strike: number;
	/** Options/futures expiry (YYYYMMDD). */
	expiry: string;
	account: string;
	orderRef: string;
	commission: number | null;
	realizedPnl: number | null;
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
		// IBKR routes each TWS API connection by clientId; two clients sharing
		// the same id evict each other ("remove Client N" in IB Gateway logs).
		// Default to a random id in [100, 999] so callers that omit it don't
		// collide with the plugin's own connection or with each other.
		private clientId = Math.floor(Math.random() * 900) + 100,
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
			let settled = false;

			const onSummary = (id: number, account: string, tag: string, value: string, currency: string) => {
				if (id !== reqId) return;
				result[tag] = value;
				result[`${tag}_currency`] = currency;
				result.account = account;
			};
			const onEnd = (id: number) => {
				if (id !== reqId) return;
				done(() => resolve(result));
			};
			const done = (action: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				this.api.removeListener(EventName.accountSummary, onSummary);
				this.api.removeListener(EventName.accountSummaryEnd, onEnd);
				try { this.api.cancelAccountSummary(reqId); } catch { /* ignore */ }
				action();
			};
			const timeout = setTimeout(
				() => done(() => reject(new Error("Account summary timeout"))),
				10_000,
			);

			this.api.on(EventName.accountSummary, onSummary);
			this.api.on(EventName.accountSummaryEnd, onEnd);
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
			let settled = false;

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
			const onEnd = () => done(() => resolve(positions));
			const done = (action: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				this.api.removeListener(EventName.position, onPosition);
				this.api.removeListener(EventName.positionEnd, onEnd);
				try { this.api.cancelPositions(); } catch { /* ignore */ }
				action();
			};
			const timeout = setTimeout(
				() => done(() => reject(new Error("Positions request timeout"))),
				10_000,
			);

			this.api.on(EventName.position, onPosition);
			this.api.on(EventName.positionEnd, onEnd);
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

		return new Promise((resolve) => {
			const reqId = this.nextReqId();
			const prices: Record<string, number> = {};
			let settled = false;
			const tickNames: Record<number, string> = {
				1: "bid", 2: "ask", 4: "last", 6: "high", 7: "low", 9: "close", 14: "open",
				66: "bid", 67: "ask", 68: "last", 72: "high", 73: "low", 75: "close", 76: "open",
			};

			const onTick = (id: number, tickType: number, price: number) => {
				if (id !== reqId) return;
				if (tickNames[tickType] && price > 0) prices[tickNames[tickType]] = price;
			};
			const onEnd = (id: number) => {
				if (id !== reqId) return;
				done();
			};
			const done = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				this.api.removeListener(EventName.tickPrice, onTick);
				this.api.removeListener(EventName.tickSnapshotEnd, onEnd);
				try { this.api.cancelMktData(reqId); } catch { /* ignore */ }
				resolve(prices); // Return whatever we have (snapshot intentionally never rejects)
			};
			const timeout = setTimeout(done, 8_000);

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
			let settled = false;

			const onBar = (id: number, time: string, open: number, high: number, low: number, close: number, volume: number) => {
				if (id !== reqId) return;
				// TWS signals end of data with time starting with "finished"
				if (time.startsWith("finished")) {
					done(() => resolve({ symbol, bars, source: "ibkr" }));
					return;
				}
				bars.push({ time, open, high, low, close, volume });
			};
			const done = (action: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				this.api.removeListener(EventName.historicalData, onBar);
				try { this.api.cancelHistoricalData(reqId); } catch { /* ignore */ }
				action();
			};
			const timeout = setTimeout(
				() => done(() => reject(new Error(`Historical data timeout for ${symbol}`))),
				30_000,
			);

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
			let settled = false;

			const onStatus = (
				id: number, status: string, filled: number, remaining: number,
				avgFillPrice: number,
			) => {
				if (id !== orderId) return;
				done(() => resolve({
					orderId: id,
					status,
					filled,
					remaining,
					avgFillPrice,
					symbol: params.symbol,
				}));
			};
			const done = (action: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				this.api.removeListener(EventName.orderStatus, onStatus);
				action();
			};
			const timeout = setTimeout(
				() => done(() => reject(new Error(`Order timeout for ${params.symbol}`))),
				15_000,
			);

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
			let settled = false;

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
			const onEnd = () => done();
			const done = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				this.api.removeListener(EventName.openOrder, onOpen);
				this.api.removeListener(EventName.orderStatus, onStatus);
				this.api.removeListener(EventName.openOrderEnd, onEnd);
				resolve(orders);
			};
			const timeout = setTimeout(done, 10_000);

			this.api.on(EventName.openOrder, onOpen);
			this.api.on(EventName.orderStatus, onStatus);
			this.api.on(EventName.openOrderEnd, onEnd);
			this.api.reqAllOpenOrders();
		});
	}

	// ── Executions (recent fills) ──

	/**
	 * Get recent executions (fills) for the account.
	 *
	 * IMPORTANT: the TWS API only serves executions for the current trading day
	 * plus a short rolling window (~7 days). It is not a full history feed — use
	 * the Flex Web Service (FlexClient) for lifetime trade history.
	 *
	 * Commission and realized PnL arrive on a separate commissionReport event,
	 * matched back to each execution by execId.
	 */
	async getExecutions(): Promise<IBKRExecution[]> {
		await this.ensureConnected();
		return new Promise((resolve) => {
			const reqId = this.nextReqId();
			const byExecId = new Map<string, IBKRExecution>();
			const commissions = new Map<string, { commission: number | null; realizedPnl: number | null }>();
			let settled = false;

			const onExec = (id: number, contract: Contract, execution: Execution) => {
				if (id !== reqId) return;
				const execId = execution.execId ?? "";
				byExecId.set(execId, {
					execId,
					orderId: execution.orderId ?? 0,
					time: execution.time ?? "",
					symbol: contract.symbol ?? "",
					secType: contract.secType ?? "",
					side: execution.side ?? "",
					shares: execution.shares ?? 0,
					price: execution.price ?? 0,
					cumQty: execution.cumQty ?? 0,
					avgPrice: execution.avgPrice ?? 0,
					exchange: execution.exchange ?? "",
					currency: contract.currency ?? "",
					right: contract.right ?? "",
					strike: contract.strike ?? 0,
					expiry: contract.lastTradeDateOrContractMonth ?? "",
					account: execution.acctNumber ?? "",
					orderRef: execution.orderRef ?? "",
					commission: null,
					realizedPnl: null,
				});
			};
			const onCommission = (report: CommissionReport) => {
				const execId = report.execId ?? "";
				const existing = byExecId.get(execId);
				const entry = {
					commission: report.commission ?? null,
					realizedPnl: report.realizedPNL ?? null,
				};
				// commissionReport may arrive before or after its execDetails.
				if (existing) {
					existing.commission = entry.commission;
					existing.realizedPnl = entry.realizedPnl;
				} else {
					commissions.set(execId, entry);
				}
			};
			let graceTimer: ReturnType<typeof setTimeout> | null = null;
			const onEnd = (id: number) => {
				if (id !== reqId) return;
				// commissionReport events trail execDetailsEnd, so wait a short
				// grace window for them before resolving.
				graceTimer = setTimeout(done, 1_500);
			};
			const done = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (graceTimer) clearTimeout(graceTimer);
				this.api.removeListener(EventName.execDetails, onExec);
				this.api.removeListener(EventName.execDetailsEnd, onEnd);
				this.api.removeListener(EventName.commissionReport, onCommission);
				// Apply any commission reports that arrived before their execution.
				for (const [execId, entry] of commissions) {
					const exec = byExecId.get(execId);
					if (exec) {
						exec.commission = entry.commission;
						exec.realizedPnl = entry.realizedPnl;
					}
				}
				resolve([...byExecId.values()]);
			};
			// Commission reports can lag the execDetailsEnd marker, so give them a
			// short grace window rather than resolving the instant the end fires.
			const timeout = setTimeout(done, 10_000);

			this.api.on(EventName.execDetails, onExec);
			this.api.on(EventName.execDetailsEnd, onEnd);
			this.api.on(EventName.commissionReport, onCommission);
			this.api.reqExecutions(reqId, {});
		});
	}

	// ── Helpers ──

	private _reqIdCounter = 1000;
	private nextReqId(): number {
		return this._reqIdCounter++;
	}
}

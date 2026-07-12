import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";
import { jsonResult } from "./result.js";

export function registerIbkrTradingTools(api: OpenClawPluginApi, ctx: PluginContext) {
	const { ibkr, flex } = ctx;

	// ── ibkr_submit_order ──
	api.registerTool(
		{
			name: "ibkr_submit_order",
			label: "Submit Order (IBKR)",
			description:
				"Submit a paper trading order via Interactive Brokers. " +
				"Supports global equities with market or limit type.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Ticker symbol" },
					side: { type: "string", enum: ["buy", "sell"], description: "Order side" },
					quantity: { type: "number", description: "Number of shares/contracts" },
					order_type: { type: "string", enum: ["market", "limit"], description: "Order type" },
					limit_price: { type: "number", description: "Limit price (required for limit orders)" },
					strategy_id: { type: "string", description: "Associated strategy ID" },
					currency: { type: "string", description: "Currency (default: USD)" },
				},
				required: ["symbol", "side", "quantity", "order_type", "strategy_id"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const result = await ibkr.placeOrder({
					symbol: (params.symbol as string).toUpperCase(),
					side: (params.side as string).toUpperCase() as "BUY" | "SELL",
					quantity: params.quantity as number,
					orderType: (params.order_type as string) === "limit" ? "LMT" : "MKT",
					limitPrice: params.limit_price as number | undefined,
					strategyId: params.strategy_id as string,
					currency: (params.currency as string) ?? "USD",
				});
				return jsonResult(result);
			},
		},
		{ optional: true },
	);

	// ── ibkr_cancel_order ──
	api.registerTool(
		{
			name: "ibkr_cancel_order",
			label: "Cancel Order (IBKR)",
			description: "Cancel a pending paper trading order on IBKR by order ID.",
			parameters: {
				type: "object",
				properties: {
					order_id: { type: "number", description: "IBKR order ID to cancel" },
				},
				required: ["order_id"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				await ibkr.cancelOrder(params.order_id as number);
				return jsonResult({ cancelled: true, order_id: params.order_id });
			},
		},
		{ optional: true },
	);

	// ── ibkr_get_positions ──
	api.registerTool(
		{
			name: "ibkr_get_positions",
			label: "Get Positions (IBKR)",
			description: "Get current paper trading positions from IBKR.",
			parameters: {
				type: "object",
				properties: {},
			},
			async execute() {
				const positions = await ibkr.getPositions();
				return jsonResult({
					positions: positions.map((p) => ({
						symbol: p.symbol,
						quantity: p.quantity,
						avg_cost: p.avgCost,
						currency: p.currency,
						sec_type: p.secType,
						account: p.account,
					})),
					count: positions.length,
				});
			},
		},
		{ optional: true },
	);

	// ── ibkr_get_pnl ──
	api.registerTool(
		{
			name: "ibkr_get_pnl",
			label: "Get PnL (IBKR)",
			description:
				"Get paper trading account summary from IBKR. " +
				"Returns net liquidation value, unrealized/realized PnL, cash balance, and buying power.",
			parameters: {
				type: "object",
				properties: {},
			},
			async execute() {
				const summary = await ibkr.getAccountSummary();
				return jsonResult({
					account: summary.account,
					net_liquidation: parseFloat(summary.NetLiquidation ?? "0"),
					total_cash: parseFloat(summary.TotalCashValue ?? "0"),
					buying_power: parseFloat(summary.BuyingPower ?? "0"),
					unrealized_pnl: parseFloat(summary.UnrealizedPnL ?? "0"),
					realized_pnl: parseFloat(summary.RealizedPnL ?? "0"),
					currency: summary.NetLiquidation_currency ?? "USD",
					source: "ibkr_paper",
				});
			},
		},
		{ optional: true },
	);

	// ── ibkr_get_order_history ──
	api.registerTool(
		{
			name: "ibkr_get_order_history",
			label: "Get Orders (IBKR)",
			description: "Get all open/recent orders on IBKR paper trading account.",
			parameters: {
				type: "object",
				properties: {},
			},
			async execute() {
				const orders = await ibkr.getOpenOrders();
				return jsonResult({
					orders: orders.map((o) => ({
						order_id: o.orderId,
						symbol: o.symbol,
						side: o.side,
						order_type: o.orderType,
						total_qty: o.totalQty,
						filled: o.filled,
						remaining: o.remaining,
						avg_price: o.avgFillPrice,
						status: o.status,
					})),
					count: orders.length,
				});
			},
		},
		{ optional: true },
	);

	// ── ibkr_get_recent_executions ──
	api.registerTool(
		{
			name: "ibkr_get_recent_executions",
			label: "Get Recent Fills (IBKR)",
			description:
				"Get recent executions (fills) from IBKR via the TWS socket. " +
				"Covers the current trading day plus a short rolling window (~7 days only). " +
				"For full lifetime trade history use ibkr_get_trade_history (Flex Web Service).",
			parameters: {
				type: "object",
				properties: {},
			},
			async execute() {
				const executions = await ibkr.getExecutions();
				return jsonResult({
					executions: executions.map((e) => ({
						exec_id: e.execId,
						order_id: e.orderId,
						time: e.time,
						symbol: e.symbol,
						sec_type: e.secType,
						side: e.side, // BOT / SLD
						shares: e.shares,
						price: e.price,
						cum_qty: e.cumQty,
						avg_price: e.avgPrice,
						exchange: e.exchange,
						currency: e.currency,
						right: e.right,
						strike: e.strike,
						expiry: e.expiry,
						account: e.account,
						order_ref: e.orderRef,
						commission: e.commission,
						realized_pnl: e.realizedPnl,
					})),
					count: executions.length,
					note: "TWS socket only returns ~7 days of executions; use ibkr_get_trade_history for full history.",
				});
			},
		},
		{ optional: true },
	);

	// ── ibkr_get_trade_history ──
	api.registerTool(
		{
			name: "ibkr_get_trade_history",
			label: "Get Full Trade History (IBKR Flex)",
			description:
				"Get full lifetime trade history from IBKR via the Flex Web Service (HTTPS, " +
				"no gateway needed). Returns symbol, side, quantity, price, date, asset type, " +
				"option strike/put-call/expiry, commissions, and realized PnL. Requires a Flex " +
				"token and query id configured in IBKR Client Portal (see ibkr-setup skill).",
			parameters: {
				type: "object",
				properties: {
					query_id: {
						type: "string",
						description:
							"Flex Query id to run. Defaults to the configured IBKR_FLEX_QUERY_ID.",
					},
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const queryId = (params.query_id as string | undefined) ?? ctx.config.ibkrFlexQueryId ?? "";
				if (!ctx.config.ibkrFlexToken) {
					return jsonResult({
						error:
							"Flex Web Service not configured. Set IBKR_FLEX_TOKEN (and IBKR_FLEX_QUERY_ID). " +
							"See the ibkr-setup skill for the Client Portal walkthrough.",
					});
				}
				if (!queryId) {
					return jsonResult({
						error: "No Flex query id. Set IBKR_FLEX_QUERY_ID or pass query_id.",
					});
				}
				const trades = await flex.getTrades(queryId);
				return jsonResult({ trades, count: trades.length, source: "ibkr-flex" });
			},
		},
		{ optional: true },
	);

	// ── ibkr_reconnect ──
	api.registerTool(
		{
			name: "ibkr_reconnect",
			label: "Reconnect IBKR Gateway",
			description:
				"Force-reconnect the IBKR TWS socket. Use after a session eviction " +
				"(e.g. you logged into TWS desktop on the paper account, which kicked " +
				"the docker gateway). Call this once the gateway is back up to refresh " +
				"the plugin's socket without restarting OpenClaw.",
			parameters: {
				type: "object",
				properties: {},
			},
			async execute() {
				ibkr.disconnect();
				await ibkr.ensureConnected();
				const summary = await ibkr.getAccountSummary();
				return jsonResult({
					reconnected: true,
					account: summary.account,
					net_liquidation: parseFloat(summary.NetLiquidation ?? "0"),
				});
			},
		},
		{ optional: true },
	);

	// ── ibkr_get_quote ──
	api.registerTool(
		{
			name: "ibkr_get_quote",
			label: "Get Quote via IBKR",
			description:
				"Get current market snapshot for a symbol via IBKR (delayed data). " +
				"Supports global symbols across all IBKR-connected exchanges.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Ticker symbol" },
					currency: { type: "string", description: "Currency (default: USD)" },
				},
				required: ["symbol"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbol = (params.symbol as string).toUpperCase();
				const data = await ibkr.getSnapshot(symbol, (params.currency as string) ?? "USD");
				return jsonResult({
					symbol,
					...data,
					source: "ibkr",
				});
			},
		},
		{ optional: true },
	);
}

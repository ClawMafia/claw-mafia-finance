import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";
import { IBKRClient } from "../data/ibkr-client.js";
import { jsonResult } from "./result.js";

export function registerPaperTradingTools(api: OpenClawPluginApi, ctx: PluginContext) {
	const ibkr = new IBKRClient(
		ctx.config.ibkrHost ?? "localhost",
		ctx.config.ibkrPort ?? 4000,
		ctx.logger,
	);

	// ── paper_submit_order ──
	api.registerTool(
		{
			name: "paper_submit_order",
			label: "Submit Paper Order (IBKR)",
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

	// ── paper_cancel_order ──
	api.registerTool(
		{
			name: "paper_cancel_order",
			label: "Cancel Paper Order (IBKR)",
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

	// ── paper_get_positions ──
	api.registerTool(
		{
			name: "paper_get_positions",
			label: "Get Paper Positions (IBKR)",
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

	// ── paper_get_pnl ──
	api.registerTool(
		{
			name: "paper_get_pnl",
			label: "Get Paper PnL (IBKR)",
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

	// ── paper_get_order_history ──
	api.registerTool(
		{
			name: "paper_get_order_history",
			label: "Get Paper Orders (IBKR)",
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

	// ── paper_get_quote ──
	api.registerTool(
		{
			name: "paper_get_quote",
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

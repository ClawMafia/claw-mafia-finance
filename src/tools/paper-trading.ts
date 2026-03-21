import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";
import { AlpacaClient } from "../data/alpaca-client.js";
import { jsonResult } from "./result.js";

export function registerPaperTradingTools(api: OpenClawPluginApi, ctx: PluginContext) {
	const alpaca = new AlpacaClient(
		ctx.config.alpacaApiKey,
		ctx.config.alpacaApiSecret,
		ctx.logger,
		ctx.dataDir,
		ctx.config.alpacaBaseUrl,
	);

	// ── paper_submit_order ──
	api.registerTool(
		{
			name: "paper_submit_order",
			label: "Submit Paper Order",
			description:
				"Submit a paper trading order via Alpaca. Only for approved strategies. " +
				"Supports stock orders with market or limit type. Options are not supported on Alpaca free tier.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Ticker symbol (stocks only)" },
					side: { type: "string", enum: ["buy", "sell"], description: "Order side" },
					quantity: { type: "number", description: "Number of shares" },
					order_type: { type: "string", enum: ["market", "limit"], description: "Order type" },
					limit_price: { type: "number", description: "Limit price (required for limit orders)" },
					strategy_id: { type: "string", description: "Associated strategy ID" },
				},
				required: ["symbol", "side", "quantity", "order_type", "strategy_id"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				return jsonResult(await alpaca.submitOrder({
					symbol: (params.symbol as string).toUpperCase(),
					side: params.side as "buy" | "sell",
					quantity: params.quantity as number,
					order_type: params.order_type as "market" | "limit",
					limit_price: params.limit_price as number | undefined,
					strategy_id: params.strategy_id as string,
				}));
			},
		},
		{ optional: true },
	);

	// ── paper_cancel_order ──
	api.registerTool(
		{
			name: "paper_cancel_order",
			label: "Cancel Paper Order",
			description: "Cancel a pending paper trading order via Alpaca.",
			parameters: {
				type: "object",
				properties: {
					order_id: { type: "string", description: "Alpaca order ID to cancel" },
				},
				required: ["order_id"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				return jsonResult(await alpaca.cancelOrder(params.order_id as string));
			},
		},
		{ optional: true },
	);

	// ── paper_get_positions ──
	api.registerTool(
		{
			name: "paper_get_positions",
			label: "Get Paper Positions",
			description: "Get current paper trading positions from Alpaca. Optionally filter by strategy (approximate — see note in response).",
			parameters: {
				type: "object",
				properties: {
					strategy_id: { type: "string", description: "Filter by strategy ID. Omit for all." },
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				return jsonResult(await alpaca.getPositions(params.strategy_id as string | undefined));
			},
		},
		{ optional: true },
	);

	// ── paper_get_pnl ──
	api.registerTool(
		{
			name: "paper_get_pnl",
			label: "Get Paper PnL",
			description:
				"Get paper trading PnL from Alpaca portfolio history. " +
				"Returns portfolio-level PnL. Per-strategy breakdown not natively supported by Alpaca.",
			parameters: {
				type: "object",
				properties: {
					period: { type: "string", description: "'today', 'mtd', 'ytd', 'inception'. Default: 'today'." },
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				return jsonResult(await alpaca.getPnL((params.period as string) ?? "today"));
			},
		},
		{ optional: true },
	);

	// ── paper_roll_position ──
	api.registerTool(
		{
			name: "paper_roll_position",
			label: "Roll Paper Position",
			description:
				"Roll an options position to a new expiration. " +
				"NOTE: Options are not supported on Alpaca free tier. Returns unavailable notice.",
			parameters: {
				type: "object",
				properties: {
					position_id: { type: "string", description: "Position to roll" },
					new_expiry: { type: "string", description: "New expiration date (YYYY-MM-DD)" },
					new_strike: { type: "number", description: "New strike price (optional)" },
				},
				required: ["position_id", "new_expiry"],
			},
			async execute(_toolCallId: string, _params: Record<string, unknown>) {
				return jsonResult({
					available: false,
					message: "Options rolling is not supported on the Alpaca free tier. This tool will be enabled when options support is added.",
				});
			},
		},
		{ optional: true },
	);

	// ── paper_get_order_history ──
	api.registerTool(
		{
			name: "paper_get_order_history",
			label: "Get Paper Order History",
			description: "Get paper trading order history from Alpaca. Optionally filter by strategy ID or date range.",
			parameters: {
				type: "object",
				properties: {
					strategy_id: { type: "string", description: "Filter by strategy ID" },
					start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
					end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				return jsonResult(await alpaca.getOrders({
					strategy_id: params.strategy_id as string | undefined,
					start_date: params.start_date as string | undefined,
					end_date: params.end_date as string | undefined,
				}));
			},
		},
		{ optional: true },
	);
}

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";

export function registerPaperTradingTools(api: OpenClawPluginApi, ctx: PluginContext) {
	// ── paper_submit_order ──
	api.registerTool(
		{
			name: "paper_submit_order",
			description:
				"Submit a paper trading order. Only for approved strategies. " +
				"Supports stock and options orders with market or limit type.",
			parameters: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Ticker or OCC option symbol" },
					asset_type: { type: "string", enum: ["stock", "option"], description: "Asset type" },
					side: { type: "string", enum: ["buy", "sell"], description: "Order side" },
					quantity: { type: "number", description: "Number of shares or contracts" },
					order_type: { type: "string", enum: ["market", "limit"], description: "Order type" },
					limit_price: { type: "number", description: "Limit price (required for limit orders)" },
					strategy_id: { type: "string", description: "Associated strategy ID" },
				},
				required: ["symbol", "asset_type", "side", "quantity", "order_type", "strategy_id"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				// TODO Phase 3
				return { status: "not_implemented", message: "Paper trading is Phase 3." };
			},
		},
		{ optional: true },
	);

	// ── paper_cancel_order ──
	api.registerTool(
		{
			name: "paper_cancel_order",
			description: "Cancel a pending paper trading order.",
			parameters: {
				type: "object",
				properties: {
					order_id: { type: "string", description: "Order ID to cancel" },
				},
				required: ["order_id"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				// TODO Phase 3
				return { status: "not_implemented" };
			},
		},
		{ optional: true },
	);

	// ── paper_get_positions ──
	api.registerTool(
		{
			name: "paper_get_positions",
			description: "Get current paper trading positions, optionally filtered by strategy.",
			parameters: {
				type: "object",
				properties: {
					strategy_id: { type: "string", description: "Filter by strategy ID. Omit for all." },
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				// TODO Phase 3
				return { status: "not_implemented", positions: [] };
			},
		},
		{ optional: true },
	);

	// ── paper_get_pnl ──
	api.registerTool(
		{
			name: "paper_get_pnl",
			description: "Get paper trading PnL (realized + unrealized), optionally by strategy and period.",
			parameters: {
				type: "object",
				properties: {
					strategy_id: { type: "string", description: "Filter by strategy ID" },
					period: { type: "string", description: "'today', 'mtd', 'ytd', 'inception'. Default: 'today'." },
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				// TODO Phase 3
				return { status: "not_implemented" };
			},
		},
		{ optional: true },
	);

	// ── paper_roll_position ──
	api.registerTool(
		{
			name: "paper_roll_position",
			description: "Roll an expiring options position to a new expiration (and optionally new strike).",
			parameters: {
				type: "object",
				properties: {
					position_id: { type: "string", description: "Position to roll" },
					new_expiry: { type: "string", description: "New expiration date (YYYY-MM-DD)" },
					new_strike: { type: "number", description: "New strike price (optional, keeps same if omitted)" },
				},
				required: ["position_id", "new_expiry"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				// TODO Phase 3
				return { status: "not_implemented" };
			},
		},
		{ optional: true },
	);

	// ── paper_get_order_history ──
	api.registerTool(
		{
			name: "paper_get_order_history",
			description: "Get paper trading order history log.",
			parameters: {
				type: "object",
				properties: {
					strategy_id: { type: "string", description: "Filter by strategy ID" },
					start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
					end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				// TODO Phase 3
				return { status: "not_implemented", orders: [] };
			},
		},
		{ optional: true },
	);
}

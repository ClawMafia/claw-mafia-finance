import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";
import { flexTradeToRow } from "../data/flex-mapper.js";
import { jsonResult } from "./result.js";

export function registerReviewTools(api: OpenClawPluginApi, ctx: PluginContext) {
	const { flex } = ctx;

	// ── ibkr_record_fills ──
	// The reconcile / backstop path: pull authoritative fills from Flex, map them
	// to ledger rows, and upsert keyed by trade_id. Idempotent — re-running (agent
	// post-trade, cron sweep, or end-of-session batch) converges to the same rows.
	api.registerTool(
		{
			name: "ibkr_record_fills",
			label: "Record Fills into Ledger",
			description:
				"Reconcile broker fills into the ledger database. Pulls the full trade " +
				"history from the IBKR Flex Web Service, maps each fill to an equity/option " +
				"ledger row, and upserts keyed by broker trade_id (idempotent — safe to " +
				"re-run). Returns how many rows were inserted vs. already present.",
			parameters: {
				type: "object",
				properties: {
					query_id: {
						type: "string",
						description: "Flex Query id to run. Defaults to the configured IBKR_FLEX_QUERY_ID.",
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
					return jsonResult({ error: "No Flex query id. Set IBKR_FLEX_QUERY_ID or pass query_id." });
				}

				const trades = await flex.getTrades(queryId);
				const mapped = flexTradeToRow(trades, ctx.logger);

				let inserted = 0;
				let skipped = 0;
				for (const row of mapped.equity) {
					if (ctx.store.upsertEquityTrade(row).inserted) inserted++;
					else skipped++;
				}
				for (const row of mapped.option) {
					if (ctx.store.upsertOptionTrade(row).inserted) inserted++;
					else skipped++;
				}

				return jsonResult({
					inserted,
					skipped,
					total: mapped.equity.length + mapped.option.length,
					skipped_categories: mapped.skipped,
					source: "ibkr-flex",
				});
			},
		},
		{ optional: true },
	);

	// ── attach_reasoning ──
	// The one field the broker cannot re-supply: the agent writes the *why* onto
	// the trade row right after the fill exists, keyed by trade_id.
	api.registerTool(
		{
			name: "attach_reasoning",
			label: "Attach Trade Reasoning",
			description:
				"Write the reasoning (the 'why') onto a recorded trade, keyed by its broker " +
				"trade_id. Editable in place. Reasoning is the only irreplaceable field — the " +
				"numbers re-pull from Flex, the rationale cannot. Reconcile the fill first " +
				"(ibkr_record_fills) so the row exists.",
			parameters: {
				type: "object",
				properties: {
					trade_id: { type: "string", description: "Broker trade_id of the fill to annotate." },
					reasoning: { type: "string", description: "The rationale: context, thesis, trade-offs." },
				},
				required: ["trade_id", "reasoning"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const tradeId = params.trade_id as string;
				const reasoning = params.reasoning as string;
				const updated = ctx.store.setReasoning(tradeId, reasoning);
				if (updated === 0) {
					return jsonResult({
						updated: 0,
						trade_id: tradeId,
						note: "No ledger row with that trade_id. Reconcile fills first (ibkr_record_fills), then retry.",
					});
				}
				return jsonResult({ updated, trade_id: tradeId });
			},
		},
		{ optional: true },
	);

	// ── ibkr_get_positions_book ──
	// The derived Entity-4 view: positions recomputed from the ledgers + latest
	// marks, scoped per account.
	api.registerTool(
		{
			name: "ibkr_get_positions_book",
			label: "Get Positions Book (Ledger)",
			description:
				"Read the derived positions view from the ledger database: per (account, " +
				"symbol) position, book value, avg cost, mark-to-market, premium, carry, and " +
				"total return. Recomputed from the equity/option/cashflow ledgers + latest marks.",
			parameters: {
				type: "object",
				properties: {
					account_id: { type: "string", description: "Filter to one IBKR account. Default: all accounts." },
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const accountId = params.account_id as string | undefined;
				const positions = ctx.store.getPositions(accountId);
				return jsonResult({ positions, count: positions.length, source: "ledger" });
			},
		},
		{ optional: true },
	);

	// ── ibkr_refresh_marks ──
	// Populate market_prices from live quotes so the positions view yields
	// current_price / mark_to_market / total_return. Best-effort: symbols that
	// return no quote (e.g. market closed, unsupported venue) are reported as
	// missed rather than failing the whole call.
	api.registerTool(
		{
			name: "ibkr_refresh_marks",
			label: "Refresh Ledger Marks",
			description:
				"Fetch current quotes for the symbols held in the ledger and update the " +
				"market_prices table, so the positions book shows live mark-to-market and " +
				"total return. Defaults to every symbol in the ledger.",
			parameters: {
				type: "object",
				properties: {
					symbols: {
						type: "array",
						items: { type: "string" },
						description: "Optional subset of symbols. Default: all ledger symbols.",
					},
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const requested = params.symbols as string[] | undefined;
				const targets = requested?.length
					? requested.map((symbol) => ({ symbol, currency: null as string | null }))
					: ctx.store.getSymbols();
				const asof = new Date().toISOString();
				const updated: Array<{ symbol: string; price: number }> = [];
				const missed: string[] = [];

				for (const { symbol, currency } of targets) {
					try {
						const snap = await ctx.ibkr.getSnapshot(symbol, currency ?? "USD");
						const mid = snap.bid && snap.ask ? (snap.bid + snap.ask) / 2 : undefined;
						const price = snap.last ?? snap.close ?? mid ?? snap.open;
						if (typeof price === "number" && price > 0) {
							ctx.store.upsertMarketPrice(symbol, price, asof);
							updated.push({ symbol, price });
						} else {
							missed.push(symbol);
						}
					} catch {
						missed.push(symbol);
					}
				}

				return jsonResult({ updated, missed, count: updated.length, asof });
			},
		},
		{ optional: true },
	);

	// ── generate_daily_report ── (Phase 4 — still a stub, now store-backed)
	api.registerTool(
		{
			name: "generate_daily_report",
			label: "Generate Daily Report",
			description:
				"Generate daily review report with PnL attribution, position changes, " +
				"and thesis alignment for all active strategies.",
			parameters: {
				type: "object",
				properties: {
					date: { type: "string", description: "Report date (YYYY-MM-DD). Default: today." },
				},
			},
			async execute() {
				// TODO Phase 4: SQL aggregation over the ledger for the date.
				return jsonResult({ status: "not_implemented", message: "Daily reports are Phase 4." });
			},
		},
		{ optional: true },
	);

	// ── compare_thesis_vs_actual ── (Phase 4 — still a stub)
	api.registerTool(
		{
			name: "compare_thesis_vs_actual",
			label: "Compare Thesis vs Actual",
			description: "Compare the original strategy thesis/assumptions against realized outcomes.",
			parameters: {
				type: "object",
				properties: {
					strategy_id: { type: "string", description: "Strategy to review" },
				},
				required: ["strategy_id"],
			},
			async execute() {
				// TODO Phase 4: join strategy thesis to realized ledger rows.
				return jsonResult({ status: "not_implemented" });
			},
		},
		{ optional: true },
	);
}

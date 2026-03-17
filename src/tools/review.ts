import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";

export function registerReviewTools(api: OpenClawPluginApi, ctx: PluginContext) {
	// ── generate_daily_report ──
	api.registerTool(
		{
			name: "generate_daily_report",
			description:
				"Generate daily review report with PnL attribution, position changes, " +
				"and thesis alignment for all active strategies.",
			parameters: {
				type: "object",
				properties: {
					date: { type: "string", description: "Report date (YYYY-MM-DD). Default: today." },
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				// TODO Phase 4
				return { status: "not_implemented", message: "Daily reports are Phase 4." };
			},
		},
		{ optional: true },
	);

	// ── compare_thesis_vs_actual ──
	api.registerTool(
		{
			name: "compare_thesis_vs_actual",
			description: "Compare the original strategy thesis/assumptions against realized outcomes.",
			parameters: {
				type: "object",
				properties: {
					strategy_id: { type: "string", description: "Strategy to review" },
				},
				required: ["strategy_id"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				// TODO Phase 4
				return { status: "not_implemented" };
			},
		},
		{ optional: true },
	);

	// ── write_journal_entry ──
	api.registerTool(
		{
			name: "write_journal_entry",
			description: "Write a structured review/journal entry to the persistent journal store.",
			parameters: {
				type: "object",
				properties: {
					entry: { type: "string", description: "JSON string of the journal entry" },
				},
				required: ["entry"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				// TODO Phase 4
				return { status: "not_implemented" };
			},
		},
		{ optional: true },
	);

	// ── get_journal_entries ──
	api.registerTool(
		{
			name: "get_journal_entries",
			description: "Query past journal entries by date range or strategy.",
			parameters: {
				type: "object",
				properties: {
					start_date: { type: "string" },
					end_date: { type: "string" },
					strategy_id: { type: "string" },
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				// TODO Phase 4
				return { status: "not_implemented", entries: [] };
			},
		},
		{ optional: true },
	);
}

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/claw-mafia-finance";
import type { PluginContext } from "../types.js";
import { runPythonEngine } from "../engine-runner.js";

export function registerBacktestTools(api: OpenClawPluginApi, ctx: PluginContext) {
	// ── run_backtest ──
	api.registerTool(
		{
			name: "run_backtest",
			description:
				"Run a historical backtest for a strategy specification. " +
				"Executes asynchronously via Python engine. Returns a job_id to check results.",
			input_schema: {
				type: "object",
				properties: {
					strategy_spec: { type: "string", description: "JSON string of the strategy specification" },
					start_date: { type: "string", description: "Backtest start date (YYYY-MM-DD)" },
					end_date: { type: "string", description: "Backtest end date (YYYY-MM-DD). Default: today." },
					initial_capital: { type: "number", description: "Starting capital in USD. Default: 100000." },
					cost_model: {
						type: "string",
						description: "Transaction cost model: 'default' (0.65/contract + 5bps slippage) or 'zero'",
						enum: ["default", "zero"],
					},
				},
				required: ["strategy_spec", "start_date"],
			},
			async call(params: Record<string, unknown>) {
				// TODO Phase 2: implement via Python subprocess
				return {
					status: "not_implemented",
					message: "Backtest engine is Phase 2. Strategy spec received and validated.",
					strategy_spec: JSON.parse(params.strategy_spec as string),
				};
			},
		},
		{ optional: true },
	);

	// ── get_backtest_status ──
	api.registerTool(
		{
			name: "get_backtest_status",
			description: "Check the status of a running backtest job.",
			input_schema: {
				type: "object",
				properties: {
					job_id: { type: "string", description: "Backtest job ID returned by run_backtest" },
				},
				required: ["job_id"],
			},
			async call(params: Record<string, unknown>) {
				// TODO Phase 2
				return { status: "not_implemented", job_id: params.job_id };
			},
		},
		{ optional: true },
	);

	// ── get_backtest_results ──
	api.registerTool(
		{
			name: "get_backtest_results",
			description:
				"Fetch the full results of a completed backtest including metrics, " +
				"regime breakdown, stress results, and trade log.",
			input_schema: {
				type: "object",
				properties: {
					job_id: { type: "string", description: "Backtest job ID" },
				},
				required: ["job_id"],
			},
			async call(params: Record<string, unknown>) {
				// TODO Phase 2
				return { status: "not_implemented", job_id: params.job_id };
			},
		},
		{ optional: true },
	);

	// ── parameter_sweep ──
	api.registerTool(
		{
			name: "parameter_sweep",
			description:
				"Run multiple backtest parameter combinations to find robust configurations. " +
				"Varies specified parameters across a grid and returns comparative results.",
			input_schema: {
				type: "object",
				properties: {
					strategy_spec: { type: "string", description: "Base strategy specification JSON" },
					param_grid: {
						type: "string",
						description: "JSON of parameter grid, e.g. {\"dte_target\": [7, 14, 30], \"delta_target\": [0.1, 0.15, 0.2]}",
					},
					start_date: { type: "string" },
					end_date: { type: "string" },
				},
				required: ["strategy_spec", "param_grid", "start_date"],
			},
			async call(params: Record<string, unknown>) {
				// TODO Phase 2
				return { status: "not_implemented", message: "Parameter sweep is Phase 2." };
			},
		},
		{ optional: true },
	);

	// ── compare_backtests ──
	api.registerTool(
		{
			name: "compare_backtests",
			description: "Compare results of multiple backtests side by side.",
			input_schema: {
				type: "object",
				properties: {
					job_ids: {
						type: "array",
						items: { type: "string" },
						description: "List of backtest job IDs to compare",
					},
				},
				required: ["job_ids"],
			},
			async call(params: Record<string, unknown>) {
				// TODO Phase 2
				return { status: "not_implemented", job_ids: params.job_ids };
			},
		},
		{ optional: true },
	);
}

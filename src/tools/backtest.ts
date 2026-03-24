import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";
import { jsonResult } from "./result.js";

const BACKTEST_ENGINE_URL = process.env.BACKTEST_ENGINE_URL ?? "http://backtest-engine.railway.internal:8765";
const BACKTEST_SECRET = process.env.BACKTEST_SECRET ?? "";

function engineHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (BACKTEST_SECRET) {
		headers["Authorization"] = `Bearer ${BACKTEST_SECRET}`;
	}
	return headers;
}

async function enginePost(path: string, body: unknown): Promise<Response> {
	return fetch(`${BACKTEST_ENGINE_URL}${path}`, {
		method: "POST",
		headers: engineHeaders(),
		body: JSON.stringify(body),
	});
}

async function engineGet(path: string): Promise<Response> {
	return fetch(`${BACKTEST_ENGINE_URL}${path}`, {
		method: "GET",
		headers: engineHeaders(),
	});
}

export function registerBacktestTools(api: OpenClawPluginApi, ctx: PluginContext) {
	// ── run_backtest ──
	api.registerTool(
		{
			name: "run_backtest",
			label: "Run Backtest",
			description:
				"Run a historical backtest for a strategy specification. " +
				"Executes asynchronously via NautilusTrader engine. Returns a job_id to poll for results.",
			parameters: {
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
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				let spec: Record<string, unknown>;
				try {
					spec = JSON.parse(params.strategy_spec as string);
				} catch (e) {
					return jsonResult({ error: `Invalid strategy_spec JSON: ${(e as Error).message}` });
				}

				let resp: Response;
				try {
					resp = await enginePost("/backtest", {
						strategy_spec: spec,
						start_date: params.start_date,
						end_date: params.end_date,
						initial_capital: (params.initial_capital as number | undefined) ?? 100000,
						cost_model: (params.cost_model as string | undefined) ?? "default",
					});
				} catch (e) {
					return jsonResult({ error: `Failed to reach backtest engine: ${(e as Error).message}` });
				}

				if (!resp.ok) {
					return jsonResult({ error: `Backtest engine error ${resp.status}: ${await resp.text()}` });
				}

				return jsonResult(await resp.json());
			},
		},
		{ optional: true },
	);

	// ── get_backtest_status ──
	api.registerTool(
		{
			name: "get_backtest_status",
			label: "Get Backtest Status",
			description: "Check the status of a running backtest job.",
			parameters: {
				type: "object",
				properties: {
					job_id: { type: "string", description: "Backtest job ID returned by run_backtest" },
				},
				required: ["job_id"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				let resp: Response;
				try {
					resp = await engineGet(`/backtest/${params.job_id}`);
				} catch (e) {
					return jsonResult({ error: `Failed to reach backtest engine: ${(e as Error).message}` });
				}

				if (resp.status === 404) {
					return jsonResult({ error: `Job '${params.job_id}' not found.` });
				}
				if (!resp.ok) {
					return jsonResult({ error: `Engine error ${resp.status}: ${await resp.text()}` });
				}

				const job = await resp.json();
				return jsonResult({
					job_id: job.job_id,
					status: job.status,
					strategy_id: job.strategy_id,
					submitted_at: job.submitted_at,
					elapsed_sec: job.elapsed_sec,
					error: job.error,
				});
			},
		},
		{ optional: true },
	);

	// ── get_backtest_results ──
	api.registerTool(
		{
			name: "get_backtest_results",
			label: "Get Backtest Results",
			description:
				"Fetch the full results of a completed backtest including metrics, " +
				"regime breakdown, stress results, and trade log.",
			parameters: {
				type: "object",
				properties: {
					job_id: { type: "string", description: "Backtest job ID" },
				},
				required: ["job_id"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				let resp: Response;
				try {
					resp = await engineGet(`/backtest/${params.job_id}`);
				} catch (e) {
					return jsonResult({ error: `Failed to reach backtest engine: ${(e as Error).message}` });
				}

				if (resp.status === 404) {
					return jsonResult({ error: `Job '${params.job_id}' not found.` });
				}
				if (!resp.ok) {
					return jsonResult({ error: `Engine error ${resp.status}: ${await resp.text()}` });
				}

				const job = await resp.json();
				if (job.status === "running") {
					return jsonResult({ status: "running", elapsed_sec: job.elapsed_sec, message: "Backtest still running. Try again shortly." });
				}
				return jsonResult(job);
			},
		},
		{ optional: true },
	);

	// ── parameter_sweep ──
	api.registerTool(
		{
			name: "parameter_sweep",
			label: "Parameter Sweep",
			description:
				"Run multiple backtest parameter combinations to understand strategy sensitivity. " +
				"Varies specified parameters across a grid and returns job IDs for each combination. Max 20 combinations.",
			parameters: {
				type: "object",
				properties: {
					strategy_spec: { type: "string", description: "Base strategy specification JSON" },
					param_grid: {
						type: "string",
						description: "JSON of parameter grid, e.g. {\"dte_target\": [7, 14, 30], \"delta_target\": [0.1, 0.15, 0.2]}",
					},
					start_date: { type: "string" },
					end_date: { type: "string" },
					initial_capital: { type: "number" },
				},
				required: ["strategy_spec", "param_grid", "start_date"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				let spec: Record<string, unknown>;
				let paramGrid: Record<string, unknown[]>;
				try {
					spec = JSON.parse(params.strategy_spec as string);
					paramGrid = JSON.parse(params.param_grid as string);
				} catch (e) {
					return jsonResult({ error: `Invalid JSON: ${(e as Error).message}` });
				}

				// Build cartesian product
				const keys = Object.keys(paramGrid);
				const values = keys.map(k => paramGrid[k]);
				let combinations: Array<Record<string, unknown>> = [{}];
				for (let i = 0; i < keys.length; i++) {
					const expanded: Array<Record<string, unknown>> = [];
					for (const existing of combinations) {
						for (const v of values[i]) {
							expanded.push({ ...existing, [keys[i]]: v });
						}
					}
					combinations = expanded;
				}

				if (combinations.length > 20) {
					return jsonResult({
						error: `Parameter grid produces ${combinations.length} combinations (max 20). Reduce the grid.`,
					});
				}

				const sweepId = randomUUID().slice(0, 8);
				const jobIds: string[] = [];
				const errors: string[] = [];

				for (const combo of combinations) {
					const variantSpec = {
						...spec,
						strategy_id: `${spec.strategy_id as string}_${Object.entries(combo).map(([k, v]) => `${k}${v}`).join("_")}`,
						default_parameters: { ...(spec.default_parameters as object ?? {}), ...combo },
					};

					try {
						const resp = await enginePost("/backtest", {
							strategy_spec: variantSpec,
							start_date: params.start_date,
							end_date: params.end_date,
							initial_capital: (params.initial_capital as number | undefined) ?? 100000,
							cost_model: "default",
						});
						if (resp.ok) {
							const data = await resp.json();
							jobIds.push(data.job_id);
						} else {
							errors.push(`Failed to submit variant ${variantSpec.strategy_id}: ${resp.status}`);
						}
					} catch (e) {
						errors.push(`Error submitting variant: ${(e as Error).message}`);
					}
				}

				return jsonResult({
					sweep_id: sweepId,
					combinations: combinations.length,
					submitted: jobIds.length,
					job_ids: jobIds,
					errors: errors.length > 0 ? errors : undefined,
					message: `Started ${jobIds.length} backtest jobs. Poll with get_backtest_status, then compare_backtests.`,
				});
			},
		},
		{ optional: true },
	);

	// ── compare_backtests ──
	api.registerTool(
		{
			name: "compare_backtests",
			label: "Compare Backtests",
			description: "Compare results of multiple backtests side by side, ranked by Sharpe ratio.",
			parameters: {
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
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const jobIds = params.job_ids as string[];
				const results: Array<Record<string, unknown>> = [];

				for (const jobId of jobIds) {
					try {
						const resp = await engineGet(`/backtest/${jobId}`);
						if (resp.status === 404) {
							results.push({ job_id: jobId, status: "not_found" });
							continue;
						}
						const job = await resp.json();
						if (job.status === "running") {
							results.push({ job_id: jobId, status: "running", strategy_id: job.strategy_id });
							continue;
						}
						results.push({
							job_id: jobId,
							strategy_id: job.strategy_id,
							status: job.status,
							metrics: job.metrics,
							weaknesses: job.weaknesses,
						});
					} catch (e) {
						results.push({ job_id: jobId, status: "error", error: (e as Error).message });
					}
				}

				// Rank by Sharpe
				const done = results.filter(r => r.metrics !== undefined);
				done.sort((a, b) => {
					const sa = ((a.metrics as Record<string, number> | undefined)?.sharpe_ratio ?? 0);
					const sb = ((b.metrics as Record<string, number> | undefined)?.sharpe_ratio ?? 0);
					return sb - sa;
				});

				return jsonResult({
					total: jobIds.length,
					completed: done.length,
					pending: results.filter(r => r.status === "running").length,
					ranked_results: done,
					all_results: results,
				});
			},
		},
		{ optional: true },
	);
}

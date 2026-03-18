import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";
import { getJob, saveJob, updateJob } from "../backtest-jobs.js";
import { jsonResult } from "./result.js";

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../engine");
const VENV_PYTHON = join(ENGINE_DIR, ".venv/bin/python3");
const RUNNER_SCRIPT = join(ENGINE_DIR, "backtest_runner.py");

function runBacktestAsync(input: Record<string, unknown>, inputPath: string, outputPath: string, ctx: PluginContext): void {
	writeFileSync(inputPath, JSON.stringify(input));
	execFile(
		VENV_PYTHON,
		[RUNNER_SCRIPT, inputPath, outputPath],
		{ timeout: 300_000, env: { ...process.env } },
		(error, _stdout, stderr) => {
			if (error) {
				ctx.logger.error(`Backtest error (${input.job_id}): ${stderr || error.message}`);
				updateJob(ctx.dataDir, input.job_id as string, {
					status: "error",
					error: `Engine error: ${error.message}`,
				});
				return;
			}
			try {
				const result = JSON.parse(readFileSync(outputPath, "utf-8"));
				updateJob(ctx.dataDir, input.job_id as string, { status: "done", result });
			} catch (e) {
				updateJob(ctx.dataDir, input.job_id as string, {
					status: "error",
					error: `Failed to parse engine output: ${(e as Error).message}`,
				});
			}
		},
	);
}

export function registerBacktestTools(api: OpenClawPluginApi, ctx: PluginContext) {
	// ── run_backtest ──
	api.registerTool(
		{
			name: "run_backtest",
			label: "Run Backtest",
			description:
				"Run a historical backtest for a strategy specification. " +
				"Executes asynchronously via Python engine. Returns a job_id to poll for results.",
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

				const jobId = randomUUID();
				const tmpDir = join(ctx.dataDir, "tmp");
				mkdirSync(tmpDir, { recursive: true });

				const inputPath = join(tmpDir, `${jobId}.input.json`);
				const outputPath = join(tmpDir, `${jobId}.output.json`);

				const input = {
					job_id: jobId,
					strategy_spec: spec,
					start_date: params.start_date as string,
					end_date: params.end_date as string | undefined,
					data_dir: ctx.dataDir,
					initial_capital: (params.initial_capital as number | undefined) ?? 100000,
					cost_model: (params.cost_model as string | undefined) ?? "default",
				};

				const job = {
					job_id: jobId,
					status: "running" as const,
					strategy_id: (spec.strategy_id as string) ?? "unknown",
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				};
				saveJob(ctx.dataDir, job);

				if (!existsSync(VENV_PYTHON)) {
					return jsonResult({
						error: "Python venv not found. Ensure the Docker image is built with 'engine/.venv'.",
					});
				}

				runBacktestAsync(input, inputPath, outputPath, ctx);

				return jsonResult({
					job_id: jobId,
					status: "running",
					message: "Backtest started. Poll with get_backtest_status(job_id) to check progress.",
					strategy_id: job.strategy_id,
				});
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
				const job = getJob(ctx.dataDir, params.job_id as string);
				if (!job) {
					return jsonResult({ error: `Job '${params.job_id}' not found.` });
				}
				return jsonResult({
					job_id: job.job_id,
					status: job.status,
					strategy_id: job.strategy_id,
					created_at: job.created_at,
					updated_at: job.updated_at,
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
				const job = getJob(ctx.dataDir, params.job_id as string);
				if (!job) {
					return jsonResult({ error: `Job '${params.job_id}' not found.` });
				}
				if (job.status === "running" || job.status === "pending") {
					return jsonResult({ status: job.status, message: "Backtest still running. Try again shortly." });
				}
				if (job.status === "error") {
					return jsonResult({ status: "error", error: job.error });
				}
				return jsonResult(job.result);
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

				if (!existsSync(VENV_PYTHON)) {
					return jsonResult({ error: "Python venv not found." });
				}

				// Build cartesian product of parameter combinations
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
				const tmpDir = join(ctx.dataDir, "tmp");
				mkdirSync(tmpDir, { recursive: true });

				for (const combo of combinations) {
					const jobId = `sweep-${sweepId}-${randomUUID().slice(0, 8)}`;
					const variantSpec = {
						...spec,
						strategy_id: `${spec.strategy_id as string}_${Object.entries(combo).map(([k, v]) => `${k}${v}`).join("_")}`,
						default_parameters: { ...(spec.default_parameters as object ?? {}), ...combo },
					};
					const inputPath = join(tmpDir, `${jobId}.input.json`);
					const outputPath = join(tmpDir, `${jobId}.output.json`);
					const input = {
						job_id: jobId,
						strategy_spec: variantSpec,
						start_date: params.start_date as string,
						end_date: params.end_date as string | undefined,
						data_dir: ctx.dataDir,
						initial_capital: (params.initial_capital as number | undefined) ?? 100000,
						cost_model: "default",
					};
					saveJob(ctx.dataDir, {
						job_id: jobId,
						status: "running",
						strategy_id: variantSpec.strategy_id as string,
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					});
					runBacktestAsync(input, inputPath, outputPath, ctx);
					jobIds.push(jobId);
				}

				return jsonResult({
					sweep_id: sweepId,
					combinations: combinations.length,
					job_ids: jobIds,
					message: `Started ${combinations.length} backtest jobs. Poll with get_backtest_status, then compare_backtests.`,
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
					const job = getJob(ctx.dataDir, jobId);
					if (!job) {
						results.push({ job_id: jobId, status: "not_found" });
						continue;
					}
					if (job.status !== "done") {
						results.push({ job_id: jobId, status: job.status, strategy_id: job.strategy_id });
						continue;
					}
					const r = job.result as Record<string, unknown>;
					results.push({
						job_id: jobId,
						strategy_id: r?.strategy_id ?? job.strategy_id,
						status: r?.status,
						metrics: r?.metrics,
						weaknesses: r?.weaknesses,
					});
				}

				// Rank completed results by Sharpe
				const done = results.filter(r => r.metrics !== undefined);
				done.sort((a, b) => {
					const sa = ((a.metrics as Record<string, number> | undefined)?.sharpe_ratio ?? 0);
					const sb = ((b.metrics as Record<string, number> | undefined)?.sharpe_ratio ?? 0);
					return sb - sa;
				});

				return jsonResult({
					total: jobIds.length,
					completed: done.length,
					pending: results.filter(r => r.status === "running" || r.status === "pending").length,
					ranked_results: done,
					all_results: results,
				});
			},
		},
		{ optional: true },
	);
}

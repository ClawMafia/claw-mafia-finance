import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";
import { jsonResult } from "./result.js";
import { AlpacaClient } from "../data/alpaca-client.js";
import { loadRiskConfig, saveRiskConfig, triggerKillSwitch, clearKillSwitch, DEFAULT_RISK_LIMITS } from "../risk-config.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Normalize Alpaca position format to the internal format used by risk calculations.
// Alpaca: qty (string), avg_entry_price (string), asset_class ("us_equity")
// Internal: quantity (number), avg_price (number), asset_type ("stock"|"option")
type NormalizedPosition = {
	symbol: string;
	quantity: number;
	avg_price: number;
	market_value: number;
	asset_type: "stock" | "option";
	strategy_id: string;
	delta: number;
	gamma: number;
	vega: number;
	theta: number;
};

function normalizePositions(raw: unknown): NormalizedPosition[] {
	const list = (raw as { positions?: unknown[] })?.positions ?? (Array.isArray(raw) ? raw : []);
	return (list as Record<string, unknown>[]).map((p) => ({
		symbol: (p.symbol as string) ?? "",
		quantity: parseFloat((p.qty ?? p.quantity ?? "0") as string),
		avg_price: parseFloat((p.avg_entry_price ?? p.avg_price ?? "0") as string),
		market_value: parseFloat((p.market_value ?? "0") as string),
		asset_type: (p.asset_class === "us_equity" || p.asset_type === "stock") ? "stock" : "option",
		strategy_id: (p.strategy_id as string) ?? "unknown",
		// Stocks: delta=1, no greeks. Options (not yet supported) would need real greeks.
		delta: (p.delta as number) ?? ((p.asset_class === "us_equity" || p.asset_type === "stock") ? 1.0 : 0.5),
		gamma: (p.gamma as number) ?? 0,
		vega: (p.vega as number) ?? 0,
		theta: (p.theta as number) ?? 0,
	}));
}

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../engine");

// Standard normal CDF via Abramowitz & Stegun rational approximation
function normCdf(x: number): number {
	const t = 1 / (1 + 0.2316419 * Math.abs(x));
	const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
	const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
	const cdf = 1 - pdf * poly;
	return x >= 0 ? cdf : 1 - cdf;
}

function loadOhlcv(dataDir: string, symbol: string): Array<{ date: string; close: number }> | null {
	const path = join(dataDir, "ohlcv", `${symbol}-1d.json`);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

// 1-day parametric VaR for a single position using historical vol
function positionVar(
	notional: number,
	delta: number,
	annualVol: number,
	confidence: number,
	horizonDays: number,
): number {
	const dailyVol = annualVol / Math.sqrt(252);
	const zScore = -normCdf(1 - confidence) < 0 ? Math.abs(Math.log(1 - confidence)) : 1.645; // approx
	// Use z-score lookup: 95%→1.645, 99%→2.326
	const z = confidence >= 0.99 ? 2.326 : confidence >= 0.975 ? 1.96 : 1.645;
	return Math.abs(notional * delta * dailyVol * z * Math.sqrt(horizonDays));
}

// Named stress scenario shocks: { equity_pct, vol_pct, rate_bps }
const NAMED_SCENARIOS: Record<string, { equity_pct: number; vol_pct: number; rate_bps: number }> = {
	covid_crash: { equity_pct: -34, vol_pct: 400, rate_bps: -150 },
	rate_hike_100bps: { equity_pct: -8, vol_pct: 30, rate_bps: 100 },
	vol_spike_2x: { equity_pct: -5, vol_pct: 100, rate_bps: 0 },
	flash_crash: { equity_pct: -10, vol_pct: 150, rate_bps: 0 },
};

export function registerRiskTools(api: OpenClawPluginApi, ctx: PluginContext) {
	const alpaca = new AlpacaClient(
		ctx.config.alpacaApiKey,
		ctx.config.alpacaApiSecret,
		ctx.logger,
		ctx.dataDir,
		ctx.config.alpacaBaseUrl,
	);

	// ── calculate_portfolio_var ──
	api.registerTool(
		{
			name: "calculate_portfolio_var",
			label: "Calculate Portfolio VaR",
			description: "Calculate portfolio Value at Risk using parametric and historical methods.",
			parameters: {
				type: "object",
				properties: {
					confidence: { type: "number", description: "Confidence level (e.g. 0.95). Default: 0.95." },
					horizon_days: { type: "number", description: "Time horizon in days. Default: 1." },
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const confidence = (params.confidence as number | undefined) ?? 0.95;
				const horizonDays = (params.horizon_days as number | undefined) ?? 1;

				const posResult = await alpaca.getPositions();
				const positions = normalizePositions(posResult);

				if (positions.length === 0) {
					return jsonResult({ var_usd: 0, confidence, horizon_days: horizonDays, positions: 0, note: "No open positions." });
				}

				let totalVar = 0;
				const breakdown: Array<Record<string, unknown>> = [];

				for (const pos of positions) {
					const symbol = (pos.symbol as string ?? "").split(" ")[0]; // underlying ticker
					const quantity = (pos.quantity as number) ?? 0;
					const avgPrice = (pos.avg_price as number) ?? 0;
					const delta = (pos.asset_type as string) === "option" ? ((pos.delta as number) ?? 0.5) : 1.0;
					const multiplier = (pos.asset_type as string) === "option" ? 100 : 1;
					const notional = Math.abs(quantity) * avgPrice * multiplier;

					// Estimate vol from OHLCV cache
					const ohlcv = loadOhlcv(ctx.dataDir, symbol);
					let annualVol = 0.20; // fallback 20%
					if (ohlcv && ohlcv.length >= 31) {
						const recent = ohlcv.slice(-31);
						const returns = recent.slice(1).map((r, i) => Math.log(r.close / recent[i].close));
						const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
						const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
						annualVol = Math.sqrt(variance * 252);
					}

					const varUsd = positionVar(notional, Math.abs(delta), annualVol, confidence, horizonDays);
					totalVar += varUsd;
					breakdown.push({ symbol: pos.symbol, notional: Math.round(notional), delta, annual_vol_pct: Math.round(annualVol * 1000) / 10, var_usd: Math.round(varUsd) });
				}

				return jsonResult({
					var_usd: Math.round(totalVar),
					confidence,
					horizon_days: horizonDays,
					method: "parametric_delta_normal",
					positions: positions.length,
					breakdown,
				});
			},
		},
		{ optional: true },
	);

	// ── check_position_limits ──
	api.registerTool(
		{
			name: "check_position_limits",
			label: "Check Position Limits",
			description: "Validate current positions against configured risk limits.",
			parameters: {
				type: "object",
				properties: {
					strategy_id: { type: "string", description: "Check limits for specific strategy. Omit for portfolio-wide." },
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const posResult = await alpaca.getPositions(params.strategy_id as string | undefined);
				const positions = normalizePositions(posResult);
				const pnlResult = await alpaca.getPnL("inception");
				const totalEquity = (pnlResult as { equity?: number }).equity ?? 100_000;

				const LIMITS = {
					max_single_position_pct: 0.15,   // 15% of equity
					max_notional_per_strategy_pct: 0.30, // 30% per strategy
					max_options_delta_exposure_pct: 0.50, // 50% net delta notional
				};

				const violations: string[] = [];
				const warnings: string[] = [];

				// Group by strategy
				const byStrategy: Record<string, Array<Record<string, unknown>>> = {};
				for (const pos of positions) {
					const sid = (pos.strategy_id as string) ?? "unknown";
					(byStrategy[sid] ??= []).push(pos);
				}

				let totalNetDelta = 0;
				for (const pos of positions) {
					const qty = (pos.quantity as number) ?? 0;
					const price = (pos.avg_price as number) ?? 0;
					const delta = (pos.asset_type as string) === "option" ? ((pos.delta as number) ?? 0.5) : 1.0;
					const mult = (pos.asset_type as string) === "option" ? 100 : 1;
					const notional = Math.abs(qty) * price * mult;
					const positionPct = notional / totalEquity;
					if (positionPct > LIMITS.max_single_position_pct) {
						violations.push(`Position ${pos.symbol}: ${(positionPct * 100).toFixed(1)}% of equity exceeds ${LIMITS.max_single_position_pct * 100}% limit`);
					}
					totalNetDelta += qty * delta * price * mult;
				}

				for (const [sid, sPositions] of Object.entries(byStrategy)) {
					const stratNotional = sPositions.reduce((sum, p) => {
						const qty = (p.quantity as number) ?? 0;
						const price = (p.avg_price as number) ?? 0;
						const mult = (p.asset_type as string) === "option" ? 100 : 1;
						return sum + Math.abs(qty) * price * mult;
					}, 0);
					const stratPct = stratNotional / totalEquity;
					if (stratPct > LIMITS.max_notional_per_strategy_pct) {
						violations.push(`Strategy ${sid}: ${(stratPct * 100).toFixed(1)}% of equity exceeds ${LIMITS.max_notional_per_strategy_pct * 100}% limit`);
					}
				}

				const deltaPct = Math.abs(totalNetDelta) / totalEquity;
				if (deltaPct > LIMITS.max_options_delta_exposure_pct) {
					warnings.push(`Net delta exposure ${(deltaPct * 100).toFixed(1)}% of equity exceeds ${LIMITS.max_options_delta_exposure_pct * 100}% guideline`);
				}

				return jsonResult({
					status: violations.length > 0 ? "breach" : warnings.length > 0 ? "warning" : "ok",
					violations,
					warnings,
					limits: LIMITS,
					total_equity: Math.round(totalEquity),
					positions_checked: positions.length,
				});
			},
		},
		{ optional: true },
	);

	// ── stress_test_scenario ──
	api.registerTool(
		{
			name: "stress_test_scenario",
			label: "Stress Test Scenario",
			description:
				"Run stress test scenario on current portfolio. " +
				"Supports named scenarios (covid_crash, rate_hike_100bps) or custom shocks.",
			parameters: {
				type: "object",
				properties: {
					scenario_name: {
						type: "string",
						description: "Named scenario: 'covid_crash', 'rate_hike_100bps', 'vol_spike_2x', 'flash_crash'",
					},
					custom_shocks: {
						type: "string",
						description: "JSON of custom shocks, e.g. {\"equity_pct\": -10, \"vol_pct\": 50}",
					},
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				let shocks = { equity_pct: 0, vol_pct: 0, rate_bps: 0 };

				if (params.scenario_name) {
					const named = NAMED_SCENARIOS[params.scenario_name as string];
					if (!named) {
						return jsonResult({ error: `Unknown scenario '${params.scenario_name}'. Available: ${Object.keys(NAMED_SCENARIOS).join(", ")}` });
					}
					shocks = named;
				} else if (params.custom_shocks) {
					try {
						shocks = { ...shocks, ...JSON.parse(params.custom_shocks as string) };
					} catch (e) {
						return jsonResult({ error: `Invalid custom_shocks JSON: ${(e as Error).message}` });
					}
				} else {
					return jsonResult({ error: "Provide scenario_name or custom_shocks." });
				}

				const posResult = await alpaca.getPositions();
				const positions = normalizePositions(posResult);
				const pnlResult = await alpaca.getPnL("inception");
				const totalEquity = (pnlResult as { equity?: number }).equity ?? 100_000;

				let totalPnl = 0;
				const breakdown: Array<Record<string, unknown>> = [];

				for (const pos of positions) {
					const qty = (pos.quantity as number) ?? 0;
					const price = (pos.avg_price as number) ?? 0;
					const delta = (pos.asset_type as string) === "option" ? ((pos.delta as number) ?? 0.5) : 1.0;
					const vega = (pos.vega as number) ?? 0;
					const mult = (pos.asset_type as string) === "option" ? 100 : 1;

					// Delta P&L from equity shock
					const deltaShock = qty * delta * price * (shocks.equity_pct / 100) * mult;
					// Vega P&L from vol shock (vega is per 1% vol change, vol_pct is percent change in vol level)
					const vegaShock = qty * vega * (shocks.vol_pct / 100) * mult;
					const posPnl = deltaShock + vegaShock;
					totalPnl += posPnl;

					breakdown.push({
						symbol: pos.symbol,
						delta_pnl: Math.round(deltaShock),
						vega_pnl: Math.round(vegaShock),
						total_pnl: Math.round(posPnl),
					});
				}

				return jsonResult({
					scenario: params.scenario_name ?? "custom",
					shocks,
					estimated_pnl: Math.round(totalPnl),
					pnl_pct_equity: totalEquity > 0 ? Math.round((totalPnl / totalEquity) * 10000) / 100 : null,
					positions: positions.length,
					breakdown,
				});
			},
		},
		{ optional: true },
	);

	// ── correlation_matrix ──
	api.registerTool(
		{
			name: "correlation_matrix",
			label: "Correlation Matrix",
			description: "Calculate return correlation matrix for a set of symbols.",
			parameters: {
				type: "object",
				properties: {
					symbols: { type: "array", items: { type: "string" }, description: "Symbols to analyze" },
					lookback_days: { type: "number", description: "Lookback period in trading days. Default: 60." },
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const symbols = params.symbols as string[];
				const lookback = (params.lookback_days as number | undefined) ?? 60;

				if (!symbols || symbols.length < 2) {
					return jsonResult({ error: "Provide at least 2 symbols." });
				}

				const returnsMap: Record<string, number[]> = {};
				const missing: string[] = [];

				for (const sym of symbols) {
					const ohlcv = loadOhlcv(ctx.dataDir, sym);
					if (!ohlcv || ohlcv.length < lookback + 1) {
						missing.push(sym);
						continue;
					}
					const recent = ohlcv.slice(-(lookback + 1));
					returnsMap[sym] = recent.slice(1).map((r, i) => Math.log(r.close / recent[i].close));
				}

				const available = Object.keys(returnsMap);
				if (available.length < 2) {
					return jsonResult({ error: `Insufficient data. Missing: ${missing.join(", ")}` });
				}

				// Compute correlation matrix
				const matrix: Record<string, Record<string, number>> = {};
				for (const a of available) {
					matrix[a] = {};
					for (const b of available) {
						if (a === b) { matrix[a][b] = 1.0; continue; }
						const ra = returnsMap[a];
						const rb = returnsMap[b];
						const n = Math.min(ra.length, rb.length);
						const meanA = ra.slice(0, n).reduce((s, x) => s + x, 0) / n;
						const meanB = rb.slice(0, n).reduce((s, x) => s + x, 0) / n;
						let cov = 0, varA = 0, varB = 0;
						for (let i = 0; i < n; i++) {
							cov += (ra[i] - meanA) * (rb[i] - meanB);
							varA += (ra[i] - meanA) ** 2;
							varB += (rb[i] - meanB) ** 2;
						}
						const corr = varA > 0 && varB > 0 ? cov / Math.sqrt(varA * varB) : 0;
						matrix[a][b] = Math.round(corr * 1000) / 1000;
					}
				}

				return jsonResult({ symbols: available, lookback_days: lookback, matrix, missing });
			},
		},
		{ optional: true },
	);

	// ── exposure_report ──
	api.registerTool(
		{
			name: "exposure_report",
			label: "Exposure Report",
			description: "Generate portfolio exposure report: delta, gamma, vega, theta by underlying.",
			parameters: {
				type: "object",
				properties: {},
			},
			async execute(_toolCallId: string, _params: Record<string, unknown>) {
				const posResult = await alpaca.getPositions();
				const positions = normalizePositions(posResult);
				const pnlResult = await alpaca.getPnL("inception");
				const totalEquity = (pnlResult as { equity?: number }).equity ?? 100_000;

				// Aggregate greeks by underlying
				const byUnderlying: Record<string, { delta: number; gamma: number; vega: number; theta: number; notional: number }> = {};

				let totalDelta = 0, totalGamma = 0, totalVega = 0, totalTheta = 0, totalNotional = 0;

				for (const pos of positions) {
					const underlying = (pos.symbol as string ?? "").split(" ")[0];
					const qty = (pos.quantity as number) ?? 0;
					const price = (pos.avg_price as number) ?? 0;
					const mult = (pos.asset_type as string) === "option" ? 100 : 1;
					const notional = qty * price * mult;

					const delta = qty * ((pos.delta as number) ?? (pos.asset_type === "option" ? 0.5 : 1.0)) * mult;
					const gamma = qty * ((pos.gamma as number) ?? 0) * mult;
					const vega = qty * ((pos.vega as number) ?? 0) * mult;
					const theta = qty * ((pos.theta as number) ?? 0) * mult;

					byUnderlying[underlying] ??= { delta: 0, gamma: 0, vega: 0, theta: 0, notional: 0 };
					byUnderlying[underlying].delta += delta;
					byUnderlying[underlying].gamma += gamma;
					byUnderlying[underlying].vega += vega;
					byUnderlying[underlying].theta += theta;
					byUnderlying[underlying].notional += notional;

					totalDelta += delta;
					totalGamma += gamma;
					totalVega += vega;
					totalTheta += theta;
					totalNotional += notional;
				}

				const round2 = (n: number) => Math.round(n * 100) / 100;

				return jsonResult({
					total_equity: Math.round(totalEquity),
					portfolio_greeks: {
						net_delta: round2(totalDelta),
						net_gamma: round2(totalGamma),
						net_vega: round2(totalVega),
						daily_theta: round2(totalTheta),
						net_notional: Math.round(totalNotional),
					},
					by_underlying: Object.fromEntries(
						Object.entries(byUnderlying).map(([sym, g]) => [sym, {
							delta: round2(g.delta),
							gamma: round2(g.gamma),
							vega: round2(g.vega),
							theta: round2(g.theta),
							notional: Math.round(g.notional),
						}]),
					),
					positions: positions.length,
				});
			},
		},
		{ optional: true },
	);

	// ── get_risk_config ──
	api.registerTool(
		{
			name: "get_risk_config",
			label: "Get Risk Config",
			description: "Read current risk limits and kill switch status.",
			parameters: { type: "object", properties: {} },
			async execute(_toolCallId: string, _params: Record<string, unknown>) {
				const config = loadRiskConfig(ctx.dataDir);
				return jsonResult({
					...config,
					_defaults: DEFAULT_RISK_LIMITS,
					_note: "Use set_risk_config to override individual limits.",
				});
			},
		},
		{ optional: true },
	);

	// ── set_risk_config ──
	api.registerTool(
		{
			name: "set_risk_config",
			label: "Set Risk Config",
			description:
				"Update risk limits. Pass only the fields to change; others stay at current values. " +
				"Accepts nested JSON patch (e.g. portfolio.max_drawdown_pct, volatility.iv_spike_multiplier).",
			parameters: {
				type: "object",
				properties: {
					config_patch: {
						type: "string",
						description: "JSON patch object with fields to update, e.g. {\"portfolio\": {\"max_drawdown_pct\": 0.10}}",
					},
				},
				required: ["config_patch"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				let patch: Record<string, unknown>;
				try {
					patch = JSON.parse(params.config_patch as string);
				} catch (e) {
					return jsonResult({ error: `Invalid JSON: ${(e as Error).message}` });
				}

				const current = loadRiskConfig(ctx.dataDir);
				// Deep merge one level
				const updated = { ...current };
				for (const key of Object.keys(patch) as Array<keyof typeof current>) {
					if (typeof patch[key] === "object" && patch[key] !== null && typeof current[key] === "object") {
						(updated as Record<string, unknown>)[key] = { ...(current[key] as object), ...(patch[key] as object) };
					} else {
						(updated as Record<string, unknown>)[key] = patch[key];
					}
				}

				saveRiskConfig(ctx.dataDir, updated);
				return jsonResult({ status: "updated", config: updated });
			},
		},
		{ optional: true },
	);

	// ── trigger_kill_switch ──
	api.registerTool(
		{
			name: "trigger_kill_switch",
			label: "Trigger Kill Switch",
			description:
				"Activate or clear the portfolio kill switch. " +
				"When active, paper-executor will not accept new orders. " +
				"Activation should be posted to #risk-watch.",
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: ["activate", "clear"],
						description: "'activate' to halt trading, 'clear' to resume.",
					},
					reason: {
						type: "string",
						description: "Required when activating: human-readable reason.",
					},
					auto_resume_after_hours: {
						type: "number",
						description: "Automatically clear after this many hours (0 = manual only).",
					},
				},
				required: ["action"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				if (params.action === "activate") {
					if (!params.reason) {
						return jsonResult({ error: "reason is required when activating kill switch." });
					}
					const config = triggerKillSwitch(ctx.dataDir, params.reason as string);
					if (params.auto_resume_after_hours) {
						config.kill_switch.auto_resume_after_hours = params.auto_resume_after_hours as number;
						saveRiskConfig(ctx.dataDir, config);
					}
					ctx.logger.warn(`KILL SWITCH ACTIVATED: ${params.reason}`);
					return jsonResult({
						status: "activated",
						kill_switch: config.kill_switch,
						alert: "Post this to #risk-watch immediately.",
					});
				}
				if (params.action === "clear") {
					const config = clearKillSwitch(ctx.dataDir);
					ctx.logger.info("Kill switch cleared");
					return jsonResult({ status: "cleared", kill_switch: config.kill_switch });
				}
				return jsonResult({ error: `Unknown action '${params.action}'. Use 'activate' or 'clear'.` });
			},
		},
		{ optional: true },
	);
}

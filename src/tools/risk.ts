import type { OpenClawPluginApi } from "openclaw/plugin-sdk/claw-mafia-finance";
import type { PluginContext } from "../types.js";

export function registerRiskTools(api: OpenClawPluginApi, ctx: PluginContext) {
	// ── calculate_portfolio_var ──
	api.registerTool(
		{
			name: "calculate_portfolio_var",
			description: "Calculate portfolio Value at Risk using parametric and historical methods.",
			input_schema: {
				type: "object",
				properties: {
					confidence: { type: "number", description: "Confidence level (e.g. 0.95). Default: 0.95." },
					horizon_days: { type: "number", description: "Time horizon in days. Default: 1." },
				},
			},
			async call(params: Record<string, unknown>) {
				// TODO Phase 3
				return { status: "not_implemented", message: "VaR calculation is Phase 3." };
			},
		},
		{ optional: true },
	);

	// ── check_position_limits ──
	api.registerTool(
		{
			name: "check_position_limits",
			description: "Validate current positions against configured risk limits.",
			input_schema: {
				type: "object",
				properties: {
					strategy_id: { type: "string", description: "Check limits for specific strategy. Omit for portfolio-wide." },
				},
			},
			async call(params: Record<string, unknown>) {
				// TODO Phase 3
				return { status: "not_implemented" };
			},
		},
		{ optional: true },
	);

	// ── stress_test_scenario ──
	api.registerTool(
		{
			name: "stress_test_scenario",
			description:
				"Run stress test scenario on current portfolio. " +
				"Supports named scenarios (covid_crash, rate_hike_100bps) or custom shocks.",
			input_schema: {
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
			async call(params: Record<string, unknown>) {
				// TODO Phase 3
				return { status: "not_implemented" };
			},
		},
		{ optional: true },
	);

	// ── correlation_matrix ──
	api.registerTool(
		{
			name: "correlation_matrix",
			description: "Calculate return correlation matrix for a set of symbols.",
			input_schema: {
				type: "object",
				properties: {
					symbols: { type: "array", items: { type: "string" }, description: "Symbols to analyze" },
					lookback_days: { type: "number", description: "Lookback period in trading days. Default: 60." },
				},
			},
			async call(params: Record<string, unknown>) {
				// TODO Phase 3
				return { status: "not_implemented" };
			},
		},
		{ optional: true },
	);

	// ── exposure_report ──
	api.registerTool(
		{
			name: "exposure_report",
			description: "Generate portfolio exposure report: delta, gamma, vega, theta by underlying.",
			input_schema: {
				type: "object",
				properties: {},
			},
			async call(params: Record<string, unknown>) {
				// TODO Phase 3
				return { status: "not_implemented" };
			},
		},
		{ optional: true },
	);
}

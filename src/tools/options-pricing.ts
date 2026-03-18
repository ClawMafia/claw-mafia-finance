import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";
import { runPythonEngine } from "../engine-runner.js";
import { jsonResult } from "./result.js";

export function registerOptionsPricingTools(api: OpenClawPluginApi, ctx: PluginContext) {
	// ── black_scholes_pricer ──
	api.registerTool(
		{
			name: "black_scholes_pricer",
			label: "Black-Scholes Pricer",
			description:
				"Price a single option using Black-Scholes model. Returns theoretical price " +
				"and all greeks (delta, gamma, theta, vega, rho).",
			parameters: {
				type: "object",
				properties: {
					spot: { type: "number", description: "Current underlying price (S)" },
					strike: { type: "number", description: "Option strike price (K)" },
					dte: { type: "number", description: "Days to expiration" },
					risk_free_rate: { type: "number", description: "Annual risk-free rate (e.g. 0.05 for 5%)" },
					iv: { type: "number", description: "Implied volatility (e.g. 0.20 for 20%)" },
					option_type: { type: "string", description: "'call' or 'put'", enum: ["call", "put"] },
					dividend_yield: {
						type: "number",
						description: "Annual dividend yield (e.g. 0.013 for 1.3%). Default: 0.",
					},
				},
				required: ["spot", "strike", "dte", "risk_free_rate", "iv", "option_type"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				return jsonResult(await runPythonEngine("options_pricer", "black_scholes", params, ctx));
			},
		},
		{ optional: true },
	);

	// ── options_payoff_calculator ──
	api.registerTool(
		{
			name: "options_payoff_calculator",
			label: "Options Payoff Calculator",
			description:
				"Calculate payoff diagram for a multi-leg options structure at expiration. " +
				"Supports any combination of calls, puts, and stock positions.",
			parameters: {
				type: "object",
				properties: {
					legs: {
						type: "array",
						description: "List of position legs",
						items: {
							type: "object",
							properties: {
								type: { type: "string", enum: ["call", "put", "stock"] },
								side: { type: "string", enum: ["buy", "sell"] },
								strike: { type: "number", description: "Strike price (not needed for stock)" },
								premium: { type: "number", description: "Premium paid/received per share" },
								quantity: { type: "number", description: "Number of contracts (or shares for stock)" },
							},
							required: ["type", "side", "quantity"],
						},
					},
					underlying_price: { type: "number", description: "Current underlying price for reference" },
					price_range_pct: {
						type: "number",
						description: "Range around current price to calculate (%). Default: 20.",
					},
				},
				required: ["legs", "underlying_price"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				return jsonResult(await runPythonEngine("options_pricer", "payoff", params, ctx));
			},
		},
		{ optional: true },
	);

	// ── greeks_calculator ──
	api.registerTool(
		{
			name: "greeks_calculator",
			label: "Greeks Calculator",
			description:
				"Calculate portfolio-level aggregated greeks for a set of positions. " +
				"Returns net delta, gamma, theta, vega per underlying and total.",
			parameters: {
				type: "object",
				properties: {
					positions: {
						type: "array",
						description: "List of current positions with option details",
						items: {
							type: "object",
							properties: {
								symbol: { type: "string" },
								type: { type: "string", enum: ["call", "put", "stock"] },
								strike: { type: "number" },
								expiration: { type: "string", description: "YYYY-MM-DD" },
								quantity: { type: "number" },
								spot: { type: "number", description: "Current underlying price" },
								iv: { type: "number", description: "Current implied volatility" },
							},
							required: ["symbol", "type", "quantity"],
						},
					},
					risk_free_rate: { type: "number", description: "Annual risk-free rate. Default: 0.05." },
				},
				required: ["positions"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				return jsonResult(await runPythonEngine("options_pricer", "portfolio_greeks", params, ctx));
			},
		},
		{ optional: true },
	);
}

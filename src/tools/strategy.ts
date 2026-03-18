import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonResult } from "./result.js";

const STRATEGIES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../strategies");

export function registerStrategyTools(api: OpenClawPluginApi, ctx: PluginContext) {
	// ── strategy_template_lookup ──
	api.registerTool(
		{
			name: "strategy_template_lookup",
			label: "Strategy Template Lookup",
			description:
				"Look up strategy templates from the built-in library. " +
				"Returns available templates or a specific template's full specification. " +
				"Templates include: covered-call, collar, put-write, calendar-spread.",
			parameters: {
				type: "object",
				properties: {
					template_id: {
						type: "string",
						description:
							"Specific template ID to retrieve. Omit to list all available templates.",
					},
				},
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const templateId = params.template_id as string | undefined;

				if (!templateId) {
					let templates: string[] = [];
					try {
						templates = readdirSync(STRATEGIES_DIR)
							.filter(f => f.endsWith(".json"))
							.map(f => f.replace(".json", ""));
					} catch {
						templates = ["covered-call", "collar", "put-write", "calendar-spread"];
					}
					return jsonResult({
						available_templates: templates,
						usage: "Call again with template_id to get the full specification.",
					});
				}

				const filePath = join(STRATEGIES_DIR, `${templateId}.json`);
				if (!existsSync(filePath)) {
					return jsonResult({ error: `Template '${templateId}' not found. Use without template_id to list available.` });
				}

				return jsonResult(JSON.parse(readFileSync(filePath, "utf-8")));
			},
		},
		{ optional: true },
	);

	// ── strategy_spec_validator ──
	api.registerTool(
		{
			name: "strategy_spec_validator",
			label: "Strategy Spec Validator",
			description:
				"Validate a strategy specification JSON against the required schema. " +
				"Checks that all required fields are present and types are correct.",
			parameters: {
				type: "object",
				properties: {
					spec: {
						type: "string",
						description: "JSON string of the strategy specification to validate.",
					},
				},
				required: ["spec"],
			},
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				try {
					const spec = JSON.parse(params.spec as string);
					const errors: string[] = [];

					// Required fields
					if (!spec.strategy_id || typeof spec.strategy_id !== "string") errors.push("Missing required field: strategy_id (string)");
					else if (!/^[a-z0-9_-]+$/.test(spec.strategy_id)) errors.push("strategy_id must be lowercase alphanumeric with underscores/hyphens");
					if (!spec.universe || !Array.isArray(spec.universe) || spec.universe.length === 0) errors.push("Missing or invalid field: universe (non-empty array of tickers)");
					const validStructures = ["covered_call", "collar", "put_write", "calendar_spread", "custom"];
					if (!spec.structure) errors.push("Missing required field: structure");
					else if (!validStructures.includes(spec.structure)) errors.push(`Invalid structure '${spec.structure}'. Must be one of: ${validStructures.join(", ")}`);
					if (!spec.entry_rules || !Array.isArray(spec.entry_rules) || spec.entry_rules.length === 0) errors.push("Missing or invalid field: entry_rules (non-empty array)");
					if (!spec.exit_rules || !Array.isArray(spec.exit_rules) || spec.exit_rules.length === 0) errors.push("Missing or invalid field: exit_rules (non-empty array)");
					if (!spec.objective || typeof spec.objective !== "string") errors.push("Missing required field: objective (string)");

					// Recommended fields (warnings only)
					const warnings: string[] = [];
					if (!spec.assumptions || !Array.isArray(spec.assumptions) || spec.assumptions.length === 0) warnings.push("Recommended: add assumptions[] stating what market conditions would invalidate the strategy");
					if (!spec.constraints) warnings.push("Recommended: add constraints{} with max_loss_per_trade_pct and/or max_position_notional");

					if (errors.length > 0) {
						return jsonResult({ valid: false, errors, warnings });
					}

					return jsonResult({ valid: true, strategy_id: spec.strategy_id, structure: spec.structure, warnings });
				} catch (e) {
					return jsonResult({ valid: false, errors: [`Invalid JSON: ${(e as Error).message}`] });
				}
			},
		},
		{ optional: true },
	);
}

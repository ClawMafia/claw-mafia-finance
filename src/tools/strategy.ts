import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginContext } from "../types.js";
import { readFileSync, existsSync } from "node:fs";
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
					const templates = ["covered-call", "collar", "put-write", "calendar-spread"];
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

					if (!spec.strategy_id) errors.push("Missing required field: strategy_id");
					if (!spec.universe || !Array.isArray(spec.universe)) errors.push("Missing or invalid field: universe (must be array)");
					if (!spec.structure) errors.push("Missing required field: structure");
					if (!spec.entry_rules || !Array.isArray(spec.entry_rules)) errors.push("Missing or invalid field: entry_rules (must be array)");
					if (!spec.exit_rules || !Array.isArray(spec.exit_rules)) errors.push("Missing or invalid field: exit_rules (must be array)");
					if (!spec.objective) errors.push("Missing required field: objective");

					if (errors.length > 0) {
						return jsonResult({ valid: false, errors });
					}

					return jsonResult({ valid: true, strategy_id: spec.strategy_id, structure: spec.structure });
				} catch (e) {
					return jsonResult({ valid: false, errors: [`Invalid JSON: ${(e as Error).message}`] });
				}
			},
		},
		{ optional: true },
	);
}

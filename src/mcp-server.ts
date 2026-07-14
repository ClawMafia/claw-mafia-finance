#!/usr/bin/env node
/**
 * Standalone MCP server exposing the claw-mafia-finance tools over stdio.
 *
 * This is the Hermes-facing entrypoint: a Hermes agent (or any MCP client)
 * connects to it via `mcp.json` and gets the full finance tool set — the same
 * `ibkr_*`, `attach_reasoning`, risk, market-data, etc. tools the OpenClaw plugin
 * exposed — without needing the OpenClaw runtime.
 *
 * It reuses the exact tool implementations via `registerAllTools()` plus a
 * minimal "collector" api that implements only `registerTool` (the sole `api`
 * method the tools use). Config comes from environment variables. All logs go to
 * stderr so the stdout JSON-RPC channel stays clean.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerAllTools } from "./index.js";
import type { FinancePluginConfig } from "./index.js";
import type { PluginContext } from "./types.js";
import { LedgerStore } from "./data/ledger-store.js";
import { IBKRClient } from "./data/ibkr-client.js";
import { FlexClient } from "./data/flex-client.js";

// stdout is the MCP JSON-RPC channel; everything human-facing goes to stderr.
const logger = {
	info: (m: string) => process.stderr.write(`[info] ${m}\n`),
	warn: (m: string) => process.stderr.write(`[warn] ${m}\n`),
	error: (m: string) => process.stderr.write(`[error] ${m}\n`),
};

function num(v: string | undefined): number | undefined {
	if (!v) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

function configFromEnv(): FinancePluginConfig {
	const env = process.env;
	return {
		alpacaApiKey: env.ALPACA_API_KEY ?? "",
		alpacaApiSecret: env.ALPACA_SECRET_KEY ?? env.ALPACA_API_SECRET ?? "",
		alpacaBaseUrl: env.ALPACA_BASE_URL,
		ibkrHost: env.IBKR_HOST,
		ibkrPort: num(env.IBKR_PORT),
		ibkrFlexToken: env.IBKR_FLEX_TOKEN,
		ibkrFlexQueryId: env.IBKR_FLEX_QUERY_ID,
		fredApiKey: env.FRED_API_KEY,
		dataDir: env.CLAWMAFIA_DATA_DIR ?? env.DATA_DIR,
		ledgerDbPath: env.LEDGER_DB_PATH,
	};
}

/** Shape of a tool definition as the tool files pass it to registerTool(). */
type ToolDef = {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};

/** Run the existing registration code against a collector that captures the defs. */
function collectTools(ctx: PluginContext): ToolDef[] {
	const tools: ToolDef[] = [];
	const collector = {
		registerTool: (def: ToolDef) => tools.push(def),
		logger,
	} as unknown as OpenClawPluginApi;
	registerAllTools(collector, ctx);
	return tools;
}

async function main(): Promise<void> {
	const config = configFromEnv();
	// Honor the same state dir as the OpenClaw runtime so the MCP server hits the
	// SAME ledger DB (OPENCLAW_STATE_DIR is set by the deploy; default ~/.openclaw).
	const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw");
	const dataDir = config.dataDir ?? join(stateDir, "finance", "data");
	const ledgerDbPath = config.ledgerDbPath ?? join(stateDir, "finance", "ledger.sqlite");

	const store = new LedgerStore(ledgerDbPath, logger);
	const ibkr = new IBKRClient(config.ibkrHost ?? "localhost", config.ibkrPort ?? 4000, logger);
	const flex = new FlexClient(config.ibkrFlexToken ?? "", logger);
	const ctx: PluginContext = { config, dataDir, stateDir, store, ibkr, flex, logger };

	const tools = collectTools(ctx);
	const byName = new Map(tools.map((t) => [t.name, t]));
	logger.info(`claw-mafia-finance MCP: ${tools.length} tools; ledger ${ledgerDbPath}`);

	const server = new Server(
		{ name: "claw-mafia-finance", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((t) => ({
			name: t.name,
			description: t.description ?? "",
			inputSchema: (t.parameters as { type: "object" } | undefined) ?? { type: "object", properties: {} },
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args } = req.params;
		const tool = byName.get(name);
		if (!tool) {
			return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
		}
		try {
			const result = await tool.execute(`mcp-${name}`, (args ?? {}) as Record<string, unknown>);
			return { content: result.content };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error(`tool ${name} failed: ${msg}`);
			return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
		}
	});

	await server.connect(new StdioServerTransport());
	logger.info("claw-mafia-finance MCP server ready (stdio)");
}

main().catch((err) => {
	process.stderr.write(`FATAL: ${err?.stack ?? err}\n`);
	process.exit(1);
});

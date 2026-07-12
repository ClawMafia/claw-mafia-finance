/**
 * Smoke test for the claw-mafia-finance MCP server.
 * Spawns dist/mcp-server.js over stdio, lists tools, and calls a gateway-free
 * tool (ibkr_get_positions_book) against a throwaway temp ledger DB.
 *
 * Run: node test/integration/mcp-smoke.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const env = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
env.LEDGER_DB_PATH = "/tmp/claude-1000/mcp-smoke-ledger.sqlite";
env.CLAWMAFIA_DATA_DIR = "/tmp/claude-1000/mcp-smoke-data";

const transport = new StdioClientTransport({
	command: "node",
	args: ["dist/mcp-server.js"],
	cwd: process.cwd(),
	env,
	stderr: "inherit",
});

const client = new Client({ name: "mcp-smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`\nTOOLS (${tools.length}):`);
for (const t of tools) console.log(`  - ${t.name}`);

const target = "ibkr_get_positions_book";
console.log(`\nCALL ${target} {}:`);
const res = await client.callTool({ name: target, arguments: {} });
console.log(res.content?.[0]?.text ?? JSON.stringify(res));

await client.close();
console.log("\nSMOKE OK");
process.exit(0);

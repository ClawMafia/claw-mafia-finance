/**
 * Thin TypeScript client for paper_broker.py.
 * Calls the Python engine via subprocess with JSON input/output.
 */
import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { PluginContext } from "./types.js";

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../engine");
const VENV_PYTHON = join(ENGINE_DIR, ".venv/bin/python3");
const BROKER_SCRIPT = join(ENGINE_DIR, "paper_broker.py");

export async function callPaperBroker(
	command: string,
	params: Record<string, unknown>,
	ctx: PluginContext,
): Promise<unknown> {
	const id = randomUUID();
	const tmpDir = join(ctx.dataDir, "tmp");
	mkdirSync(tmpDir, { recursive: true });

	const inputPath = join(tmpDir, `broker-${id}.input.json`);
	const outputPath = join(tmpDir, `broker-${id}.output.json`);

	writeFileSync(inputPath, JSON.stringify({ command, params, data_dir: ctx.dataDir }));

	return new Promise((resolve) => {
		execFile(
			VENV_PYTHON,
			[BROKER_SCRIPT, inputPath, outputPath],
			{ timeout: 30_000, env: { ...process.env } },
			(error, _stdout, stderr) => {
				if (error) {
					ctx.logger.error(`Paper broker error (${command}): ${stderr || error.message}`);
					resolve({ error: `Broker error: ${error.message}` });
					return;
				}
				try {
					resolve(JSON.parse(readFileSync(outputPath, "utf-8")));
				} catch (e) {
					resolve({ error: `Failed to parse broker output: ${(e as Error).message}` });
				}
			},
		);
	});
}

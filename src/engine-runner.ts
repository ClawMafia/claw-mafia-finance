/**
 * Runs Python engine scripts as subprocesses.
 * All Python engines live in the engine/ directory.
 */
import { execFile } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { PluginContext } from "./types.js";

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../engine");
const VENV_PYTHON = join(ENGINE_DIR, ".venv/bin/python3");

export async function runPythonEngine(
	script: string,
	function_name: string,
	params: Record<string, unknown>,
	ctx: PluginContext,
): Promise<unknown> {
	const inputId = randomUUID();
	const tmpDir = join(ctx.dataDir, "tmp");
	mkdirSync(tmpDir, { recursive: true });

	const inputPath = join(tmpDir, `${inputId}.input.json`);
	const outputPath = join(tmpDir, `${inputId}.output.json`);

	writeFileSync(inputPath, JSON.stringify({ function: function_name, params }));

	return new Promise((resolve, reject) => {
		const scriptPath = join(ENGINE_DIR, `${script}.py`);

		execFile(
			VENV_PYTHON,
			[scriptPath, inputPath, outputPath],
			{ timeout: 120_000, env: { ...process.env } },
			(error, stdout, stderr) => {
				if (error) {
					ctx.logger.error(`Python engine error (${script}.${function_name}): ${stderr || error.message}`);
					resolve({
						error: `Engine error: ${error.message}`,
						stderr: stderr?.slice(0, 500),
					});
					return;
				}

				try {
					const { readFileSync } = require("node:fs");
					const result = JSON.parse(readFileSync(outputPath, "utf-8"));
					resolve(result);
				} catch (e) {
					ctx.logger.error(`Failed to read engine output: ${(e as Error).message}`);
					resolve({
						error: `Failed to parse engine output: ${(e as Error).message}`,
						stdout: stdout?.slice(0, 500),
					});
				}
			},
		);
	});
}

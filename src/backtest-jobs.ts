/**
 * Simple file-based job store for async backtest jobs.
 * Jobs are stored as JSON files in {dataDir}/jobs/{job_id}.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type JobStatus = "pending" | "running" | "done" | "error";

export type BacktestJob = {
	job_id: string;
	status: JobStatus;
	strategy_id: string;
	created_at: string;
	updated_at: string;
	result?: unknown;
	error?: string;
};

export function jobsDir(dataDir: string): string {
	return join(dataDir, "jobs");
}

export function getJob(dataDir: string, jobId: string): BacktestJob | null {
	const path = join(jobsDir(dataDir), `${jobId}.json`);
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf-8"));
}

export function saveJob(dataDir: string, job: BacktestJob): void {
	const dir = jobsDir(dataDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${job.job_id}.json`), JSON.stringify(job, null, 2));
}

export function updateJob(dataDir: string, jobId: string, updates: Partial<BacktestJob>): BacktestJob | null {
	const job = getJob(dataDir, jobId);
	if (!job) return null;
	const updated = { ...job, ...updates, updated_at: new Date().toISOString() };
	saveJob(dataDir, updated);
	return updated;
}

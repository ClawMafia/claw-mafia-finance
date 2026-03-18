/**
 * Bootstrap scheduled cron jobs for the Claw Mafia Finance agents.
 * Writes jobs to the OpenClaw cron store file on first run.
 *
 * Jobs defined here (CLA-21):
 *  - daily-data-refresh    : market-data agent at 8:00 AM ET
 *  - paper-rebalance-check : paper-executor agent at 9:45 AM ET
 *  - risk-check-930        : risk-manager agent at 9:30 AM ET
 *  - risk-check-1200       : risk-manager agent at 12:00 PM ET
 *  - risk-check-1500       : risk-manager agent at 3:00 PM ET
 *  - iv-spike-monitor      : risk-manager agent every 15 min during market hours
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

type CronSchedule =
	| { kind: "cron"; expr: string; tz: string }
	| { kind: "every"; everyMs: number };

type CronJob = {
	id: string;
	agentId: string;
	name: string;
	description: string;
	enabled: boolean;
	createdAtMs: number;
	updatedAtMs: number;
	schedule: CronSchedule;
	sessionTarget: string;
	wakeMode: string;
	payload: {
		kind: "agentTurn";
		message: string;
		lightContext: boolean;
		timeoutSeconds: number;
	};
	state: Record<string, unknown>;
};

type CronStoreFile = {
	version: 1;
	jobs: CronJob[];
};

// Resolve the OpenClaw state dir the same way OpenClaw does
function resolveOpenClawStateDir(): string {
	const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
	if (override) {
		return override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : override;
	}
	return path.join(os.homedir(), ".openclaw");
}

const CRON_JOB_DEFINITIONS: Array<Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state">> = [
	{
		agentId: "market-data",
		name: "daily-data-refresh",
		description: "Daily OHLCV and IV data refresh before market open (CLA-21)",
		enabled: true,
		schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "America/New_York" },
		sessionTarget: "isolated",
		wakeMode: "next-heartbeat",
		payload: {
			kind: "agentTurn",
			message: "Run your daily data refresh heartbeat: fetch latest OHLCV data for all watched symbols, update IV surfaces, and report any data gaps to #system-logs.",
			lightContext: true,
			timeoutSeconds: 300,
		},
	},
	{
		agentId: "paper-executor",
		name: "paper-rebalance-check",
		description: "Daily paper trading rebalance check 15 min after open (CLA-21)",
		enabled: true,
		schedule: { kind: "cron", expr: "45 9 * * 1-5", tz: "America/New_York" },
		sessionTarget: "isolated",
		wakeMode: "next-heartbeat",
		payload: {
			kind: "agentTurn",
			message: "Run your daily rebalance heartbeat: check all open positions, identify any expiring within roll window, execute approved rolls, report PnL summary to #paper-trading.",
			lightContext: true,
			timeoutSeconds: 180,
		},
	},
	{
		agentId: "risk-manager",
		name: "risk-check-930",
		description: "Morning risk check at market open (CLA-21)",
		enabled: true,
		schedule: { kind: "cron", expr: "30 9 * * 1-5", tz: "America/New_York" },
		sessionTarget: "isolated",
		wakeMode: "next-heartbeat",
		payload: {
			kind: "agentTurn",
			message: "Run your market-open risk heartbeat: check portfolio VaR, position limits, IV levels, and drawdown. Alert #risk-watch if any threshold is breached.",
			lightContext: true,
			timeoutSeconds: 120,
		},
	},
	{
		agentId: "risk-manager",
		name: "risk-check-1200",
		description: "Midday risk check (CLA-21)",
		enabled: true,
		schedule: { kind: "cron", expr: "0 12 * * 1-5", tz: "America/New_York" },
		sessionTarget: "isolated",
		wakeMode: "next-heartbeat",
		payload: {
			kind: "agentTurn",
			message: "Run your midday risk heartbeat: check portfolio VaR, position limits, IV levels, and drawdown. Alert #risk-watch if any threshold is breached.",
			lightContext: true,
			timeoutSeconds: 120,
		},
	},
	{
		agentId: "risk-manager",
		name: "risk-check-1500",
		description: "Afternoon risk check 1 hour before close (CLA-21)",
		enabled: true,
		schedule: { kind: "cron", expr: "0 15 * * 1-5", tz: "America/New_York" },
		sessionTarget: "isolated",
		wakeMode: "next-heartbeat",
		payload: {
			kind: "agentTurn",
			message: "Run your end-of-day risk heartbeat: check portfolio VaR, position limits, IV levels, drawdown, and identify any positions expiring today or tomorrow. Alert #risk-watch if any threshold is breached.",
			lightContext: true,
			timeoutSeconds: 120,
		},
	},
	{
		agentId: "risk-manager",
		name: "iv-spike-monitor",
		description: "IV spike monitor every 15 minutes during market hours (CLA-21)",
		enabled: true,
		schedule: { kind: "cron", expr: "*/15 9-16 * * 1-5", tz: "America/New_York" },
		sessionTarget: "isolated",
		wakeMode: "next-heartbeat",
		payload: {
			kind: "agentTurn",
			message: "Quick IV spike check: compare current IV to 20-day average for all held positions. If any symbol shows IV > 1.5x average, alert #risk-watch. If IV > 2x average, trigger kill switch immediately.",
			lightContext: true,
			timeoutSeconds: 60,
		},
	},
];

export function bootstrapCronJobs(logger: Logger): void {
	const stateDir = resolveOpenClawStateDir();
	const cronDir = path.join(stateDir, "cron");
	const storePath = path.join(cronDir, "jobs.json");
	const guardPath = path.join(cronDir, "claw-mafia-jobs-bootstrapped");

	if (fs.existsSync(guardPath)) {
		logger.info("claw-mafia-finance: cron jobs already bootstrapped, skipping");
		return;
	}

	fs.mkdirSync(cronDir, { recursive: true });

	let store: CronStoreFile = { version: 1, jobs: [] };
	if (fs.existsSync(storePath)) {
		try {
			store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
		} catch {
			logger.warn("claw-mafia-finance: could not parse existing cron store, starting fresh");
		}
	}

	const existingNames = new Set(store.jobs.map((j) => j.name));
	const now = Date.now();

	for (const def of CRON_JOB_DEFINITIONS) {
		if (existingNames.has(def.name)) continue;
		const job: CronJob = {
			...def,
			id: randomUUID(),
			createdAtMs: now,
			updatedAtMs: now,
			state: {},
		};
		store.jobs.push(job);
		logger.info(`claw-mafia-finance: registered cron job '${def.name}' (${def.agentId})`);
	}

	fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
	fs.writeFileSync(guardPath, new Date().toISOString());
	logger.info("claw-mafia-finance: cron jobs bootstrapped");
}

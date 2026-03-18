/**
 * Risk configuration store.
 * Persists risk limits and kill switch state to {dataDir}/risk-config.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type RiskLimits = {
	portfolio: {
		max_daily_var_pct: number;   // 1.2% default
		max_drawdown_pct: number;    // 8% default
		max_net_delta_pct: number;   // 50% default
		max_gross_notional_pct: number; // 150% default
	};
	strategy: {
		max_drawdown_pct: number;         // 5% default
		max_allocation_pct: number;       // 30% default
		max_position_notional_pct: number; // 15% default
	};
	sector: {
		max_sector_weight_pct: number;  // 40% default
	};
	volatility: {
		iv_spike_multiplier: number;          // 2.0x kill switch
		iv_alert_multiplier: number;          // 1.5x alert
		correlation_breach_threshold: number; // 0.9
	};
	kill_switch: {
		active: boolean;
		reason?: string;
		triggered_at?: string;
		auto_resume_after_hours: number;
	};
};

export const DEFAULT_RISK_LIMITS: RiskLimits = {
	portfolio: {
		max_daily_var_pct: 0.012,
		max_drawdown_pct: 0.08,
		max_net_delta_pct: 0.50,
		max_gross_notional_pct: 1.5,
	},
	strategy: {
		max_drawdown_pct: 0.05,
		max_allocation_pct: 0.30,
		max_position_notional_pct: 0.15,
	},
	sector: {
		max_sector_weight_pct: 0.40,
	},
	volatility: {
		iv_spike_multiplier: 2.0,
		iv_alert_multiplier: 1.5,
		correlation_breach_threshold: 0.9,
	},
	kill_switch: {
		active: false,
		auto_resume_after_hours: 0,
	},
};

function configPath(dataDir: string): string {
	return join(dataDir, "risk-config.json");
}

export function loadRiskConfig(dataDir: string): RiskLimits {
	const path = configPath(dataDir);
	if (!existsSync(path)) return structuredClone(DEFAULT_RISK_LIMITS);
	try {
		return { ...structuredClone(DEFAULT_RISK_LIMITS), ...JSON.parse(readFileSync(path, "utf-8")) };
	} catch {
		return structuredClone(DEFAULT_RISK_LIMITS);
	}
}

export function saveRiskConfig(dataDir: string, config: RiskLimits): void {
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(configPath(dataDir), JSON.stringify(config, null, 2));
}

export function isKillSwitchActive(dataDir: string): boolean {
	const config = loadRiskConfig(dataDir);
	if (!config.kill_switch.active) return false;

	// Auto-resume check
	if (config.kill_switch.auto_resume_after_hours > 0 && config.kill_switch.triggered_at) {
		const triggeredMs = new Date(config.kill_switch.triggered_at).getTime();
		const expiresMs = triggeredMs + config.kill_switch.auto_resume_after_hours * 3_600_000;
		if (Date.now() > expiresMs) {
			// Auto-clear
			config.kill_switch.active = false;
			delete config.kill_switch.reason;
			delete config.kill_switch.triggered_at;
			saveRiskConfig(dataDir, config);
			return false;
		}
	}
	return true;
}

export function triggerKillSwitch(dataDir: string, reason: string): RiskLimits {
	const config = loadRiskConfig(dataDir);
	config.kill_switch.active = true;
	config.kill_switch.reason = reason;
	config.kill_switch.triggered_at = new Date().toISOString();
	saveRiskConfig(dataDir, config);
	return config;
}

export function clearKillSwitch(dataDir: string): RiskLimits {
	const config = loadRiskConfig(dataDir);
	config.kill_switch.active = false;
	delete config.kill_switch.reason;
	delete config.kill_switch.triggered_at;
	saveRiskConfig(dataDir, config);
	return config;
}

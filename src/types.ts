import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { FinancePluginConfig } from "./index.js";

export type PluginContext = {
	config: FinancePluginConfig;
	dataDir: string;
	logger: OpenClawPluginApi["logger"];
};

// ── Strategy Spec ──

export type OptionLeg = {
	type: "call" | "put";
	side: "buy" | "sell";
	delta_target?: number;
	strike_offset_pct?: number;
	dte_target: number;
	quantity: number;
};

export type StrategySpec = {
	strategy_id: string;
	universe: string[];
	structure: string;
	legs?: OptionLeg[];
	entry_rules: string[];
	exit_rules: string[];
	roll_rules?: string[];
	objective: string;
	assumptions?: string[];
	constraints?: Record<string, number>;
};

// ── Backtest Result ──

export type BacktestMetrics = {
	annualized_return: number;
	sharpe_ratio: number;
	sortino_ratio: number;
	max_drawdown: number;
	calmar_ratio: number;
	win_rate: number;
	total_trades: number;
	turnover_annual: number;
	total_costs_bps: number;
};

export type BacktestResult = {
	status: "completed" | "failed" | "running";
	job_id: string;
	strategy_id: string;
	period: string;
	metrics?: BacktestMetrics;
	regime_breakdown?: Record<string, { return: number; sharpe: number }>;
	stress_results?: Record<string, { drawdown: number; recovery_days: number }>;
	weaknesses?: string[];
	assumptions?: Record<string, unknown>;
	error?: string;
};

// ── Paper Trading ──

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OrderStatus = "pending" | "filled" | "cancelled" | "rejected";
export type AssetType = "stock" | "option";

export type PaperOrder = {
	order_id: string;
	strategy_id: string;
	symbol: string;
	asset_type: AssetType;
	side: OrderSide;
	quantity: number;
	order_type: OrderType;
	limit_price?: number;
	status: OrderStatus;
	filled_price?: number;
	filled_at?: string;
	created_at: string;
};

export type PaperPosition = {
	symbol: string;
	asset_type: AssetType;
	quantity: number;
	avg_cost: number;
	market_value: number;
	unrealized_pnl: number;
	strategy_id: string;
};

// ── Risk ──

export type RiskLimits = {
	max_position_notional?: number;
	max_single_name_weight_pct?: number;
	max_sector_weight_pct?: number;
	max_daily_var_95_pct?: number;
	max_drawdown_pct?: number;
	iv_spike_threshold?: number;
};

// ── Review ──

export type JournalEntry = {
	date: string;
	portfolio_pnl: { daily: number; mtd: number; ytd: number };
	strategy_attribution: Record<string, { pnl: number; thesis_alignment: string }>;
	observations: string[];
	action_items: string[];
	risk_events: string[];
	lessons: string[];
};

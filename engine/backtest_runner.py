"""
Backtest engine for options strategies.
Called by the TypeScript plugin via subprocess.

Usage: python3 backtest_runner.py <input.json>
Output: JSON to stdout matching schemas/backtest-result.json

Input schema:
{
  "job_id": "...",
  "strategy_spec": {...},  // strategy-spec.json schema
  "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD",
  "data_dir": "/path/to/data",
  "initial_capital": 100000,
  "cost_model": "default" | "zero"
}
"""
import sys
import json
import math
import os
from datetime import date, timedelta, datetime
from typing import Optional


# ─── Black-Scholes pricing ────────────────────────────────────────────────────

def _norm_cdf(x: float) -> float:
    """Standard normal CDF using math.erfc for speed."""
    return 0.5 * math.erfc(-x / math.sqrt(2))


def black_scholes_price(S: float, K: float, T: float, r: float, sigma: float, opt_type: str) -> dict:
    """Price option and compute greeks. T in years."""
    if T <= 0:
        intrinsic = max(S - K, 0) if opt_type == "call" else max(K - S, 0)
        delta = (1.0 if S > K else 0.0) if opt_type == "call" else (-1.0 if S < K else 0.0)
        return {"price": intrinsic, "delta": delta, "gamma": 0.0, "theta": 0.0, "vega": 0.0}

    sqrt_T = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * sqrt_T)
    d2 = d1 - sigma * sqrt_T

    if opt_type == "call":
        price = S * _norm_cdf(d1) - K * math.exp(-r * T) * _norm_cdf(d2)
        delta = _norm_cdf(d1)
    else:
        price = K * math.exp(-r * T) * _norm_cdf(-d2) - S * _norm_cdf(-d1)
        delta = _norm_cdf(d1) - 1.0

    nd1 = math.exp(-0.5 * d1 ** 2) / math.sqrt(2 * math.pi)
    gamma = nd1 / (S * sigma * sqrt_T)
    theta = (-(S * nd1 * sigma) / (2 * sqrt_T) - r * K * math.exp(-r * T) * _norm_cdf(d2)) / 365
    vega = S * nd1 * sqrt_T / 100  # per 1% IV move

    return {"price": max(price, 0.0), "delta": delta, "gamma": gamma, "theta": theta, "vega": vega}


def find_strike_for_delta(S: float, T: float, r: float, sigma: float, target_delta: float, opt_type: str) -> float:
    """Binary search for strike matching a target delta."""
    lo, hi = S * 0.3, S * 2.0
    for _ in range(50):
        mid = (lo + hi) / 2.0
        result = black_scholes_price(S, mid, T, r, sigma, opt_type)
        d = abs(result["delta"])
        if d > target_delta:
            if opt_type == "call":
                hi = mid
            else:
                lo = mid
        else:
            if opt_type == "call":
                lo = mid
            else:
                hi = mid
        if abs(d - target_delta) < 0.001:
            break
    return (lo + hi) / 2.0


# ─── Data loading ─────────────────────────────────────────────────────────────

def load_ohlcv(data_dir: str, symbol: str) -> list:
    """Load OHLCV bars from the cache file."""
    path = os.path.join(data_dir, "ohlcv", f"{symbol.upper()}-1d.json")
    if not os.path.exists(path):
        return []
    with open(path, "r") as f:
        bars = json.load(f)
    # Each bar: {t: unix_ms, o, h, l, c, v}
    return sorted(bars, key=lambda b: b["t"])


def bars_in_range(bars: list, start_date: str, end_date: str) -> list:
    start_ts = datetime.strptime(start_date, "%Y-%m-%d").timestamp() * 1000
    end_ts = (datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)).timestamp() * 1000
    return [b for b in bars if start_ts <= b["t"] < end_ts]


def estimate_iv(bars: list, window: int = 30) -> list:
    """Estimate historical vol (annualized) for each bar using a trailing window of log returns."""
    if len(bars) < 2:
        return [0.20] * len(bars)
    ivs = []
    closes = [b["c"] for b in bars]
    log_returns = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))]
    for i in range(len(bars)):
        start = max(0, i - window)
        window_returns = log_returns[max(0, start - 1):i]
        if len(window_returns) < 5:
            ivs.append(0.20)
        else:
            mean = sum(window_returns) / len(window_returns)
            variance = sum((r - mean) ** 2 for r in window_returns) / (len(window_returns) - 1)
            iv = math.sqrt(variance * 252)
            ivs.append(max(0.05, min(iv, 2.0)))
    return ivs


# ─── Cost model ───────────────────────────────────────────────────────────────

COMMISSION_PER_CONTRACT = 0.65  # USD
SLIPPAGE_BPS = 5  # basis points of notional


def trade_cost(premium: float, contracts: int, cost_model: str) -> float:
    if cost_model == "zero":
        return 0.0
    commission = COMMISSION_PER_CONTRACT * contracts
    slippage = premium * 100 * contracts * SLIPPAGE_BPS / 10000
    return commission + slippage


# ─── Performance metrics ──────────────────────────────────────────────────────

def compute_metrics(equity_curve: list, trades: list, initial_capital: float) -> dict:
    if not equity_curve or len(equity_curve) < 2:
        return {"annualized_return": 0.0, "sharpe_ratio": 0.0, "max_drawdown": 0.0, "total_trades": 0}

    returns = [(equity_curve[i] / equity_curve[i - 1]) - 1 for i in range(1, len(equity_curve))]
    daily_returns = [r for r in returns if r != 0]

    final = equity_curve[-1]
    n_days = len(equity_curve) - 1
    years = n_days / 252

    annualized_return = (final / initial_capital) ** (1 / max(years, 0.01)) - 1

    if len(daily_returns) >= 2:
        mean_ret = sum(daily_returns) / len(daily_returns)
        variance = sum((r - mean_ret) ** 2 for r in daily_returns) / (len(daily_returns) - 1)
        std = math.sqrt(variance)
        sharpe = (mean_ret / std) * math.sqrt(252) if std > 0 else 0.0
        downside = [r for r in daily_returns if r < 0]
        if downside:
            down_var = sum(r ** 2 for r in downside) / len(downside)
            sortino = (mean_ret / math.sqrt(down_var)) * math.sqrt(252) if down_var > 0 else 0.0
        else:
            sortino = float("inf")
    else:
        sharpe = 0.0
        sortino = 0.0

    # Max drawdown
    peak = equity_curve[0]
    max_dd = 0.0
    for v in equity_curve:
        if v > peak:
            peak = v
        dd = (v - peak) / peak
        if dd < max_dd:
            max_dd = dd

    calmar = annualized_return / abs(max_dd) if max_dd != 0 else 0.0

    pnls = [t.get("pnl", 0) for t in trades]
    win_rate = sum(1 for p in pnls if p > 0) / len(pnls) if pnls else 0.0
    total_costs = sum(t.get("cost", 0) for t in trades)
    total_cost_bps = (total_costs / initial_capital) * 10000

    return {
        "annualized_return": round(annualized_return, 4),
        "sharpe_ratio": round(sharpe, 3),
        "sortino_ratio": round(sortino, 3),
        "calmar_ratio": round(calmar, 3),
        "max_drawdown": round(max_dd, 4),
        "win_rate": round(win_rate, 3),
        "total_trades": len(trades),
        "total_costs_bps": round(total_cost_bps, 1),
        "initial_capital": initial_capital,
        "final_equity": round(equity_curve[-1], 2),
    }


def rolling_windows(equity_curve: list, dates: list) -> dict:
    result = {}
    n = len(equity_curve)
    for label, days in [("1y", 252), ("3y", 756), ("5y", 1260)]:
        if n > days:
            sub = equity_curve[-days:]
            ret = (sub[-1] / sub[0]) ** (252 / days) - 1
            rets = [(sub[i] / sub[i - 1]) - 1 for i in range(1, len(sub))]
            if len(rets) >= 2:
                mean = sum(rets) / len(rets)
                var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
                sharpe = (mean / math.sqrt(var)) * math.sqrt(252) if var > 0 else 0.0
            else:
                sharpe = 0.0
            result[label] = {"return": round(ret, 4), "sharpe": round(sharpe, 3)}
    return result


def regime_breakdown(equity_curve: list, ivs: list, trades_by_date: dict) -> dict:
    if not ivs:
        return {}
    median_iv = sorted(ivs)[len(ivs) // 2]
    high_vol_trades = [t for t in trades_by_date.values() if t.get("iv", 0) >= median_iv]
    low_vol_trades = [t for t in trades_by_date.values() if t.get("iv", 0) < median_iv]

    def regime_metrics(trade_list: list) -> dict:
        if not trade_list:
            return {}
        pnls = [t.get("pnl", 0) for t in trade_list]
        return {
            "trades": len(trade_list),
            "total_pnl": round(sum(pnls), 2),
            "win_rate": round(sum(1 for p in pnls if p > 0) / len(pnls), 3),
        }

    return {
        "high_vol": regime_metrics(high_vol_trades),
        "low_vol": regime_metrics(low_vol_trades),
    }


def stress_scenarios(equity_curve: list, dates: list) -> dict:
    scenarios = {
        "covid_crash": ("2020-02-01", "2020-03-31"),
        "2022_rate_hike": ("2022-01-01", "2022-12-31"),
        "2018_vol_spike": ("2018-01-01", "2018-12-31"),
    }
    result = {}
    for name, (start, end) in scenarios.items():
        idx_start = next((i for i, d in enumerate(dates) if d >= start), None)
        idx_end = next((i for i, d in enumerate(dates) if d > end), len(dates))
        if idx_start is not None and idx_end > idx_start:
            sub = equity_curve[idx_start:idx_end]
            if len(sub) >= 2:
                ret = (sub[-1] / sub[0]) - 1
                peak = sub[0]
                max_dd = 0.0
                for v in sub:
                    if v > peak:
                        peak = v
                    dd = (v - peak) / peak
                    if dd < max_dd:
                        max_dd = dd
                result[name] = {
                    "return": round(ret, 4),
                    "max_drawdown": round(max_dd, 4),
                    "dates": f"{start} to {end}",
                }
    return result


# ─── Strategy simulators ──────────────────────────────────────────────────────

def simulate_covered_call(bars: list, ivs: list, params: dict, initial_capital: float, cost_model: str) -> tuple:
    """Simulate covered call: hold 100 shares, sell monthly OTM call."""
    delta_target = params.get("delta_target", 0.25)
    dte_target = params.get("dte_target", 30)
    profit_target_pct = params.get("profit_target_pct", 80) / 100
    r = 0.05  # risk-free rate approximation

    equity_curve = [initial_capital]
    trades = []
    trade_iv_map = {}

    if not bars:
        return equity_curve, trades, trade_iv_map

    shares_per_contract = 100
    n_contracts = int(initial_capital / (bars[0]["c"] * shares_per_contract))
    if n_contracts < 1:
        n_contracts = 1

    # State
    stock_position = n_contracts * shares_per_contract
    cash = initial_capital - stock_position * bars[0]["c"]
    short_call = None  # {"strike": K, "entry_premium": p, "expiry_idx": i, "iv": iv}

    cycle_days = max(dte_target - 5, 7)
    next_entry_idx = 0

    for i, bar in enumerate(bars):
        S = bar["c"]
        iv = ivs[i] if i < len(ivs) else 0.20
        T_today = 0.0

        # Close expiring / profitable call
        if short_call is not None:
            days_left = short_call["expiry_idx"] - i
            T_remaining = max(days_left / 365, 0.001)
            current_call = black_scholes_price(S, short_call["strike"], T_remaining, r, iv, "call")
            current_premium = current_call["price"]

            close_call = False
            if days_left <= 1:
                close_call = True  # Expiry
            elif current_premium <= short_call["entry_premium"] * (1 - profit_target_pct):
                close_call = True  # Profit target hit

            if close_call:
                pnl = (short_call["entry_premium"] - current_premium) * 100 * n_contracts
                cost = trade_cost(current_premium, n_contracts, cost_model)
                cash += pnl - cost
                trades.append({
                    "date": datetime.utcfromtimestamp(bar["t"] / 1000).strftime("%Y-%m-%d"),
                    "action": "close",
                    "ticker": "call",
                    "structure": "covered_call",
                    "pnl": round(pnl, 2),
                    "cost": round(cost, 2),
                    "iv": round(short_call["iv"], 3),
                })
                trade_iv_map[i] = {"pnl": pnl, "iv": short_call["iv"]}
                short_call = None
                next_entry_idx = i + 1

        # Open new call
        if short_call is None and i >= next_entry_idx:
            T_open = dte_target / 365
            K = find_strike_for_delta(S, T_open, r, iv, delta_target, "call")
            call_price = black_scholes_price(S, K, T_open, r, iv, "call")
            entry_premium = call_price["price"]
            cost = trade_cost(entry_premium, n_contracts, cost_model)
            cash += entry_premium * 100 * n_contracts - cost
            short_call = {
                "strike": K,
                "entry_premium": entry_premium,
                "expiry_idx": i + dte_target,
                "iv": iv,
            }
            trades.append({
                "date": datetime.utcfromtimestamp(bar["t"] / 1000).strftime("%Y-%m-%d"),
                "action": "open",
                "ticker": "call",
                "structure": "covered_call",
                "pnl": 0.0,
                "cost": round(cost, 2),
                "iv": round(iv, 3),
            })
            next_entry_idx = i + cycle_days

        # Mark-to-market portfolio
        stock_value = stock_position * S
        call_liability = 0.0
        if short_call is not None:
            days_left = short_call["expiry_idx"] - i
            T_remaining = max(days_left / 365, 0.001)
            call_liability = black_scholes_price(S, short_call["strike"], T_remaining, r, iv, "call")["price"] * 100 * n_contracts

        portfolio_value = cash + stock_value - call_liability
        equity_curve.append(max(portfolio_value, 0))

    return equity_curve, trades, trade_iv_map


def simulate_put_write(bars: list, ivs: list, params: dict, initial_capital: float, cost_model: str) -> tuple:
    """Simulate cash-secured put write."""
    delta_target = params.get("delta_target", 0.20)
    dte_target = params.get("dte_target", 30)
    profit_target_pct = params.get("profit_target_pct", 80) / 100
    r = 0.05

    equity_curve = [initial_capital]
    trades = []
    trade_iv_map = {}

    if not bars:
        return equity_curve, trades, trade_iv_map

    cash = initial_capital
    short_put = None
    next_entry_idx = 0
    cycle_days = max(dte_target - 5, 7)
    reserved_cash = 0.0  # cash reserved to cover put assignment

    for i, bar in enumerate(bars):
        S = bar["c"]
        iv = ivs[i] if i < len(ivs) else 0.20

        # Close expiring / profitable put
        if short_put is not None:
            days_left = short_put["expiry_idx"] - i
            T_remaining = max(days_left / 365, 0.001)
            current_put = black_scholes_price(S, short_put["strike"], T_remaining, r, iv, "put")
            current_premium = current_put["price"]

            close_put = False
            if days_left <= 1:
                # Check if assigned
                if S < short_put["strike"]:
                    # Assigned: buy shares at strike
                    assignment_cost = short_put["strike"] * 100
                    pnl = (short_put["entry_premium"] - current_premium) * 100 - assignment_cost + S * 100
                    cash += pnl - trade_cost(current_premium, 1, cost_model)
                else:
                    pnl = short_put["entry_premium"] * 100
                    cash += pnl - trade_cost(current_premium, 1, cost_model)
                close_put = True
            elif current_premium <= short_put["entry_premium"] * (1 - profit_target_pct):
                pnl = (short_put["entry_premium"] - current_premium) * 100
                cash += pnl - trade_cost(current_premium, 1, cost_model)
                close_put = True

            if close_put:
                trade_pnl = cash - (initial_capital + sum(t.get("pnl", 0) for t in trades))
                trades.append({
                    "date": datetime.utcfromtimestamp(bar["t"] / 1000).strftime("%Y-%m-%d"),
                    "action": "close",
                    "ticker": "put",
                    "structure": "put_write",
                    "pnl": round((short_put["entry_premium"] - current_premium) * 100, 2),
                    "cost": round(trade_cost(current_premium, 1, cost_model), 2),
                    "iv": round(short_put["iv"], 3),
                })
                trade_iv_map[i] = {"pnl": trades[-1]["pnl"], "iv": short_put["iv"]}
                reserved_cash = 0.0
                short_put = None
                next_entry_idx = i + 1

        # Open new put
        if short_put is None and i >= next_entry_idx:
            T_open = dte_target / 365
            K = find_strike_for_delta(S, T_open, r, iv, delta_target, "put")
            put_price = black_scholes_price(S, K, T_open, r, iv, "put")
            entry_premium = put_price["price"]
            cost = trade_cost(entry_premium, 1, cost_model)
            reserved_cash = K * 100  # cash-secured
            if cash >= reserved_cash:
                cash += entry_premium * 100 - cost
                short_put = {"strike": K, "entry_premium": entry_premium, "expiry_idx": i + dte_target, "iv": iv}
                trades.append({
                    "date": datetime.utcfromtimestamp(bar["t"] / 1000).strftime("%Y-%m-%d"),
                    "action": "open",
                    "ticker": "put",
                    "structure": "put_write",
                    "pnl": 0.0,
                    "cost": round(cost, 2),
                    "iv": round(iv, 3),
                })
                next_entry_idx = i + cycle_days

        equity_curve.append(max(cash, 0))

    return equity_curve, trades, trade_iv_map


def simulate_generic(bars: list, equity_curve_base: list, initial_capital: float) -> tuple:
    """Fallback: return flat equity curve with a note."""
    return [initial_capital] * (len(bars) + 1), [], {}


SIMULATORS = {
    "covered_call": simulate_covered_call,
    "put_write": simulate_put_write,
    "collar": simulate_covered_call,      # Simplified: treat collar like covered call for now
    "calendar_spread": simulate_put_write,  # Simplified: treat like put write for now
}


# ─── Main ─────────────────────────────────────────────────────────────────────

def run(input_data: dict) -> dict:
    job_id = input_data.get("job_id", "unknown")
    spec = input_data["strategy_spec"]
    start_date = input_data["start_date"]
    end_date = input_data.get("end_date", date.today().strftime("%Y-%m-%d"))
    data_dir = input_data.get("data_dir", "")
    initial_capital = float(input_data.get("initial_capital", 100000))
    cost_model = input_data.get("cost_model", "default")

    structure = spec.get("structure", "custom")
    universe = spec.get("universe", [])
    params = spec.get("default_parameters", {})
    strategy_id = spec.get("strategy_id", "unknown")

    if not universe:
        return {"job_id": job_id, "strategy_id": strategy_id, "status": "error", "error": "universe is empty"}

    ticker = universe[0]
    bars = load_ohlcv(data_dir, ticker)
    bars_range = bars_in_range(bars, start_date, end_date)

    if len(bars_range) < 20:
        return {
            "job_id": job_id,
            "strategy_id": strategy_id,
            "status": "needs_more_data",
            "error": f"Insufficient data for {ticker}: {len(bars_range)} bars in range. Run get_historical_ohlcv first.",
            "period": {"start": start_date, "end": end_date},
        }

    ivs = estimate_iv(bars_range)
    simulator = SIMULATORS.get(structure)

    if simulator is None:
        return {"job_id": job_id, "strategy_id": strategy_id, "status": "error", "error": f"Unsupported structure: {structure}"}

    equity_curve, trades, trade_iv_map = simulator(bars_range, ivs, params, initial_capital, cost_model)

    dates = [datetime.utcfromtimestamp(b["t"] / 1000).strftime("%Y-%m-%d") for b in bars_range]
    metrics = compute_metrics(equity_curve, trades, initial_capital)
    metrics["turnover_annual"] = round(len(trades) / max((len(bars_range) / 252), 0.01), 1)

    # Determine status: simple heuristics
    if metrics["sharpe_ratio"] >= 0.8 and metrics["max_drawdown"] > -0.25:
        status = "approved"
    elif metrics["sharpe_ratio"] < 0.3 or metrics["max_drawdown"] < -0.40:
        status = "rejected"
    else:
        status = "needs_more_data"

    weaknesses = []
    if metrics["max_drawdown"] < -0.20:
        weaknesses.append(f"High drawdown of {metrics['max_drawdown']:.1%}")
    if metrics["total_trades"] < 10:
        weaknesses.append("Low trade count — results may not be statistically significant")
    if len(bars_range) < 252:
        weaknesses.append("Less than 1 year of data — walk-forward validation recommended")

    return {
        "job_id": job_id,
        "strategy_id": strategy_id,
        "status": status,
        "period": {"start": start_date, "end": end_date},
        "metrics": metrics,
        "regime_breakdown": regime_breakdown(equity_curve, ivs, trade_iv_map),
        "stress_results": stress_scenarios(equity_curve, dates),
        "rolling_windows": rolling_windows(equity_curve, dates),
        "weaknesses": weaknesses,
        "assumptions": {
            "slippage_bps": SLIPPAGE_BPS if cost_model != "zero" else 0,
            "commission_per_contract": COMMISSION_PER_CONTRACT if cost_model != "zero" else 0.0,
            "iv_source": "historical_volatility_30d",
        },
        "trade_log": trades[:100],  # Cap trade log at 100 entries for response size
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"status": "error", "error": "Usage: backtest_runner.py <input.json> [output.json]"}))
        sys.exit(1)

    with open(sys.argv[1], "r") as f:
        input_data = json.load(f)

    # Support function-dispatch envelope used by engine-runner.ts
    if "function" in input_data and "params" in input_data:
        input_data = input_data["params"]

    result = run(input_data)
    output = json.dumps(result, indent=2)

    if len(sys.argv) >= 3:
        with open(sys.argv[2], "w") as f:
            f.write(output)
    else:
        print(output)

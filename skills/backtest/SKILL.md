---
name: backtest
description: Design, run, and interpret strategy backtests with parameter sweeps
metadata:
  openclaw:
    emoji: "\U0001F9EA"
---

# Backtesting Strategies

Use this skill when designing, running, or interpreting backtests.

## Workflow

### 1. Define the Strategy

Use `strategy_template_lookup` to find a matching template, or build a custom spec. Validate with `strategy_spec_validator`.

A strategy spec includes:
- `strategy_id`: unique identifier
- `universe`: list of symbols
- `structure`: strategy type (e.g. "covered-call", "put-write", "long-only")
- `legs`: option leg definitions (if applicable)
- `entry_rules` / `exit_rules`: conditions for entering/exiting
- `objective`: what the strategy aims to achieve

### 2. Run the Backtest

Use `run_backtest` with the strategy spec and date range. The engine runs on Nautilus Trader (Python).

For parameter exploration, use `parameter_sweep` to test across ranges of key inputs (e.g. strike offset, DTE, position size).

### 3. Interpret Results

Use `get_backtest_results` to retrieve metrics. Key metrics to evaluate:

| Metric | Good | Warning |
|--------|------|---------|
| Sharpe Ratio | > 1.0 | < 0.5 |
| Max Drawdown | < 15% | > 25% |
| Win Rate | > 55% | < 45% |
| Calmar Ratio | > 1.0 | < 0.5 |

### 4. Compare Variants

Use `compare_backtests` to compare multiple runs side-by-side.

### 5. Stress Test

Before paper trading, run `stress_test_scenario` against historical events (2008 GFC, 2020 COVID, 2022 rate hikes) to understand tail risk.

## Historical Data Sources

- US equities: Alpaca IEX (cached locally, free)
- International equities: IBKR historical bars (up to 10 years) or yfinance
- Use `get_historical_ohlcv` — the symbol router picks the best source automatically

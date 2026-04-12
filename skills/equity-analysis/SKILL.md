---
name: equity-analysis
description: Analyze equities using the Stoic Return Decomposition framework (C + G + V)
metadata:
  openclaw:
    emoji: "\U0001F4CA"
---

# Equity Analysis — Stoic Return Decomposition

Use this skill when asked to analyze a stock, compare securities, or evaluate an investment thesis.

## Framework

Decompose expected returns into three components:

```
E(R) = C + (1 + G)(1 + V) - 1
```

- **C** = Cashflow return (dividend yield)
- **G** = Intrinsic growth (EPS growth rate)
- **V** = Multiple change (P/E expansion or contraction)

## Data Gathering

1. **Current price & fundamentals**: `get_stock_quote` for price, then calculate yield from `get_dividend_history`
2. **Historical context**: `get_historical_ohlcv` for price history (supports US via Alpaca, global via IBKR)
3. **Options-implied view**: `get_options_chain` + `get_iv_surface` for market's risk pricing
4. **Macro context**: `get_risk_free_rate` for discount rate, `get_economic_calendar` for upcoming events

## Analysis Steps

1. Compute **C**: TTM dividends / current price
2. Estimate **G**: Use historical EPS growth, analyst consensus, or revenue growth as proxy
3. Estimate **V**: Current P/E vs 5-year average P/E, derive implied multiple change
4. Calculate **E(R)** and present in structured table
5. Flag if V is the dominant driver — this is a sustainability warning
6. Compare E(R) to risk-free rate to assess risk premium

## Output Format

Always present results as a structured table:

```
| Component | Value | Source |
|-----------|-------|--------|
| C (Dividend Yield) | X.X% | TTM dividends / price |
| G (EPS Growth) | X.X% | [source] |
| V (Multiple Change) | X.X% | Current P/E → 5Y avg |
| **E(R)** | **X.X%** | C + (1+G)(1+V) - 1 |
```

## International Equities

For non-US symbols (e.g. 0941.HK, BATS.L, 7203.T):
- Market data routes through IBKR (delayed, but covers all exchanges)
- Dividend data comes from yfinance
- Be aware of currency differences — note the reporting currency in your analysis

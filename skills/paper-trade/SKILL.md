---
name: paper-trade
description: Execute paper trades on IBKR — order workflow, position checks, and risk guardrails
metadata:
  openclaw:
    emoji: "\U0001F4B9"
---

# Paper Trading on IBKR

Use this skill when submitting, managing, or reviewing paper trades.

## Order Workflow

1. **Pre-trade checks**:
   - Verify the symbol exists: use `paper_get_quote` to confirm IBKR can resolve it
   - Check current positions: use `paper_get_positions` to avoid unintended doubling
   - Check risk limits: use `get_risk_config` and `check_position_limits`

2. **Submit the order**:
   - Use `paper_submit_order` with a `strategy_id` to tag the trade
   - Always confirm with the user before executing — present symbol, side, quantity, order type, and estimated notional
   - Market orders (`order_type: "market"`) fill immediately during market hours
   - Limit orders (`order_type: "limit"`) require a `limit_price`

3. **Post-trade verification**:
   - Use `paper_get_order_history` to confirm fill status
   - Use `paper_get_positions` to verify the position appeared
   - Use `paper_get_pnl` to check account-level impact

## IBKR Market Hours

Paper trading follows real exchange hours. Orders submitted outside hours will queue until the next session opens.

- US equities: 09:30–16:00 ET (pre-market 04:00, after-hours until 20:00)
- HK equities: 09:30–16:00 HKT
- London equities: 08:00–16:30 GMT

## Strategy Tagging

Every order must include a `strategy_id`. This is embedded in IBKR's `cOID` (customer order ID) field for tracking. Use consistent IDs like `covered-call-aapl`, `put-write-spy`, etc.

## Risk Guardrails

Before any trade, check:
- Kill switch is not active (`get_risk_config`)
- Position notional doesn't exceed `max_position_notional`
- Single-name weight stays under `max_single_name_weight_pct`
- Portfolio VaR is within limits (`calculate_portfolio_var`)

If any limit is breached, **do not execute** — explain the breach and ask the user how to proceed.

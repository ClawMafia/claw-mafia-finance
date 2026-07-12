---
name: ibkr-setup
description: Set up and troubleshoot the IBKR paper trading connection via ibeam gateway
metadata:
  openclaw:
    emoji: "\U0001F527"
---

# IBKR Setup & Troubleshooting

Use this skill when setting up or debugging the IBKR paper trading connection.

## Prerequisites

- An IBKR paper trading account (username usually starts with `DU`)
- ibeam gateway running (Docker or Railway)
- 2FA / Secure Login System disabled for the paper account in IBKR Account Management

## Local Setup (Docker)

```bash
docker run -d \
  --name ibeam \
  -p 5000:5000 \
  -e IBEAM_ACCOUNT=<username> \
  -e IBEAM_PASSWORD=<password> \
  -e IBEAM_GATEWAY_TYPE=paper \
  voyz/ibeam
```

Then set `ibkrGatewayUrl` to `https://localhost:5000` in the plugin config.

## Railway Deployment

Both ibeam and OpenClaw must be in the same Railway project for internal networking.
The gateway URL is `https://ibeam.railway.internal:5000`.

Environment variables on the ibeam service:
- `IBEAM_ACCOUNT` — paper trading username
- `IBEAM_PASSWORD` — paper trading password
- `IBEAM_GATEWAY_TYPE=paper`

## Diagnostic Steps

1. **Check auth status** — use the `ibkr_auth_status` tool
   - `authenticated: true` = good
   - `authenticated: false` = ibeam can't log in; check credentials and 2FA settings
   - Connection refused = ibeam container not running or wrong URL

2. **Check keepalive** — look for `ibkr-keepalive: tickle OK` in logs
   - If you see `not authenticated` warnings, the session expired or credentials are wrong

3. **Common issues**:
   - "competing session" — another client (TWS, another ibeam) is logged in. Only one session per account.
   - Empty market data — first snapshot call primes the feed; the tool retries automatically after 1.5s
   - Order rejected — check if market is open; paper trading follows real market hours

## Full trade history — Flex Web Service setup

The TWS socket only serves the current day plus a ~7-day rolling window of fills
(`ibkr_get_recent_executions`). For **full lifetime trade history**, use the
Flex Web Service via `ibkr_get_trade_history`. Flex is a separate HTTPS report
API — it needs no running gateway, just a token and a query id created once in
Client Portal. This is a one-time account-config step the operator must do (the
agent cannot do it).

### One-time setup in Client Portal

1. **Create the Flex Query**
   - Client Portal → **Performance & Reports → Flex Queries**.
   - Under **Activity Flex Query**, click **Create** (the `+`).
   - Name it e.g. `clawmafia-trades`. In **Sections**, enable **Trades** and tick
     at minimum: `Symbol`, `Buy/Sell`, `Quantity`, `TradePrice`, `TradeDate`,
     `DateTime`, `AssetClass`, `Put/Call`, `Strike`, `Expiry`, `Proceeds`,
     `IBCommission`, `FifoPnlRealized`, `Currency`, `Exchange`, `Conid`,
     `TradeID`, `IBOrderID`. (Extra fields are harmless; the parser ignores
     unknown attributes.)
   - Format: **XML**. Save. Note the **Query ID** (a number).

2. **Enable the Flex Web Service token**
   - Client Portal → **Settings → Account Settings → Flex Web Service** (under
     Reporting). Enable it and generate a **token**. Tokens last ~1 year — set a
     reminder to rotate.

3. **Wire it into the plugin** — add to `.env`:
   ```
   IBKR_FLEX_TOKEN=<the token>
   IBKR_FLEX_QUERY_ID=<the query id>
   ```
   `run-local.sh` maps these into the plugin config (`ibkrFlexToken`,
   `ibkrFlexQueryId`). Restart so the config bootstrap picks them up.

### Using it

- `ibkr_get_trade_history` runs the configured query and returns normalized
  rows (symbol, side, signed quantity, price, date, asset type, option
  strike/put-call/expiry, commission, realized PnL). Pass `query_id` to override
  the default query.
- The Flex API generates the report asynchronously; the client polls for up to
  60s while IBKR builds it (codes 1009/1018/1019 = "not ready, retrying").
- One Activity Flex query covers up to **365 days**. For multi-year history,
  create per-year queries (or date-ranged ones) and call with `query_id` each.

### Flex troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Flex token not configured` | `IBKR_FLEX_TOKEN` not set / not synced — restart after editing `.env` |
| `1012 Token has expired` | Regenerate the token in Client Portal (~1-year expiry) |
| `1020 Invalid request` | Wrong/disabled query id, or query not owned by this account |
| `count: 0` but trades exist | Query's **Trades** section not enabled, or date range excludes them |
| Times out after 60s | IBKR slow to generate; retry, or raise `maxWaitMs` in `FlexClient` |

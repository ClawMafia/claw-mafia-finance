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

1. **Check auth status** — use the `paper_auth_status` tool
   - `authenticated: true` = good
   - `authenticated: false` = ibeam can't log in; check credentials and 2FA settings
   - Connection refused = ibeam container not running or wrong URL

2. **Check keepalive** — look for `ibkr-keepalive: tickle OK` in logs
   - If you see `not authenticated` warnings, the session expired or credentials are wrong

3. **Common issues**:
   - "competing session" — another client (TWS, another ibeam) is logged in. Only one session per account.
   - Empty market data — first snapshot call primes the feed; the tool retries automatically after 1.5s
   - Order rejected — check if market is open; paper trading follows real market hours

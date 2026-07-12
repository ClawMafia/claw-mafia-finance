# Trade Journals — Implementation Plan

Foundation for the trading-journal / ledger system, built inside
`claw-mafia-finance`. Spec source of truth (Obsidian vault):

- `ClawMafia/developers/Design/trade-journals/Trading Journals Data Schema.md`
- `ClawMafia/developers/Design/trade-journals/Trading Journals Storage Architecture.md`
- `ClawMafia/developers/Design/trade-journals/TradingJournalsAgentSkill.md`

## Settled design decisions

1. **Account-agnostic, not "paper".** Paper vs. live is entirely external to this
   package — it's a function of which gateway (`IBKR_HOST`/`IBKR_PORT`) we connect
   to, the account id (`DU…`/`DF…` = paper, `U…` = live), and the per-account Flex
   token/query. No code "mode". The ledger is **account-scoped** so paper and live
   never commingle.
2. **DB location:** `${stateDir}/finance/ledger.sqlite`, where `stateDir =
   api.runtime.state.resolveStateDir()` (the `~/.openclaw` state dir,
   `OPENCLAW_STATE_DIR`-overridable, volume-mounted in the container). Optional
   `ledgerDbPath` config override. Not the vault, not `dataDir` (that's
   regenerable market-data cache).
3. **Reasoning is a DB column, not vault notes.** Mutable `reasoning TEXT` on the
   trade row, keyed by broker `trade_id`. Git and markdown journals are out of the
   data path (07-11 decision).
4. **Tool rename:** IBKR tool identifiers `paper_*` → `ibkr_*` (account-neutral).

## The rename (`paper_*` → `ibkr_*`)

| Old | New |
|---|---|
| `paper_submit_order` | `ibkr_submit_order` |
| `paper_cancel_order` | `ibkr_cancel_order` |
| `paper_get_positions` | `ibkr_get_positions` |
| `paper_get_pnl` | `ibkr_get_pnl` |
| `paper_get_order_history` | `ibkr_get_order_history` |
| `paper_get_recent_executions` | `ibkr_get_recent_executions` |
| `paper_get_trade_history` | `ibkr_get_trade_history` |
| `paper_get_quote` | `ibkr_get_quote` |
| `paper_reconnect` | `ibkr_reconnect` |
| *(new)* | `ibkr_record_fills` |
| *(new)* | `ibkr_get_positions_book` |
| *(new)* | `attach_reasoning` |

**Scope: `claw-mafia-finance` package only** (narrowed — "simply the ibkr client").

Done (this increment):
- `src/tools/paper-trading.ts` → renamed to `src/tools/ibkr-trading.ts`; 9 tool
  ids `paper_*`→`ibkr_*`; `label` strings de-"Paper"-ed; `registerPaperTradingTools`
  → `registerIbkrTradingTools`; import fixed in `src/index.ts`.
- `src/bootstrap/config.ts` — agent tool allowlists.
- `openclaw.plugin.json` — tool allowlist.
- `skills/trade-journal|paper-trade|ibkr-api-direct|ibkr-setup/SKILL.md`.
- Typecheck passes.

Deliberately NOT touched (out of the package; stale `paper_*` refs remain —
follow-up if/when desired): repo-root `subagents/equity_researcher/subagent.json`,
`docs/AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/SUBAGENT-BOOTSTRAP.md`,
`docs/TOOLS.md`.

**Explicitly NOT renamed (different concepts):**

- Alpaca `paper-api.alpaca.markets` / `alpaca_paper` (`alpaca-client.ts`) — a
  different broker's genuine paper endpoint.
- `paper-broker-client.ts` / `paper_broker.py` — separate Python sim-broker engine.
- `PAPER_TRADING_AGENT_ID = "paper-trading"`, `paperEntry`, the `#paper-trading`
  Discord channel (`config.ts`) — operator/agent infrastructure, not the package's
  tool surface. **Needs operator sign-off before any rename** (Discord routing +
  deployed config).
- `paperAccountCapital` config key — dropped (capital is `ibkr_get_pnl` NLV).

## Phase 1 — the foundation ✅ SHIPPED

Implemented and verified (typecheck + `npm test` 10/10 + build). Files:
`src/data/ledger-store.ts`, `src/data/flex-mapper.ts`, `src/data/flex-client.ts`
(+`account_id`), `src/tools/review.ts` (3 new tools), `src/index.ts`+`src/types.ts`
(store in ctx), `openclaw.plugin.json`+`src/bootstrap/config.ts` (config+allowlists),
`test/flex-mapper.test.ts`, `test/ledger-store.test.ts`. The `positions` view
reconciles the `0941.HK` worked example to `total_return = 453,000`.

Original task breakdown:

1. **Dependency:** add `better-sqlite3` (+ `@types/better-sqlite3` dev).
2. **`src/data/ledger-store.ts`** — `LedgerStore` service: open
   `${stateDir}/finance/ledger.sqlite`, WAL + foreign_keys pragmas,
   `schema_version` + idempotent migrations. Tables carry **`account_id TEXT`**.
   Methods: `upsertEquityTrade`, `upsertOptionTrade`, `upsertCashflow`,
   `setReasoning(tradeId, text)`, `upsertMarketPrice`, `getPositions(accountId?)`,
   `getTrade(tradeId)`. `positions` VIEW groups by **`(account_id, symbol)`**.
   Portable SQL for the Postgres upgrade path.
3. **`src/data/flex-mapper.ts`** — pure `flexTradeToRow(FlexTrade[]) →
   {equity_rows, option_rows}`. Routes on `asset_category` (STK/OPT), preserves
   signed qty, `commission→fee` (null→0), `put_call→put/call`, ISO expiry, carries
   `account_id`. Guards empty-`trade_id` (fallback to `ibExecID`, else
   deterministic hash) with a warning.
4. **`src/data/flex-client.ts`** — add `accountId` to `FlexTrade` + `normalizeTrade`
   (`pick(a, "accountId")`), so fills are account-scoped end to end.
5. **Wiring** — construct one `LedgerStore` in `src/index.ts`, add `store` +
   `stateDir` to `PluginContext` (`src/types.ts`); add `ledgerDbPath?` to
   `FinancePluginConfig` + `openclaw.plugin.json` configSchema.
6. **Tools (replace `src/tools/review.ts` stubs):**
   - `ibkr_record_fills` — `getTrades(query_id?)` → `flexTradeToRow` → upsert on
     `trade_id`. Returns `{inserted, skipped, total}`. Idempotent reconcile/backstop.
   - `attach_reasoning` — `UPDATE … SET reasoning=? WHERE trade_id=?`.
   - `ibkr_get_positions_book` — read the `positions` view.
   - `generate_daily_report` / `compare_thesis_vs_actual` stay stubs, pointed at
     the store.
7. **Tests (`test/`):** mapper (routing, sign, empty-id fallback, account_id);
   store on `:memory:` (upsert idempotency, `0941.HK` positions math →
   `total_return = 453,000`, reasoning round-trip, account scoping isolates books).

## Deferred (Phase 2+)

- Real-time exec-callback capture (`execDetails`/`commissionReport` persistent
  listener inserting rows at fill time).
- `FlexClient.getCashTransactions()` + `ibkr_record_cashflows` (dividend/coupon/
  interest/roll).
- Ingestion job + `rebuild_account_views` → `dashboard.md`.
- Cron sweep / end-of-session batch scheduling.
- Adjusting layer (premium-adjusted basis, ×100 multiplier, annualized carry).
- Postgres (driver swap).
- Live-trading safety gate on `ibkr_submit_order` (explicit env opt-in /
  confirmation for non-paper account ids) — data layer stays agnostic; submission
  gets a thin policy guard.

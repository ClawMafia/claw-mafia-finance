---
name: trade-journal
description: Record every paper trade in the finance plugin's ledger database. Broker-authoritative fills come from IBKR Flex; you attach the reasoning (the why) keyed by the broker trade_id. Superstore for positions, P&L attribution, and daily review.
metadata:
  openclaw:
    emoji: "\U0001F4D3"
---

# Trade Journal — Ledger Database Recording

You record **every** paper trade in the finance plugin's **ledger database** — a
local SQLite store (`${OPENCLAW_STATE_DIR}/finance/ledger.sqlite`) that is the
structured system of record for fills, cashflows, and positions. This is
non-optional.

> [!important] Two things get recorded — keep them separate
> 1. **The numbers** (fills, fees, cashflows) — **authoritative, from IBKR**,
>    pulled via the Flex Web Service and **reconciled** into the ledger tables,
>    never hand-typed.
> 2. **The reasoning** (the *why*) — a mutable `reasoning` TEXT column on each
>    trade row, **written by you** right after the fill row exists.
>
> They are linked by the broker-issued **`trade_id`** (Flex `tradeID`). Never
> type fill prices/quantities from memory — record what you *intended*, then let
> the reconcile step fill the numbers from the broker.

## Canonical design docs (source of truth)

These live in the Obsidian vault and define the schema and storage model. Read
them if the convention is ever ambiguous:

- **`ClawMafia/developers/Design/trade-journals/Trading Journals Data Schema.md`**
  — the ledger fields, sign conventions, `premium`/`carry` bucketing, the
  derived Positions view.
- **`ClawMafia/developers/Design/trade-journals/Trading Journals Storage Architecture.md`**
  — how fills flow from Flex into the DB, the `trade_id` dedup key, the
  `reasoning` column, the tool surface.

> [!note] What changed (07-11)
> Git and markdown journal notes are **out of the data path**. Because Flex is a
> re-pullable source of truth for fills, reasoning moved from `.md` vault notes +
> git commits into a **mutable `reasoning` TEXT column** on the trade row. There
> are no journal files to write, no `git commit`, no LiveSync step.

## The data model (what you're writing into)

Four datasets in the ledger DB (see the Data Schema doc for full fields):

| Table | One row per | Key |
|---|---|---|
| `equity_trades` | equity execution | `trade_id` (PK) |
| `option_trades` | option execution | `trade_id` (PK) |
| `cashflow` | non-trade cash event (premium, dividend, coupon, interest, roll, fee) | `id` (PK) |
| `positions` (VIEW) | open symbol — **derived**, never written by hand | `symbol` |

Sign conventions (memorize these):

- **`quantity`** is signed: buy / long = **+**, sell / short = **−**.
- **Cash** is signed: received = **+**, paid = **−** (premium collected `+`, fees `−`).
- **`price`** is the raw IBKR price — **no ×100 option multiplier** (tracked raw, adjusted later).
- **Currency** is per-position native (HKD for `0941.HK`, USD for US names) — never mixed inside one position.

## The tools you have (finance plugin)

All live in `claw-mafia-finance`. Use these instead of hand-rolling `@stoqey/ib`
scripts:

| Tool | Use it for |
|---|---|
| `ibkr_submit_order` | Place an equity order (market/limit). Requires `strategy_id`. |
| `ibkr_cancel_order` | Cancel a pending order by `order_id`. |
| `ibkr_get_positions` | Live positions from IBKR (symbol, qty, avg cost, currency). |
| `ibkr_get_pnl` | Account summary: NLV, cash, buying power, unrealized/realized PnL. |
| `ibkr_get_order_history` | Open/recent orders + status. |
| `ibkr_get_recent_executions` | **Same-day** fills (TWS socket, ~7-day window). |
| `ibkr_get_trade_history` | **Full lifetime** fills via **Flex** — the fill authority. |
| `ibkr_get_quote` | Delayed market snapshot for a symbol. |
| `ibkr_reconnect` | Re-establish the TWS socket after a session eviction. |
| **`ibkr_record_fills`** | **Reconcile** Flex fills into the ledger DB (upsert on `trade_id`). Idempotent — safe to re-run. |
| **`attach_reasoning`** | Write the *why* into a trade row's `reasoning` column, keyed by `trade_id`. |
| **`ibkr_get_positions_book`** | Read the derived `positions` view from the ledger DB. |

> [!note] Same-day vs lifetime
> Right after a fill, `ibkr_get_recent_executions` is fastest (socket, instant).
> The canonical record — and anything older than ~7 days — is
> `ibkr_get_trade_history` (Flex), which `ibkr_record_fills` reconciles into the
> DB. Flex generates the report asynchronously and is polled up to ~60s, so it
> isn't instantaneous.

## The recording workflow (deterministic order)

For every position-changing trade (open / close / roll / hedge):

1. **Decide & draft the reasoning.** Before submitting, write out (for the
   operator, in Discord) the Context, thesis, trade-offs, and the exact order
   shape. This is the *why* you'll persist once the fill exists. Get explicit
   operator confirmation **before** placing the order.
2. **Submit the order.** `ibkr_submit_order` (records the IBKR `order_id`).
3. **Reconcile the fill into the ledger.** Once filled, run `ibkr_record_fills`
   — it pulls the authoritative fill(s) from Flex, maps them to ledger rows, and
   upserts keyed by `trade_id`. Never invent fill numbers; the broker supplies
   them. (Re-running is a no-op thanks to `ON CONFLICT(trade_id)`.)
4. **Attach the reasoning.** `attach_reasoning` with the `trade_id` and your
   write-up. Do this while the context is fresh — **reasoning is the one field
   the broker can't re-supply, so never leave it blank.**
5. **A roll = one logical trade.** Close-front + open-back is multiple fills
   sharing a strategy; attach reasoning to each leg (or the opening leg) but
   treat it as one decision.

> [!warning] Never leave reasoning silently blank
> A recorded fill without reasoning is a data-loss risk (facts re-pull from Flex;
> the *why* cannot). Steps 3–4 are one logical unit — always complete the
> reasoning after a fill row appears.

## What goes in the reasoning text

The `reasoning` column is prose — the honest record of the decision. Cover:

- **Context** — why this trade, now; state of positions before; market backdrop.
- **Thesis** — the decision rationale. If applying the Stoic Return
  Decomposition framework, decompose `E(R) = C + (1+G)(1+V) − 1`. For
  options/futures use the relevant framework (carry-and-roll, vol surface,
  calendar-spread economics).
- **Trade-offs** — alternatives weighed and rejected; why this order type, size, timing.
- **Lessons** (append later, dated) — what surprised you, what you'd change.

Write reasoning at decision time; do **not** rewrite the thesis after the fact
(honest record). New observations get appended as dated lessons.

## Source each number once

- Option **premium** is **derived from the option trade row** (`price ×
  quantity`) — do **not** also log it as a `premium` cashflow row, or `premium`
  double-counts.
- A fill's **commission** lives on its trade row's `fee` column, **not** also as
  a `fee` cashflow row. `carry` sums whichever place it lives.
- Non-trade cashflows (dividend / coupon / interest / roll) belong in the
  `cashflow` table only.

(See the Data Schema doc's "record each fee once" rule.)

## Reconcile cadence

`ibkr_record_fills` is idempotent and runs on three triggers, all converging to
the same rows:

- **After each fill** (you call it — freshness).
- **A periodic cron sweep** (safety net if you forget).
- **End-of-session batch** (close the day).

Because every pass upserts on `trade_id`, running any or all of them any number
of times is safe.

## Hard rules

1. **Never submit an order without having drafted the reasoning first.** Draft
   it, get operator confirmation in Discord, *then* call `ibkr_submit_order`.
   If placement fails, note it — no fill, no ledger row.
2. **Never type fill prices/quantities from memory.** Reconcile from Flex via
   `ibkr_record_fills`; the broker is the fill authority.
3. **Never leave a recorded fill without `reasoning`.** It's the only
   irreplaceable field.
4. **Never double-source premium or fees** (see above).
5. **Don't fabricate.** Every ledger row corresponds to a real IBKR fill with a
   real `order_id` and broker `trade_id`. No trade, no row.

## Discord output format

When you're about to place a trade, your Discord response should:

1. Show the operator a **summary** of the planned trade (symbol, side, qty,
   expected fill range, the JSON contract+order shape).
2. Show the **reasoning draft** you'll persist.
3. Ask: **"Proceed with placeOrder? (yes / no)"** and wait for an explicit reply.

After the order fills, post the `order_id` + `trade_id` + reconciled fill
numbers so the operator can follow along.

## Quick reference

| Action | Tool |
|---|---|
| Place order | `ibkr_submit_order` |
| Reconcile fills → ledger DB | `ibkr_record_fills` |
| Attach the *why* | `attach_reasoning` (keyed by `trade_id`) |
| Read positions book | `ibkr_get_positions_book` |
| Full fill history (Flex) | `ibkr_get_trade_history` |
| Same-day fills (socket) | `ibkr_get_recent_executions` |
| Account P&L | `ibkr_get_pnl` |

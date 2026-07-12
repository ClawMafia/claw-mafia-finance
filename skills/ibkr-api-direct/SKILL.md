---
name: ibkr-api-direct
description: Call IBKR's TWS API directly via Node scripts run through bash — for any IBKR operation the typed ibkr_* tools don't cover (futures, combos, contract lookups, custom queries).
metadata:
  openclaw:
    emoji: "\U0001F527"
---

# Direct IBKR TWS API via bash

The typed `ibkr_*` tools (ibkr_get_pnl, ibkr_get_quote, ibkr_submit_order, etc.) cover **equities only** and only the most common operations. For anything beyond — futures, options, combo/spread orders, contract resolution, market scanners, custom field queries — use this skill: write a short Node script and run it via `bash`.

## When to use this skill

Use this skill when:
- The user needs a **futures, options, FX, or bond** operation (typed tools are equity-only)
- The user needs a **combo / calendar spread / multi-leg** order (no typed tool exists)
- The user needs **contract resolution** (`reqContractDetails` to find a conId from symbol+expiry+exchange)
- The user wants raw output from a TWS API call that the typed wrappers don't expose
- The typed `ibkr_get_quote` returns nothing useful and you need to debug at the protocol level

Use the typed `ibkr_*` tools instead when:
- The operation is a simple US-equity quote / PnL / position read / order submit / cancel
- You want logged, auditable, fast invocations (200 ms vs 2–5 s per script)

## How to invoke

The IBKR TWS API listens on `localhost:4000`. The `@stoqey/ib` Node library is already installed inside `/home/gao288/workplace/clawMafia/claw-mafia-finance/node_modules`. **Node's ESM resolver finds the module relative to the script's location, not the CWD** — so the script file must live inside the plugin directory (where `node_modules/@stoqey/ib` exists), or you must use inline `-e` mode.

### Pattern A — inline (shortest, best for one-liners)

```bash
cd /home/gao288/workplace/clawMafia/claw-mafia-finance && node --input-type=module -e '
import { IBApi, EventName } from "@stoqey/ib";
// … script body …
'
```

### Pattern B — temp file inside the plugin dir (best for multi-line scripts)

```bash
cd /home/gao288/workplace/clawMafia/claw-mafia-finance
cat > ./.ibkr-task.mjs << 'SCRIPT_EOF'
import { IBApi, EventName, SecType, OrderAction, OrderType, TimeInForce } from "@stoqey/ib";
// … your script body …
SCRIPT_EOF
node ./.ibkr-task.mjs
rm -f ./.ibkr-task.mjs
```

The leading `.` keeps the file hidden so it doesn't pollute the plugin's file listing. Always delete the script when done.

**Do NOT** write the script to `/tmp` — that location has no `node_modules` and `@stoqey/ib` will fail to resolve.

## Hard rules — read these before writing any script

1. **Use a unique `clientId` in the range `1000–9999`**. The plugin's own `IBKRClient` uses random IDs in `100–999`. Using `0` evicts the plugin's connection. Two clients sharing the same id evict each other ("remove Client N" in gateway logs). Example: `new IBApi({ host: "127.0.0.1", port: 4000, clientId: 1234 })`.

2. **Orders require `transmit: true`** in the Order object. Without it, IBKR silently accepts the order as a draft and never forwards it to the exchange — no error, no fill, no events. Always set it.

3. **Orders require `account: "DUK112830"`** (or whatever the paper account ID is — get it from `getAccountSummary().account` first if unsure). Without it, orders may be ambiguous in multi-account setups.

4. **Cancels are clientId-scoped**. `cancelOrder(N)` only works from the same clientId that placed order N. If the original client disconnected, the order is orphaned; the API cannot cancel it. Workaround: `reqGlobalCancel()` cancels everything, but only do this if there are no orders you want to preserve.

5. **`PendingCancel` orders cannot be re-cancelled**. Error 10148: `"cannot be cancelled, state: PendingCancel"`. Once an order is in `PendingCancel`, it can only resolve via session reopen.

6. **GTC cancel window**: IBKR refuses cancels between **23:40 ET and 00:15 ET** daily. If you must cancel during that window, the request will queue.

7. **After-hours behavior**: Orders submitted while the exchange is closed go into `PendingSubmit` until session reopen. Same for cancels → `PendingCancel`. This is normal and the same for any client (TWS Desktop, IB Gateway, web). Treasury futures (CBOT): closed Friday 16:00 CT → Sunday 17:00 CT.

8. **Always confirm with the user before submitting orders** that change positions. Print the exact contract + order intent and wait for "yes" before calling `placeOrder`.

9. **Watch for events 8–15 seconds** after `placeOrder`. Status events (`orderStatus`, `openOrder`) can lag. If you disconnect too early, you'll miss them.

## Skeleton — reusable script frame

```js
import { IBApi, EventName, SecType, OrderAction, OrderType, TimeInForce } from "@stoqey/ib";

const api = new IBApi({ host: "127.0.0.1", port: 4000, clientId: 1234 });

// Filter noisy informational error codes; log everything else.
api.on(EventName.error, (e, code, reqId) => {
  if ([2104, 2106, 2158, 2168, 2169].includes(code)) return;
  console.error(`[IB err ${code}/${reqId}] ${e?.message ?? e}`);
});

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("connect timeout")), 8000);
  api.once(EventName.connected, () => { clearTimeout(timeout); resolve(); });
  api.connect();
});

try {
  // … your operation here …
} finally {
  api.disconnect();
}
process.exit(0);
```

## Templates by operation

### A. Account summary (PnL, NLV, buying power)

```js
const result = await new Promise((resolve, reject) => {
  const reqId = 9001;
  const out = {};
  const onSummary = (id, account, tag, value, currency) => {
    if (id !== reqId) return;
    out[tag] = value; out[`${tag}_currency`] = currency; out.account = account;
  };
  const onEnd = (id) => { if (id === reqId) { cleanup(); resolve(out); } };
  const cleanup = () => {
    clearTimeout(t);
    api.removeListener(EventName.accountSummary, onSummary);
    api.removeListener(EventName.accountSummaryEnd, onEnd);
    api.cancelAccountSummary(reqId);
  };
  const t = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 10000);
  api.on(EventName.accountSummary, onSummary);
  api.on(EventName.accountSummaryEnd, onEnd);
  api.reqAccountSummary(reqId, "All", "NetLiquidation,TotalCashValue,BuyingPower,UnrealizedPnL,RealizedPnL");
});
console.log(JSON.stringify(result, null, 2));
```

### B. Positions

```js
const positions = await new Promise((resolve) => {
  const out = [];
  const onPos = (account, contract, pos, avgCost) => {
    if (pos !== 0) out.push({
      account, symbol: contract.symbol, secType: contract.secType,
      exchange: contract.exchange, expiry: contract.lastTradeDateOrContractMonth,
      conId: contract.conId, qty: pos, avgCost,
    });
  };
  const onEnd = () => { cleanup(); resolve(out); };
  const cleanup = () => {
    clearTimeout(t);
    api.removeListener(EventName.position, onPos);
    api.removeListener(EventName.positionEnd, onEnd);
    api.cancelPositions();
  };
  const t = setTimeout(() => { cleanup(); resolve(out); }, 10000);
  api.on(EventName.position, onPos);
  api.on(EventName.positionEnd, onEnd);
  api.reqPositions();
});
console.log(JSON.stringify(positions, null, 2));
```

### C. Contract resolution (find conId for futures/options/etc.)

```js
// Example: resolve June 2026 ZN (10Y Treasury Note) futures on CBOT
const details = await new Promise((resolve, reject) => {
  const reqId = 9100;
  const out = [];
  const onDetails = (id, cd) => { if (id === reqId) out.push(cd); };
  const onEnd = (id) => { if (id === reqId) { cleanup(); resolve(out); } };
  const cleanup = () => {
    clearTimeout(t);
    api.removeListener(EventName.contractDetails, onDetails);
    api.removeListener(EventName.contractDetailsEnd, onEnd);
  };
  const t = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 10000);
  api.on(EventName.contractDetails, onDetails);
  api.on(EventName.contractDetailsEnd, onEnd);
  api.reqContractDetails(reqId, {
    symbol: "ZN",
    secType: SecType.FUT,                  // .STK for stocks, .OPT for options, .CASH for FX
    exchange: "CBOT",                       // not "SMART" for futures
    currency: "USD",
    lastTradeDateOrContractMonth: "202606", // YYYYMM or YYYYMMDD
  });
});
console.log("conId:", details[0]?.contract?.conId, "localSymbol:", details[0]?.contract?.localSymbol);
```

Common exchanges for futures: `CBOT` (Treasuries, grains), `CME` (equity index, currencies), `NYMEX` (energy), `COMEX` (metals), `ICEEU` (Brent), `GLOBEX` (deprecated — use CME).

### D. Market data snapshot (works for any sec type)

```js
const snap = await new Promise((resolve) => {
  const reqId = 9200;
  const prices = {};
  api.reqMarketDataType(3); // 3 = delayed (free on paper); 1 = live (subscription)
  const tickNames = { 1:"bid", 2:"ask", 4:"last", 6:"high", 7:"low", 9:"close", 14:"open",
                      66:"bid", 67:"ask", 68:"last", 72:"high", 73:"low", 75:"close" };
  const onTick = (id, type, price) => {
    if (id !== reqId || !(price > 0)) return;
    if (tickNames[type]) prices[tickNames[type]] = price;
  };
  const onEnd = (id) => { if (id === reqId) { cleanup(); resolve(prices); } };
  const cleanup = () => {
    clearTimeout(t);
    api.removeListener(EventName.tickPrice, onTick);
    api.removeListener(EventName.tickSnapshotEnd, onEnd);
    api.cancelMktData(reqId);
  };
  const t = setTimeout(() => { cleanup(); resolve(prices); }, 6000);
  api.on(EventName.tickPrice, onTick);
  api.on(EventName.tickSnapshotEnd, onEnd);
  api.reqMktData(reqId, {
    // Stock: { symbol: "AAPL", secType: SecType.STK, exchange: "SMART", currency: "USD" }
    // Futures by conId is fastest:
    conId: 840227361, exchange: "CBOT", secType: "FUT", currency: "USD",
  }, "", true /* snapshot */, false);
});
console.log(JSON.stringify(snap, null, 2));
```

Note: live snapshots may return empty if a "competing live session" (TWS Desktop, IBKR Desktop, Mobile) holds the data slot. Either close those, or fall back to delayed (`reqMarketDataType(3)`).

### E. Single-leg order (futures example)

```js
const orderId = 1001; // pick a value > any orderId you've seen; nextValidId(1) is fine on a fresh session
api.placeOrder(
  orderId,
  { symbol: "ZN", secType: SecType.FUT, exchange: "CBOT", currency: "USD",
    lastTradeDateOrContractMonth: "20260921" },
  {
    action: OrderAction.BUY,        // or SELL
    orderType: OrderType.LMT,       // .MKT for market (riskier on illiquid contracts)
    totalQuantity: 1,
    lmtPrice: 109.50,               // only for LMT
    tif: TimeInForce.GTC,           // or .DAY
    transmit: true,                  // ← MANDATORY
    account: "DUK112830",            // ← explicit paper account
    orderRef: "manual-test",         // free-text tag for your own reference
  }
);
// Then await orderStatus / openOrder events for 8–15s. See Skeleton.
```

### F. Combo / calendar spread order (atomic rollover)

A combo order is a single atomic order with multiple legs. For a Treasury futures rollover:

```js
// Step 1: resolve both legs' conIds via Template C (skipped here for brevity)
const conIdNear = 815824229;  // ZNM6 (Jun 2026)
const conIdFar  = 840227361;  // ZNU6 (Sep 2026)

// Step 2: build the BAG contract
const bagContract = {
  symbol: "ZN",
  secType: SecType.BAG,
  currency: "USD",
  exchange: "CBOT",
  comboLegs: [
    { conId: conIdNear, ratio: 1, action: "SELL", exchange: "CBOT" }, // close front
    { conId: conIdFar,  ratio: 1, action: "BUY",  exchange: "CBOT" }, // open back
  ],
};

// Step 3: place the spread as a single order
api.placeOrder(orderId, bagContract, {
  action: OrderAction.BUY,         // "buying the spread" = sell near + buy far
  orderType: OrderType.LMT,         // strongly prefer LMT for spreads; MKT can fill poorly
  totalQuantity: 10,
  lmtPrice: 0.50,                   // spread price = (far - near) you're willing to pay
  tif: TimeInForce.GTC,
  transmit: true,
  account: "DUK112830",
  orderRef: "rollover-ZN-Jun-to-Sep",
});
```

Caveat: not all exchanges accept BAG orders for every product. CBOT supports calendar spreads on Treasuries. If a BAG order silently fails, fall back to two separate single-leg orders (Template E).

### G. List + cancel open orders

```js
// List
const orders = await new Promise((resolve) => {
  const out = [];
  api.on(EventName.openOrder, (id, c, o, s) => out.push({
    orderId: id, sym: c.symbol, expiry: c.lastTradeDateOrContractMonth,
    action: o.action, qty: o.totalQuantity, type: o.orderType,
    status: s?.status, ref: o.orderRef,
  }));
  api.once(EventName.openOrderEnd, () => resolve(out));
  api.reqAllOpenOrders();
  setTimeout(() => resolve(out), 6000);
});
console.log(JSON.stringify(orders, null, 2));

// Cancel a specific order (only works if THIS clientId placed it; otherwise see reqGlobalCancel)
api.cancelOrder(orderId);

// Or nuke everything (use with care — cancels orders from other clients too):
// api.reqGlobalCancel();
```

## Trading-decision checklist

Before placing any order through this skill:

1. **Get fresh position state** — run Template B. Confirm what you're rolling/closing/adjusting.
2. **Get fresh prices** — run Template D. Compute fair value for the order type you'll use.
3. **Explain the plan to the user in plain English** — symbol(s), action, quantity, limit price, notional, expected impact. Show the JSON of the contract + order you're about to submit.
4. **Wait for explicit user confirmation** ("yes", "go", "approve"). Don't pattern-match a maybe.
5. **Place the order.** Then poll `ibkr_get_order_history` (typed tool, faster than rerunning a script) and report status to the user.
6. **If anything looks wrong, cancel immediately** — but read the cancel rules above (clientId scope, PendingCancel, GTC window).

## Common error codes

| Code | Meaning | Recovery |
|---|---|---|
| 200 | "No security definition has been found" | Wrong exchange / expiry / secType — re-check contract |
| 321 | "What-If order should have transmit flag set to TRUE" | Add `transmit: true` |
| 354 | "Requested market data is not subscribed" | Use `reqMarketDataType(3)` for delayed |
| 10147 | "OrderId that needs to be cancelled is not found" | Order placed by a different clientId; can't cancel from here |
| 10148 | "Order cannot be cancelled, state: PendingCancel" | Order already pending cancel; wait for session reopen |
| 10197 | "No market data during competing live session" | Close TWS Desktop / IBKR Desktop, or use delayed data |
| 2109 | "Outside RTH ignored" | Informational warning; the order is still being processed |

## Debugging tips

- If `placeOrder` produces no events: you're probably missing `transmit: true`.
- If `cancelOrder` returns 10147: use `reqGlobalCancel` or wait for session reopen.
- If snapshot/quote returns empty: check `reqMarketDataType(3)` is called *before* `reqMktData`, and look for code 10197.
- If a script hangs without error: the clientId likely collides with the plugin's (random 100–999). Switch to 1000–9999.
- The container's logs reveal protocol-level errors: `docker logs --since 60s ib-gateway`.

## What this skill does NOT cover

- Live (non-paper) trading. The paper account is `DUK112830`. Do not change `IBKR_ACCOUNT` in `.env` without explicit user authorization.
- Account configuration changes (entitlements, market data subscriptions, etc.). Those go through Client Portal Web.
- Anything that requires the master client (clientId=0) which would evict the plugin's connection.

/**
 * End-to-end live integration against the IBKR paper account.
 *
 * Drives the SAME compiled code the plugin tools use — IBKRClient, FlexClient,
 * flexTradeToRow, LedgerStore — against a REAL on-disk SQLite DB.
 *
 *   PART A — LIVE BROKER: connect to the real paper account, reconcile its Flex
 *            trade history through the mapper into the DB (idempotent), read
 *            same-day socket executions, and exercise the order submit path.
 *   PART B — SEEDED STK/OPT JOURNAL: because this paper account's history is
 *            futures-only and the market is closed (weekend → no equity fills
 *            possible), seed representative stock + option trades to demonstrate
 *            the full journal loop the request is about — record → attach
 *            reasoning → refresh marks → positions book. These rows are clearly
 *            demonstration entries, not real broker fills.
 *
 * Run: node test/integration/live-paper.mjs
 */
import { readFileSync } from "node:fs";
import { IBKRClient } from "../../dist/data/ibkr-client.js";
import { FlexClient } from "../../dist/data/flex-client.js";
import { flexTradeToRow } from "../../dist/data/flex-mapper.js";
import { LedgerStore } from "../../dist/data/ledger-store.js";

function loadEnv(path) {
	const env = {};
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
		if (!m) continue;
		let v = m[2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		env[m[1]] = v;
	}
	return env;
}

const env = loadEnv("/home/gao288/workplace/clawMafia/.env");
const DB_PATH = process.env.E2E_DB ?? "/tmp/claude-1000/e2e-ledger.sqlite";
const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${"─".repeat(4)} ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const fmt = (n) => (n === null || n === undefined ? "null" : typeof n === "number" ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(n));

const logger = { info: (m) => log(`  [info] ${m}`), warn: (m) => log(`  [warn] ${m}`), error: (m) => log(`  [error] ${m}`) };

async function refreshMarks(store, ibkr, syms) {
	let marked = 0;
	for (const { symbol, currency } of syms) {
		try {
			const snap = await ibkr.getSnapshot(symbol, currency || "USD");
			const price = snap.last ?? snap.close ?? (snap.bid && snap.ask ? (snap.bid + snap.ask) / 2 : undefined) ?? snap.open;
			if (typeof price === "number" && price > 0) {
				store.upsertMarketPrice(symbol, price, new Date().toISOString());
				marked++;
				log(`    ${symbol}: ${price}`);
			} else {
				log(`    ${symbol}: (no quote — market closed / venue)`);
			}
		} catch (e) {
			log(`    ${symbol}: [error] ${e.message}`);
		}
	}
	return marked;
}

function printBook(store, account) {
	const positions = store.getPositions(account);
	log(`  ${positions.length} positions for ${account}`);
	for (const p of positions) {
		log(
			`    ${(p.symbol || "").padEnd(12)} qty=${String(p.position).padStart(8)} cost=${fmt(p.cost).padStart(8)} ` +
				`mtm=${fmt(p.mark_to_market).padStart(12)} premium=${fmt(p.premium).padStart(8)} carry=${fmt(p.carry).padStart(7)} total_return=${fmt(p.total_return).padStart(12)}`,
		);
	}
}

async function main() {
	log(`E2E ledger integration — ${new Date().toISOString()}`);
	log(`DB (real, on disk): ${DB_PATH}`);

	const store = new LedgerStore(DB_PATH, logger);
	const ibkr = new IBKRClient(env.IBKR_HOST || "localhost", Number(env.IBKR_PORT || 4000), logger);
	const flex = new FlexClient(env.IBKR_FLEX_TOKEN || "", logger);

	// ══════════════════ PART A — LIVE BROKER ══════════════════
	hr("A1. CONNECT + ACCOUNT (real)");
	const summary = await ibkr.getAccountSummary();
	const account = summary.account || "(unknown)";
	const isPaper = /^DU|^DF/.test(account);
	log(`  account            = ${account}  (${isPaper ? "PAPER ✓" : "NON-PAPER — order placement DISABLED"})`);
	log(`  net_liquidation    = ${summary.NetLiquidation ?? "?"}`);
	log(`  buying_power       = ${summary.BuyingPower ?? "?"}`);

	hr("A2. RECORD FILLS (real Flex → ledger, idempotent)");
	try {
		const trades = await flex.getTrades(env.IBKR_FLEX_QUERY_ID || "");
		const mapped = flexTradeToRow(trades, logger);
		log(`  Flex returned ${trades.length} rows → ${mapped.equity.length} equity, ${mapped.option.length} option, skipped ${JSON.stringify(mapped.skipped)}`);
		let inserted = 0;
		for (const r of mapped.equity) if (store.upsertEquityTrade(r).inserted) inserted++;
		for (const r of mapped.option) if (store.upsertOptionTrade(r).inserted) inserted++;
		log(`  recorded ${inserted} STK/OPT rows from this account's real history`);
		let reInserted = 0;
		for (const r of mapped.equity) if (store.upsertEquityTrade(r).inserted) reInserted++;
		for (const r of mapped.option) if (store.upsertOptionTrade(r).inserted) reInserted++;
		log(`  idempotency re-run inserted=${reInserted} (expect 0)`);
	} catch (e) {
		log(`  [Flex unavailable] ${e.message}`);
	}

	hr("A3. RECENT EXECUTIONS (TWS socket, ~7d)");
	try {
		const execs = await ibkr.getExecutions();
		log(`  socket executions: ${execs.length}`);
		for (const e of execs.slice(0, 5)) log(`    ${e.time} ${e.symbol} ${e.side} ${e.shares}@${e.price} (${e.secType})`);
	} catch (e) {
		log(`  [executions unavailable] ${e.message}`);
	}

	hr("A4. ORDER PATH (paper-only, submit + cancel)");
	if (isPaper) {
		try {
			const order = await ibkr.placeOrder({ symbol: "AAPL", side: "BUY", quantity: 1, orderType: "LMT", limitPrice: 1.0, strategyId: "e2e-ledger-test", currency: "USD" });
			log(`  placed: order_id=${order.orderId} status=${order.status} (limit $1.00 — will not fill)`);
			await ibkr.cancelOrder(order.orderId);
			log(`  cancelled order_id=${order.orderId}`);
		} catch (e) {
			log(`  [order path] ${e.message} (expected on a closed market)`);
		}
	} else {
		log("  skipped — connected account is not a paper account.");
	}

	// ══════════════════ PART B — SEEDED STK/OPT JOURNAL DEMO ══════════════════
	hr("B0. SEED STK/OPT TRADES (demonstration entries)");
	log("  NOTE: representative stock+option trades (not real fills — market closed, account is futures-only).");
	const acct = isPaper ? account : "DUK-DEMO";
	const eqTrades = [
		{ trade_id: "demo-aapl-buy", account_id: acct, symbol: "AAPL", side: "buy", price: 225.5, quantity: 100, date: "2026-07-06", fee: -1, order_id: null, conid: null, currency: "USD" },
		{ trade_id: "demo-aapl-trim", account_id: acct, symbol: "AAPL", side: "sell", price: 232.1, quantity: -40, date: "2026-07-10", fee: -1, order_id: null, conid: null, currency: "USD" },
		{ trade_id: "demo-0941-buy", account_id: acct, symbol: "0941.HK", side: "buy", price: 80, quantity: 100000, date: "2026-07-02", fee: 0, order_id: null, conid: null, currency: "HKD" },
	];
	const optTrades = [
		{ trade_id: "demo-aapl-cc", account_id: acct, symbol: "AAPL", type: "call", strike: 240, price: 3.1, quantity: -5, date: "2026-07-07", expiration: "2026-08-21", fee: -1, order_id: null, conid: null, currency: "USD" },
	];
	const cashflows = [
		{ id: "demo-0941-prem", account_id: acct, symbol: "0941.HK", type: "premium", amount: 10000, date: "2026-07-05", note: "sold 1m covered call, exp worthless" },
		{ id: "demo-0941-div", account_id: acct, symbol: "0941.HK", type: "dividend", amount: 5000, date: "2026-07-08", note: "interim dividend" },
	];
	for (const r of eqTrades) store.upsertEquityTrade(r);
	for (const r of optTrades) store.upsertOptionTrade(r);
	for (const r of cashflows) store.upsertCashflow(r);
	log(`  seeded ${eqTrades.length} equity, ${optTrades.length} option, ${cashflows.length} cashflow rows for ${acct}`);

	hr("B1. ATTACH REASONING (the 'why' I decided, keyed by trade_id)");
	const reasoning = {
		"demo-aapl-buy":
			"Initiate 100-share AAPL core as the underlying for a covered-call program. Quality compounder bought on a pullback to ~225; " +
			"E(R) = carry (call premium) + (1+G) earnings growth. Sized to write 1 call per 100 sh.",
		"demo-aapl-trim":
			"Trim 40 sh into strength at 232 to lock partial gains and reduce assignment risk on the 240 calls; keeps 60 sh core.",
		"demo-0941-buy":
			"Value + income thesis on 0941.HK: net-cash cost basis 79.5, trades below intrinsic, high dividend + roll yield. Harvest premium via monthly covered calls.",
		"demo-aapl-cc":
			"Sell 5x AAPL Aug 240 calls against the core: collect ~$1,550 premium, strike ~6% OTM. Willing to be called away at a gain; premium is the carry leg of E(R).",
	};
	for (const [tradeId, why] of Object.entries(reasoning)) {
		const n = store.setReasoning(tradeId, why);
		const back = store.getTrade(tradeId);
		log(`    ${tradeId.padEnd(16)} ← set ${n} row; read-back ok=${back?.reasoning === why}`);
	}

	hr("B2. REFRESH MARKS (real quotes → market_prices)");
	const marked = await refreshMarks(store, ibkr, store.getSymbols());
	log(`  marks written: ${marked}/${store.getSymbols().length}`);

	hr("B3. POSITIONS BOOK (derived view, with reasoning)");
	printBook(store, acct);
	log("  reasoning attached to:");
	for (const tradeId of Object.keys(reasoning)) {
		const t = store.getTrade(tradeId);
		if (t) log(`    ${tradeId} (${t.symbol}): ${String(t.reasoning).slice(0, 72)}…`);
	}

	hr("DB SUMMARY");
	log(`  row counts: ${JSON.stringify(store.counts())}`);

	store.close();
	ibkr.disconnect?.();
	log("\nDONE.");
	setTimeout(() => process.exit(0), 250);
}

main().catch((e) => {
	console.error("FATAL:", e);
	setTimeout(() => process.exit(1), 250);
});

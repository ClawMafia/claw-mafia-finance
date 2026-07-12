import { test } from "node:test";
import assert from "node:assert/strict";
import { LedgerStore } from "../src/data/ledger-store.ts";
import type { EquityTradeRow, OptionTradeRow, CashflowRow } from "../src/data/ledger-store.ts";

const silentLogger = { info() {}, warn() {}, error() {} };

function freshStore(): LedgerStore {
	return new LedgerStore(":memory:", silentLogger);
}

function equityRow(overrides: Partial<EquityTradeRow>): EquityTradeRow {
	return {
		trade_id: "t-1",
		account_id: "DU1",
		symbol: "0941.HK",
		side: "buy",
		price: 80,
		quantity: 100000,
		date: "2026-01-02",
		fee: 0,
		order_id: null,
		conid: null,
		currency: "HKD",
		...overrides,
	};
}

function optionRow(overrides: Partial<OptionTradeRow>): OptionTradeRow {
	return {
		trade_id: "o-1",
		account_id: "DU1",
		symbol: "AAPL",
		type: "call",
		strike: 200,
		price: 3.2,
		quantity: -5,
		date: "2026-01-15",
		expiration: "2026-02-20",
		fee: -1,
		order_id: null,
		conid: null,
		currency: "USD",
		...overrides,
	};
}

function cashflow(overrides: Partial<CashflowRow>): CashflowRow {
	return {
		id: "cf-1",
		account_id: "DU1",
		symbol: "0941.HK",
		type: "premium",
		amount: 10000,
		date: "2026-01-15",
		note: null,
		...overrides,
	};
}

test("upsert is idempotent on trade_id (DO NOTHING, no overwrite)", () => {
	const store = freshStore();
	assert.equal(store.upsertEquityTrade(equityRow({ trade_id: "dup" })).inserted, true);
	assert.equal(store.upsertEquityTrade(equityRow({ trade_id: "dup", price: 999 })).inserted, false);
	const positions = store.getPositions("DU1");
	assert.equal(positions.length, 1);
	assert.equal(positions[0].book_value, 80 * 100000); // price stayed 80
	store.close();
});

test("a conflicting re-upsert does NOT wipe an already-written reasoning", () => {
	const store = freshStore();
	store.upsertEquityTrade(equityRow({ trade_id: "keep" }));
	store.setReasoning("keep", "core position");
	// A later reconcile pass re-inserts the same fill:
	assert.equal(store.upsertEquityTrade(equityRow({ trade_id: "keep" })).inserted, false);
	const row = store.getTrade("keep") as { reasoning: string | null };
	assert.equal(row.reasoning, "core position");
	store.close();
});

test("cashflow upsert is idempotent on id", () => {
	const store = freshStore();
	assert.equal(store.upsertCashflow(cashflow({ id: "x" })).inserted, true);
	assert.equal(store.upsertCashflow(cashflow({ id: "x", amount: 999 })).inserted, false);
	store.close();
});

test("positions view reconciles the 0941.HK worked example (total_return = 453,000)", () => {
	const store = freshStore();
	store.upsertEquityTrade(equityRow({ trade_id: "eq-buy", side: "buy", price: 80, quantity: 100000 }));
	store.upsertEquityTrade(equityRow({ trade_id: "eq-sell", side: "sell", price: 82, quantity: -20000, date: "2026-03-02" }));

	for (let i = 0; i < 5; i++) {
		store.upsertCashflow(cashflow({ id: `tx-prem-${i}`, type: "premium", amount: 10000 }));
		store.upsertCashflow(cashflow({ id: `tx-fee-${i}`, type: "fee", amount: -1000 }));
	}
	store.upsertMarketPrice("0941.HK", 84.6, "2026-03-10");

	const [pos] = store.getPositions("DU1");
	assert.equal(pos.position, 80000);
	assert.equal(pos.book_value, 6_360_000);
	assert.equal(pos.cost, 79.5);
	assert.equal(pos.mark_to_market, 6_768_000);
	assert.equal(pos.premium, 50_000);
	assert.equal(pos.carry, -5_000);
	assert.equal(pos.total_return, 453_000);
	store.close();
});

test("carry sums option_roll into premium and trade fees + non-trade cashflows into carry", () => {
	const store = freshStore();
	store.upsertEquityTrade(equityRow({ trade_id: "eq", symbol: "TST", quantity: 100, price: 10, fee: -2, currency: "USD" }));
	store.upsertOptionTrade(optionRow({ trade_id: "opt", symbol: "TST", fee: -1 }));
	store.upsertCashflow(cashflow({ id: "roll", symbol: "TST", type: "option_roll", amount: 300 }));
	store.upsertCashflow(cashflow({ id: "div", symbol: "TST", type: "dividend", amount: 50 }));
	store.upsertMarketPrice("TST", 11, "2026-03-10");

	const [pos] = store.getPositions("DU1");
	// premium = option_roll cashflow only (option legs deferred) = 300
	assert.equal(pos.premium, 300);
	// carry = dividend(50) + equity_fee(-2) + option_fee(-1) = 47
	assert.equal(pos.carry, 47);
	store.close();
});

test("cost is NULL when the net position is flat", () => {
	const store = freshStore();
	store.upsertEquityTrade(equityRow({ trade_id: "in", symbol: "FLAT", quantity: 100, price: 10 }));
	store.upsertEquityTrade(equityRow({ trade_id: "out", symbol: "FLAT", quantity: -100, price: 12, side: "sell" }));
	const [pos] = store.getPositions("DU1");
	assert.equal(pos.position, 0);
	assert.equal(pos.cost, null);
	store.close();
});

test("a position with no market price yields NULL mtm but real premium/carry", () => {
	const store = freshStore();
	store.upsertEquityTrade(equityRow({ trade_id: "nomark", symbol: "NOPX", quantity: 100, price: 10 }));
	store.upsertCashflow(cashflow({ id: "p", symbol: "NOPX", type: "premium", amount: 500 }));
	const [pos] = store.getPositions("DU1");
	assert.equal(pos.current_price, null);
	assert.equal(pos.mark_to_market, null);
	assert.equal(pos.total_return, null); // NULL propagates through the arithmetic
	assert.equal(pos.premium, 500);
	store.close();
});

test("upsertMarketPrice overwrites the prior mark on conflict", () => {
	const store = freshStore();
	store.upsertMarketPrice("AAA", 10, "2026-01-01");
	store.upsertMarketPrice("AAA", 20, "2026-01-02");
	store.upsertEquityTrade(equityRow({ trade_id: "a", symbol: "AAA", quantity: 10, price: 5 }));
	const [pos] = store.getPositions("DU1");
	assert.equal(pos.current_price, 20);
	assert.equal(pos.mark_to_market, 200);
	store.close();
});

test("setReasoning round-trips and is keyed by trade_id (equity and option)", () => {
	const store = freshStore();
	store.upsertEquityTrade(equityRow({ trade_id: "eq-r" }));
	store.upsertOptionTrade(optionRow({ trade_id: "opt-r" }));
	assert.equal(store.setReasoning("eq-r", "equity why"), 1);
	assert.equal(store.setReasoning("opt-r", "option why"), 1);
	assert.equal(store.setReasoning("nope", "x"), 0);
	assert.equal((store.getTrade("eq-r") as { reasoning: string | null }).reasoning, "equity why");
	assert.equal((store.getTrade("opt-r") as { reasoning: string | null }).reasoning, "option why");
	store.close();
});

test("getSymbols returns distinct symbols across both trade ledgers", () => {
	const store = freshStore();
	store.upsertEquityTrade(equityRow({ trade_id: "e1", symbol: "AAA" }));
	store.upsertEquityTrade(equityRow({ trade_id: "e2", symbol: "AAA" }));
	store.upsertEquityTrade(equityRow({ trade_id: "e3", symbol: "BBB" }));
	store.upsertOptionTrade(optionRow({ trade_id: "o1", symbol: "CCC" }));
	const symbols = store.getSymbols().map((s) => s.symbol);
	assert.deepEqual(symbols, ["AAA", "BBB", "CCC"]);
	store.close();
});

test("accounts are isolated in the positions book", () => {
	const store = freshStore();
	store.upsertEquityTrade(equityRow({ trade_id: "paper", account_id: "DU1", quantity: 100000 }));
	store.upsertEquityTrade(equityRow({ trade_id: "live", account_id: "U9", quantity: 500 }));

	assert.equal(store.getPositions("DU1").length, 1);
	assert.equal(store.getPositions("DU1")[0].position, 100000);
	assert.equal(store.getPositions("U9").length, 1);
	assert.equal(store.getPositions("U9")[0].position, 500);
	assert.equal(store.getPositions().length, 2);
	store.close();
});

test("the same symbol under two accounts stays separate", () => {
	const store = freshStore();
	store.upsertEquityTrade(equityRow({ trade_id: "a1", account_id: "DU1", symbol: "SAME", quantity: 100, price: 10 }));
	store.upsertEquityTrade(equityRow({ trade_id: "a2", account_id: "U9", symbol: "SAME", quantity: 7, price: 10 }));
	store.upsertMarketPrice("SAME", 12, "2026-03-10");
	assert.equal(store.getPositions("DU1")[0].position, 100);
	assert.equal(store.getPositions("U9")[0].position, 7);
	store.close();
});

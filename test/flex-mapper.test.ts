import { test } from "node:test";
import assert from "node:assert/strict";
import { flexTradeToRow } from "../src/data/flex-mapper.ts";
import type { FlexTrade } from "../src/data/flex-client.ts";

function flexTrade(overrides: Partial<FlexTrade>): FlexTrade {
	return {
		date: "2026-01-02",
		datetime: null,
		symbol: "AAPL",
		asset_category: "STK",
		side: "BUY",
		quantity: 100,
		price: 198.4,
		proceeds: null,
		commission: null,
		realized_pnl: null,
		currency: "USD",
		exchange: "NASDAQ",
		put_call: "",
		strike: null,
		expiry: "",
		conid: "265598",
		trade_id: "T1",
		order_id: "O1",
		account_id: "DU111",
		...overrides,
	};
}

test("routes STK to the equity ledger, preserving sign and account", () => {
	const { equity, option, skipped } = flexTradeToRow([flexTrade({ quantity: -20000, side: "SELL", price: 82 })]);
	assert.equal(equity.length, 1);
	assert.equal(option.length, 0);
	assert.equal(skipped.length, 0);
	assert.equal(equity[0].quantity, -20000);
	assert.equal(equity[0].side, "sell");
	assert.equal(equity[0].account_id, "DU111");
	assert.equal(equity[0].currency, "USD");
});

test("commission null becomes fee 0; present commission is kept signed", () => {
	assert.equal(flexTradeToRow([flexTrade({ commission: null })]).equity[0].fee, 0);
	assert.equal(flexTradeToRow([flexTrade({ commission: -1.25 })]).equity[0].fee, -1.25);
});

test("empty account_id maps to empty string (not undefined)", () => {
	const { equity } = flexTradeToRow([flexTrade({ account_id: "" })]);
	assert.equal(equity[0].account_id, "");
});

test("routes OPT to the option ledger with type + normalized expiry", () => {
	const { option } = flexTradeToRow([
		flexTrade({ asset_category: "OPT", put_call: "C", strike: 200, expiry: "20260220", quantity: -5, trade_id: "T2" }),
	]);
	assert.equal(option.length, 1);
	assert.equal(option[0].type, "call");
	assert.equal(option[0].strike, 200);
	assert.equal(option[0].expiration, "2026-02-20");
	assert.equal(option[0].quantity, -5);
});

test("option put/call flag accepts P/C and PUT/CALL, defaults to call when absent", () => {
	const mk = (pc: string) => flexTradeToRow([flexTrade({ asset_category: "OPT", put_call: pc, strike: 1, trade_id: pc || "blank" })]).option[0].type;
	assert.equal(mk("P"), "put");
	assert.equal(mk("PUT"), "put");
	assert.equal(mk("c"), "call");
	assert.equal(mk("CALL"), "call");
	assert.equal(mk(""), "call"); // unknown → default, no throw
});

test("option strike null defaults to 0", () => {
	const { option } = flexTradeToRow([flexTrade({ asset_category: "OPT", put_call: "P", strike: null, trade_id: "T3" })]);
	assert.equal(option[0].strike, 0);
});

test("expiry already in ISO form passes through cleanly", () => {
	const { option } = flexTradeToRow([flexTrade({ asset_category: "OPT", put_call: "P", strike: 1, expiry: "2026-02-20", trade_id: "T4" })]);
	assert.equal(option[0].expiration, "2026-02-20");
});

test("falls back off an empty trade_id (never a blank key)", () => {
	const viaExec = flexTradeToRow([flexTrade({ trade_id: "", order_id: "EXEC99" })]);
	assert.equal(viaExec.equity[0].trade_id, "exec:EXEC99");

	const a = flexTradeToRow([flexTrade({ trade_id: "", order_id: "" })]);
	const b = flexTradeToRow([flexTrade({ trade_id: "", order_id: "" })]);
	assert.match(a.equity[0].trade_id, /^hash:[0-9a-f]{16}$/);
	assert.equal(a.equity[0].trade_id, b.equity[0].trade_id);
});

test("content-hash key differs when the underlying fill differs", () => {
	const one = flexTradeToRow([flexTrade({ trade_id: "", order_id: "", price: 10 })]).equity[0].trade_id;
	const two = flexTradeToRow([flexTrade({ trade_id: "", order_id: "", price: 11 })]).equity[0].trade_id;
	assert.notEqual(one, two);
});

test("side falls back to the sign of quantity when buySell is absent", () => {
	assert.equal(flexTradeToRow([flexTrade({ side: "", quantity: -10 })]).equity[0].side, "sell");
	assert.equal(flexTradeToRow([flexTrade({ side: "", quantity: 10 })]).equity[0].side, "buy");
	assert.equal(flexTradeToRow([flexTrade({ side: "", quantity: 0 })]).equity[0].side, "buy"); // 0 → buy (>=0)
});

test("non-STK/OPT categories are counted as skipped", () => {
	const { equity, option, skipped } = flexTradeToRow([
		flexTrade({ asset_category: "FUT", trade_id: "F1" }),
		flexTrade({ asset_category: "CASH", trade_id: "C1" }),
		flexTrade({ asset_category: "FUT", trade_id: "F2" }),
	]);
	assert.equal(equity.length, 0);
	assert.equal(option.length, 0);
	assert.deepEqual(
		skipped.sort((x, y) => x.category.localeCompare(y.category)),
		[
			{ category: "CASH", count: 1 },
			{ category: "FUT", count: 2 },
		],
	);
});

test("a mixed batch routes each row to the right ledger", () => {
	const { equity, option, skipped } = flexTradeToRow([
		flexTrade({ asset_category: "STK", trade_id: "E1" }),
		flexTrade({ asset_category: "OPT", put_call: "C", strike: 5, trade_id: "O1" }),
		flexTrade({ asset_category: "stk", trade_id: "E2" }), // lower-case category still routes
		flexTrade({ asset_category: "FUND", trade_id: "X1" }),
	]);
	assert.equal(equity.length, 2);
	assert.equal(option.length, 1);
	assert.deepEqual(skipped, [{ category: "FUND", count: 1 }]);
});

test("empty input yields empty ledgers", () => {
	const { equity, option, skipped } = flexTradeToRow([]);
	assert.equal(equity.length, 0);
	assert.equal(option.length, 0);
	assert.equal(skipped.length, 0);
});

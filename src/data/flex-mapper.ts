/**
 * flexTradeToRow — pure mapper from broker Flex trade rows to ledger rows.
 *
 * Routes on asset category (STK → equity ledger, OPT → option ledger; other
 * categories are counted and skipped for now). Signs are preserved as IBKR
 * reports them (sells negative), prices stay raw (no ×100 option multiplier —
 * that is the deferred adjusting layer), and every row carries its account_id.
 *
 * Pure and side-effect free apart from optional warnings, so it is trivially
 * unit-testable against sample FlexTrade objects.
 */

import { createHash } from "node:crypto";
import type { FlexTrade } from "./flex-client.js";
import type { EquityTradeRow, OptionTradeRow } from "./ledger-store.js";

type Logger = { warn: (msg: string) => void };

export type MappedRows = {
	equity: EquityTradeRow[];
	option: OptionTradeRow[];
	/** Categories that were neither STK nor OPT, with counts (not yet ledgered). */
	skipped: Array<{ category: string; count: number }>;
};

export function flexTradeToRow(trades: FlexTrade[], logger?: Logger): MappedRows {
	const equity: EquityTradeRow[] = [];
	const option: OptionTradeRow[] = [];
	const skipped = new Map<string, number>();

	for (const t of trades) {
		const category = (t.asset_category || "").toUpperCase();
		if (category === "STK") {
			equity.push(toEquityRow(t, logger));
		} else if (category === "OPT") {
			option.push(toOptionRow(t, logger));
		} else {
			const key = category || "UNKNOWN";
			skipped.set(key, (skipped.get(key) ?? 0) + 1);
		}
	}

	return {
		equity,
		option,
		skipped: [...skipped].map(([category, count]) => ({ category, count })),
	};
}

function toEquityRow(t: FlexTrade, logger?: Logger): EquityTradeRow {
	return {
		trade_id: resolveTradeId(t, logger),
		account_id: t.account_id || "",
		symbol: t.symbol,
		side: resolveSide(t),
		price: t.price,
		quantity: t.quantity,
		date: t.date,
		fee: t.commission ?? 0,
		order_id: t.order_id || null,
		conid: t.conid || null,
		currency: t.currency || null,
	};
}

function toOptionRow(t: FlexTrade, logger?: Logger): OptionTradeRow {
	return {
		trade_id: resolveTradeId(t, logger),
		account_id: t.account_id || "",
		symbol: t.symbol,
		type: resolveOptionType(t, logger),
		strike: t.strike ?? 0,
		price: t.price,
		quantity: t.quantity,
		date: t.date,
		expiration: normalizeIsoDate(t.expiry),
		fee: t.commission ?? 0,
		order_id: t.order_id || null,
		conid: t.conid || null,
		currency: t.currency || null,
	};
}

/**
 * The idempotency key. Prefer the broker `tradeID`. Activity-Flex "Trades"
 * rows always carry one; TradeConfirm-only rows may not, so fall back to the
 * execution/order id, then to a deterministic content hash — never a blank key
 * (blanks would all collide under ON CONFLICT(trade_id)).
 */
function resolveTradeId(t: FlexTrade, logger?: Logger): string {
	if (t.trade_id) return t.trade_id;
	if (t.order_id) {
		logger?.warn(`Flex trade missing tradeID; keying on execution/order id (${t.order_id}). Prefer an Activity-Flex "Trades" query.`);
		return `exec:${t.order_id}`;
	}
	const hash = createHash("sha1")
		.update([t.symbol, t.date, t.price, t.quantity, t.order_id].join("|"))
		.digest("hex")
		.slice(0, 16);
	logger?.warn(`Flex trade missing both tradeID and order id; keying on content hash (${hash}).`);
	return `hash:${hash}`;
}

function resolveSide(t: FlexTrade): "buy" | "sell" {
	const s = (t.side || "").toLowerCase();
	if (s === "buy" || s === "sell") return s;
	// Fall back to the sign of the (signed) quantity.
	return t.quantity >= 0 ? "buy" : "sell";
}

function resolveOptionType(t: FlexTrade, logger?: Logger): "call" | "put" {
	const pc = (t.put_call || "").toUpperCase();
	if (pc === "C" || pc === "CALL") return "call";
	if (pc === "P" || pc === "PUT") return "put";
	logger?.warn(`Option ${t.symbol} ${t.date} has no put/call flag; defaulting to call.`);
	return "call";
}

/** IBKR expiry can be YYYYMMDD (± time); emit YYYY-MM-DD, else pass through. */
function normalizeIsoDate(raw: string): string {
	const digits = (raw || "").replace(/[^0-9]/g, "");
	if (digits.length >= 8) {
		return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
	}
	return raw;
}

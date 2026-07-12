/**
 * LedgerStore — the structured system of record for the trading journals.
 *
 * A thin, synchronous wrapper around an embedded SQLite database (via
 * better-sqlite3). It holds the four datasets from the Trading Journals data
 * schema: the equity and option trade ledgers, the cashflow ledger, and a
 * derived `positions` view. Broker-authoritative fills are upserted keyed by
 * `trade_id` (idempotent); the agent-written `reasoning` column is the one
 * mutable, non-re-pullable field.
 *
 * Account-scoped: every row carries `account_id` and the `positions` view groups
 * by `(account_id, symbol)`, so paper (DU…) and live (U…) accounts never
 * commingle in one book. The engine is intentionally account-agnostic — which
 * account we see is decided entirely by the gateway/Flex config, not by code.
 *
 * SQLite fits the current reality (single writer, tiny volume, want ACID +
 * constraints without a server). The schema is written in portable SQL so the
 * documented Postgres upgrade path stays a driver swap.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

export type EquityTradeRow = {
	trade_id: string;
	account_id: string;
	symbol: string;
	side: "buy" | "sell";
	price: number;
	quantity: number;
	date: string;
	fee: number;
	order_id: string | null;
	conid: string | null;
	currency: string | null;
};

export type OptionTradeRow = {
	trade_id: string;
	account_id: string;
	symbol: string;
	type: "call" | "put";
	strike: number;
	price: number;
	quantity: number;
	date: string;
	expiration: string;
	fee: number;
	order_id: string | null;
	conid: string | null;
	currency: string | null;
};

export type CashflowRow = {
	id: string;
	account_id: string;
	symbol: string;
	type: string;
	amount: number;
	date: string;
	note: string | null;
};

export type PositionRow = {
	account_id: string;
	symbol: string;
	position: number;
	book_value: number;
	cost: number | null;
	current_price: number | null;
	mark_to_market: number | null;
	premium: number;
	carry: number;
	total_return: number | null;
};

const SCHEMA_VERSION = 1;

export class LedgerStore {
	private db: Database.Database;
	private logger: Logger;

	constructor(dbPath: string, logger: Logger) {
		this.logger = logger;
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.migrate();
		this.logger.info(`LedgerStore ready at ${dbPath}`);
	}

	// ── schema ──
	//
	// Migrations are an ordered, idempotent CREATE-IF-NOT-EXISTS list plus a
	// schema_version row. When the schema needs to change, add a versioned step
	// rather than editing the DDL below.
	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

			CREATE TABLE IF NOT EXISTS equity_trades (
				trade_id   TEXT PRIMARY KEY,
				account_id TEXT NOT NULL,
				symbol     TEXT NOT NULL,
				side       TEXT NOT NULL CHECK (side IN ('buy','sell')),
				price      REAL NOT NULL,
				quantity   INTEGER NOT NULL,
				date       TEXT NOT NULL,
				fee        REAL NOT NULL DEFAULT 0,
				order_id   TEXT,
				conid      TEXT,
				currency   TEXT,
				reasoning  TEXT
			);

			CREATE TABLE IF NOT EXISTS option_trades (
				trade_id   TEXT PRIMARY KEY,
				account_id TEXT NOT NULL,
				symbol     TEXT NOT NULL,
				type       TEXT NOT NULL CHECK (type IN ('call','put')),
				strike     REAL NOT NULL,
				price      REAL NOT NULL,
				quantity   INTEGER NOT NULL,
				date       TEXT NOT NULL,
				expiration TEXT NOT NULL,
				fee        REAL NOT NULL DEFAULT 0,
				order_id   TEXT,
				conid      TEXT,
				currency   TEXT,
				reasoning  TEXT
			);

			CREATE TABLE IF NOT EXISTS cashflow (
				id         TEXT PRIMARY KEY,
				account_id TEXT NOT NULL,
				symbol     TEXT NOT NULL,
				type       TEXT NOT NULL,
				amount     REAL NOT NULL,
				date       TEXT NOT NULL,
				note       TEXT
			);

			CREATE TABLE IF NOT EXISTS market_prices (
				symbol TEXT PRIMARY KEY,
				price  REAL NOT NULL,
				asof   TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS ix_equity_acct_symbol   ON equity_trades(account_id, symbol);
			CREATE INDEX IF NOT EXISTS ix_option_acct_symbol   ON option_trades(account_id, symbol);
			CREATE INDEX IF NOT EXISTS ix_cashflow_acct_symbol ON cashflow(account_id, symbol);

			-- Derived positions view (Entity 4). Each ledger is aggregated on its
			-- own grain first, then combined, so joins never multiply rows.
			-- premium is sourced from the cashflow ledger only; folding raw option
			-- legs (sign + ×100 multiplier) into premium is the deferred adjusting
			-- layer. carry = non-trade cashflows + all trade fees.
			CREATE VIEW IF NOT EXISTS positions AS
			WITH eq AS (
				SELECT account_id, symbol,
				       SUM(quantity)         AS position,
				       SUM(price * quantity) AS book_value,
				       SUM(fee)              AS equity_fee
				FROM equity_trades GROUP BY account_id, symbol
			),
			opt AS (
				SELECT account_id, symbol, SUM(fee) AS option_fee
				FROM option_trades GROUP BY account_id, symbol
			),
			cf AS (
				SELECT account_id, symbol,
				       SUM(CASE WHEN type IN ('premium','option_roll') THEN amount ELSE 0 END) AS cf_premium,
				       SUM(CASE WHEN type IN ('dividend','coupon','interest','futures_roll','fee') THEN amount ELSE 0 END) AS cf_carry
				FROM cashflow GROUP BY account_id, symbol
			)
			SELECT
				eq.account_id,
				eq.symbol,
				eq.position,
				eq.book_value,
				CASE WHEN eq.position != 0 THEN eq.book_value / eq.position END AS cost,
				mp.price                    AS current_price,
				mp.price * eq.position      AS mark_to_market,
				COALESCE(cf.cf_premium, 0)  AS premium,
				COALESCE(cf.cf_carry, 0) + COALESCE(eq.equity_fee, 0) + COALESCE(opt.option_fee, 0) AS carry,
				(mp.price * eq.position - eq.book_value)
					+ COALESCE(cf.cf_premium, 0)
					+ COALESCE(cf.cf_carry, 0) + COALESCE(eq.equity_fee, 0) + COALESCE(opt.option_fee, 0) AS total_return
			FROM eq
			LEFT JOIN opt ON opt.account_id = eq.account_id AND opt.symbol = eq.symbol
			LEFT JOIN cf  ON cf.account_id  = eq.account_id AND cf.symbol  = eq.symbol
			LEFT JOIN market_prices mp ON mp.symbol = eq.symbol;
		`);

		const row = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
		if (!row) {
			this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
		}
	}

	// ── writes (idempotent on the primary key) ──

	upsertEquityTrade(row: EquityTradeRow): { inserted: boolean } {
		const info = this.db
			.prepare(
				`INSERT INTO equity_trades (trade_id, account_id, symbol, side, price, quantity, date, fee, order_id, conid, currency)
				 VALUES (@trade_id, @account_id, @symbol, @side, @price, @quantity, @date, @fee, @order_id, @conid, @currency)
				 ON CONFLICT(trade_id) DO NOTHING`,
			)
			.run(row);
		return { inserted: info.changes > 0 };
	}

	upsertOptionTrade(row: OptionTradeRow): { inserted: boolean } {
		const info = this.db
			.prepare(
				`INSERT INTO option_trades (trade_id, account_id, symbol, type, strike, price, quantity, date, expiration, fee, order_id, conid, currency)
				 VALUES (@trade_id, @account_id, @symbol, @type, @strike, @price, @quantity, @date, @expiration, @fee, @order_id, @conid, @currency)
				 ON CONFLICT(trade_id) DO NOTHING`,
			)
			.run(row);
		return { inserted: info.changes > 0 };
	}

	upsertCashflow(row: CashflowRow): { inserted: boolean } {
		const info = this.db
			.prepare(
				`INSERT INTO cashflow (id, account_id, symbol, type, amount, date, note)
				 VALUES (@id, @account_id, @symbol, @type, @amount, @date, @note)
				 ON CONFLICT(id) DO NOTHING`,
			)
			.run(row);
		return { inserted: info.changes > 0 };
	}

	upsertMarketPrice(symbol: string, price: number, asof: string): void {
		this.db
			.prepare(
				`INSERT INTO market_prices (symbol, price, asof) VALUES (?, ?, ?)
				 ON CONFLICT(symbol) DO UPDATE SET price = excluded.price, asof = excluded.asof`,
			)
			.run(symbol, price, asof);
	}

	/** Write the agent's reasoning onto whichever trade table holds this id. */
	setReasoning(tradeId: string, reasoning: string): number {
		const e = this.db.prepare("UPDATE equity_trades SET reasoning = ? WHERE trade_id = ?").run(reasoning, tradeId);
		const o = this.db.prepare("UPDATE option_trades SET reasoning = ? WHERE trade_id = ?").run(reasoning, tradeId);
		return e.changes + o.changes;
	}

	// ── reads ──

	/** Distinct symbols across both trade ledgers (for mark refresh). */
	getSymbols(): Array<{ symbol: string; currency: string | null }> {
		return this.db
			.prepare(
				`SELECT symbol, currency FROM (
					SELECT symbol, currency FROM equity_trades
					UNION
					SELECT symbol, currency FROM option_trades
				) GROUP BY symbol ORDER BY symbol`,
			)
			.all() as Array<{ symbol: string; currency: string | null }>;
	}

	getPositions(accountId?: string): PositionRow[] {
		if (accountId) {
			return this.db.prepare("SELECT * FROM positions WHERE account_id = ?").all(accountId) as PositionRow[];
		}
		return this.db.prepare("SELECT * FROM positions").all() as PositionRow[];
	}

	getTrade(tradeId: string): (EquityTradeRow | OptionTradeRow) & { reasoning: string | null } | undefined {
		const eq = this.db.prepare("SELECT * FROM equity_trades WHERE trade_id = ?").get(tradeId);
		if (eq) return eq as EquityTradeRow & { reasoning: string | null };
		const opt = this.db.prepare("SELECT * FROM option_trades WHERE trade_id = ?").get(tradeId);
		return opt as (OptionTradeRow & { reasoning: string | null }) | undefined;
	}

	/** Row counts per table + the derived view (diagnostics). */
	counts(): Record<string, number> {
		const n = (table: string) => (this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
		return {
			equity_trades: n("equity_trades"),
			option_trades: n("option_trades"),
			cashflow: n("cashflow"),
			market_prices: n("market_prices"),
			positions: n("positions"),
		};
	}

	/** A few trade ids across both ledgers (equity first), for annotation/sampling. */
	firstTradeIds(limit: number): Array<{ trade_id: string; symbol: string; kind: "equity" | "option" }> {
		const eq = this.db
			.prepare("SELECT trade_id, symbol, 'equity' AS kind FROM equity_trades LIMIT ?")
			.all(limit) as Array<{ trade_id: string; symbol: string; kind: "equity" | "option" }>;
		if (eq.length >= limit) return eq;
		const opt = this.db
			.prepare("SELECT trade_id, symbol, 'option' AS kind FROM option_trades LIMIT ?")
			.all(limit - eq.length) as Array<{ trade_id: string; symbol: string; kind: "equity" | "option" }>;
		return [...eq, ...opt];
	}

	close(): void {
		this.db.close();
	}
}

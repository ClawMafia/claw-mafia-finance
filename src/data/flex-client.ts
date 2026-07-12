/**
 * IBKR Flex Web Service client.
 *
 * Unlike the TWS socket API (see ibkr-client.ts), which only serves the
 * current day plus a short rolling window of executions, the Flex Web Service
 * returns full, lifetime account history on demand over plain HTTPS. It needs
 * no running gateway/socket session — only a Flex Web Service token and a
 * pre-defined Flex Query id, both created in IBKR Client Portal.
 *
 * Protocol (two HTTPS steps, both versioned with v=3):
 *   1. SendRequest?t=<token>&q=<queryId> -> a ReferenceCode (the report is
 *      generated asynchronously on IBKR's side).
 *   2. GetStatement?t=<token>&q=<referenceCode> -> the report XML, or a
 *      "generation in progress" warning that must be polled until ready.
 *
 * See the ibkr-setup skill for the Client Portal setup walkthrough.
 */

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

const DEFAULT_BASE_URL =
	"https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

// GetStatement error codes that mean "not ready yet, retry shortly" rather than
// a hard failure. Everything else (expired token, bad query, etc.) fails fast.
const RETRYABLE_CODES = new Set(["1009", "1018", "1019"]);

export type FlexTrade = {
	/** Trade date in YYYY-MM-DD (normalized from IBKR's YYYYMMDD). */
	date: string;
	/** Full execution timestamp when available (raw IBKR dateTime). */
	datetime: string | null;
	symbol: string;
	/** STK, OPT, FUT, CASH, BOND, ... */
	asset_category: string;
	/** BUY or SELL as reported by IBKR. */
	side: string;
	/** Signed quantity: negative for sells (IBKR convention). */
	quantity: number;
	price: number;
	proceeds: number | null;
	commission: number | null;
	realized_pnl: number | null;
	currency: string;
	exchange: string;
	/** Options only: P or C. Empty for non-options. */
	put_call: string;
	/** Options only: strike price. null for non-options. */
	strike: number | null;
	/** Options/futures expiry (raw IBKR value). Empty for equities. */
	expiry: string;
	conid: string;
	trade_id: string;
	order_id: string;
	/** IBKR account the fill belongs to (DU… paper, U… live). Scopes the ledger. */
	account_id: string;
};

type FlexStatementResponse = {
	status: string;
	referenceCode: string | null;
	url: string | null;
	errorCode: string | null;
	errorMessage: string | null;
};

export class FlexClient {
	constructor(
		private token: string,
		private logger: Logger,
		private opts: {
			baseUrl?: string;
			pollIntervalMs?: number;
			maxWaitMs?: number;
		} = {},
	) {}

	private get baseUrl(): string {
		return this.opts.baseUrl ?? DEFAULT_BASE_URL;
	}

	/**
	 * Run a Flex Query end to end and return normalized trade rows.
	 *
	 * @param queryId - The Flex Query id created in Client Portal. The query
	 *   must include a Trades (Activity Flex) or TradeConfirm (Trade
	 *   Confirmation Flex) section, otherwise no rows are returned.
	 */
	async getTrades(queryId: string): Promise<FlexTrade[]> {
		if (!this.token) {
			throw new Error("Flex token not configured (set IBKR_FLEX_TOKEN).");
		}
		if (!queryId) {
			throw new Error("Flex query id not provided (set IBKR_FLEX_QUERY_ID).");
		}

		const reference = await this.sendRequest(queryId);
		const xml = await this.pollStatement(reference.url ?? `${this.baseUrl}/GetStatement`, reference.referenceCode!);
		const trades = parseTrades(xml);
		this.logger.info(`Flex query ${queryId} returned ${trades.length} trade rows`);
		return trades;
	}

	/** Step 1: ask IBKR to generate the statement; returns a reference code. */
	private async sendRequest(queryId: string): Promise<FlexStatementResponse> {
		const url = `${this.baseUrl}/SendRequest?t=${encodeURIComponent(this.token)}&q=${encodeURIComponent(queryId)}&v=3`;
		const body = await this.httpGet(url);
		const parsed = parseStatementResponse(body);
		if (parsed.status !== "Success" || !parsed.referenceCode) {
			throw new Error(
				`Flex SendRequest failed: ${parsed.errorCode ?? "?"} ${parsed.errorMessage ?? body.slice(0, 200)}`,
			);
		}
		return parsed;
	}

	/** Step 2: fetch the generated statement, polling while it is still building. */
	private async pollStatement(getUrl: string, referenceCode: string): Promise<string> {
		const pollInterval = this.opts.pollIntervalMs ?? 3_000;
		const maxWait = this.opts.maxWaitMs ?? 60_000;
		const deadline = Date.now() + maxWait;
		const url = `${getUrl}?t=${encodeURIComponent(this.token)}&q=${encodeURIComponent(referenceCode)}&v=3`;

		// First attempt is immediate; subsequent attempts back off by pollInterval.
		for (let attempt = 0; ; attempt++) {
			const body = await this.httpGet(url);

			// The real report has a FlexQueryResponse root; a FlexStatementResponse
			// root here means either "still generating" (retry) or a hard error.
			if (body.includes("<FlexQueryResponse")) {
				return body;
			}

			const status = parseStatementResponse(body);
			if (status.errorCode && RETRYABLE_CODES.has(status.errorCode)) {
				if (Date.now() >= deadline) {
					throw new Error(
						`Flex statement not ready after ${Math.round(maxWait / 1000)}s (last: ${status.errorCode} ${status.errorMessage ?? ""})`,
					);
				}
				this.logger.info(`Flex statement generating (${status.errorCode}); retrying in ${pollInterval}ms`);
				await delay(pollInterval);
				continue;
			}

			throw new Error(
				`Flex GetStatement failed: ${status.errorCode ?? "?"} ${status.errorMessage ?? body.slice(0, 200)}`,
			);
		}
	}

	private async httpGet(url: string): Promise<string> {
		const res = await fetch(url, {
			headers: { "User-Agent": "claw-mafia-finance/0.1 (Flex Web Service client)" },
		});
		if (!res.ok) {
			throw new Error(`Flex HTTP ${res.status} ${res.statusText}`);
		}
		return res.text();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── XML parsing ──
//
// Flex responses are flat: control fields are simple text elements and every
// trade is a single self-closing element whose data lives entirely in its
// attributes. That structure is stable and well documented, so a small
// attribute scanner is more robust here than pulling in a full XML dependency.

function parseStatementResponse(xml: string): FlexStatementResponse {
	return {
		status: getElementText(xml, "Status") ?? "",
		referenceCode: getElementText(xml, "ReferenceCode"),
		url: getElementText(xml, "Url"),
		errorCode: getElementText(xml, "ErrorCode"),
		errorMessage: getElementText(xml, "ErrorMessage"),
	};
}

function getElementText(xml: string, tag: string): string | null {
	const match = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(xml);
	return match ? decodeEntities(match[1]) : null;
}

function parseTrades(xml: string): FlexTrade[] {
	// Activity Flex emits <Trade .../>; Trade Confirmation Flex emits
	// <TradeConfirm .../>. Collect both so either query type works.
	const elements = [
		...extractElements(xml, "Trade"),
		...extractElements(xml, "TradeConfirm"),
	];
	return elements.map(normalizeTrade);
}

/** Return the attribute maps of every `<tag ... />` element in the document. */
function extractElements(xml: string, tag: string): Array<Record<string, string>> {
	// Match the exact tag name only (word boundary), self-closing or not, and
	// avoid matching longer tags that share the prefix (e.g. "Trade" vs
	// "TradeConfirm") via the trailing whitespace/`>` guard.
	const re = new RegExp(`<${tag}(\\s[^>]*?)/?>`, "g");
	const out: Array<Record<string, string>> = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) {
		out.push(parseAttributes(m[1]));
	}
	return out;
}

function parseAttributes(attrText: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(attrText)) !== null) {
		attrs[m[1]] = decodeEntities(m[2]);
	}
	return attrs;
}

function normalizeTrade(a: Record<string, string>): FlexTrade {
	// Attribute names differ slightly between Activity Flex and Trade
	// Confirmation Flex, so read each field with fallbacks.
	const rawDate = pick(a, "tradeDate", "dateTime", "date", "reportDate") ?? "";
	return {
		date: normalizeDate(rawDate),
		datetime: pick(a, "dateTime", "orderTime") ?? null,
		symbol: pick(a, "symbol", "underlyingSymbol") ?? "",
		asset_category: pick(a, "assetCategory") ?? "",
		side: pick(a, "buySell") ?? "",
		quantity: num(pick(a, "quantity")) ?? 0,
		price: num(pick(a, "tradePrice", "price")) ?? 0,
		proceeds: num(pick(a, "proceeds")),
		commission: num(pick(a, "ibCommission", "commission")),
		realized_pnl: num(pick(a, "fifoPnlRealized", "realizedPnl")),
		currency: pick(a, "currency") ?? "",
		exchange: pick(a, "exchange", "listingExchange") ?? "",
		put_call: pick(a, "putCall") ?? "",
		strike: num(pick(a, "strike")),
		expiry: pick(a, "expiry", "lastTradeDate") ?? "",
		conid: pick(a, "conid") ?? "",
		trade_id: pick(a, "tradeID", "tradeId") ?? "",
		order_id: pick(a, "ibOrderID", "orderID", "ibExecID") ?? "",
		account_id: pick(a, "accountId", "account") ?? "",
	};
}

function pick(a: Record<string, string>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const v = a[key];
		if (v !== undefined && v !== "") return v;
	}
	return undefined;
}

function num(value: string | undefined): number | null {
	if (value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** IBKR dates are YYYYMMDD (sometimes with a time suffix); emit YYYY-MM-DD. */
function normalizeDate(raw: string): string {
	const digits = raw.replace(/[^0-9]/g, "");
	if (digits.length >= 8) {
		return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
	}
	return raw;
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

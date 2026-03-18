"""
Paper trading broker engine with SQLite persistence.

Usage: python3 paper_broker.py <input.json> <output.json>

Input JSON: { "command": "...", "params": {...}, "data_dir": "..." }
Output JSON: written to output.json
"""
import sys
import json
import os
import uuid
import sqlite3
import math
from datetime import datetime, date, timezone


# ─── Utilities ────────────────────────────────────────────────────────────────

def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_occ_symbol(symbol: str) -> dict:
    """
    Parse simplified OCC-format symbol: underlying_expiry_strike_type
    e.g. AAPL_20241220_190_C
    Returns dict with keys: underlying, expiry, strike, option_type (call/put)
    Returns None if not parseable.
    """
    parts = symbol.split("_")
    if len(parts) < 4:
        return None
    try:
        underlying = parts[0]
        expiry = parts[1]
        strike = float(parts[2])
        opt_char = parts[3].upper()
        option_type = "call" if opt_char == "C" else "put"
        return {
            "underlying": underlying,
            "expiry": expiry,
            "strike": strike,
            "option_type": option_type,
        }
    except (ValueError, IndexError):
        return None


def build_occ_symbol(underlying: str, expiry: str, strike: float, option_type: str) -> str:
    """Build simplified OCC-format symbol."""
    opt_char = "C" if option_type.lower() == "call" else "P"
    # Format strike: strip trailing .0 if integer
    if strike == int(strike):
        strike_str = str(int(strike))
    else:
        strike_str = str(strike)
    return f"{underlying}_{expiry}_{strike_str}_{opt_char}"


# ─── Database Setup ────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  order_type TEXT NOT NULL,
  limit_price REAL,
  status TEXT NOT NULL,
  fill_price REAL,
  fill_quantity INTEGER,
  submitted_at TEXT NOT NULL,
  filled_at TEXT,
  cancelled_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS positions (
  position_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  avg_cost REAL NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  is_open INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS account (
  account_id TEXT PRIMARY KEY DEFAULT 'default',
  cash REAL NOT NULL,
  initial_capital REAL NOT NULL,
  created_at TEXT NOT NULL
);
"""


def get_db(data_dir: str) -> sqlite3.Connection:
    """Open (and initialise schema of) the SQLite database."""
    db_dir = os.path.join(data_dir, "paper_accounts")
    os.makedirs(db_dir, exist_ok=True)
    db_path = os.path.join(db_dir, "default.db")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    with conn:
        conn.executescript(SCHEMA)
    return conn


def ensure_account(conn: sqlite3.Connection, initial_capital: float = 100_000.0) -> sqlite3.Row:
    """Return the account row, creating it if it does not exist."""
    row = conn.execute("SELECT * FROM account WHERE account_id = 'default'").fetchone()
    if row is None:
        now = utcnow_iso()
        with conn:
            conn.execute(
                "INSERT INTO account (account_id, cash, initial_capital, created_at) VALUES ('default', ?, ?, ?)",
                (initial_capital, initial_capital, now),
            )
        row = conn.execute("SELECT * FROM account WHERE account_id = 'default'").fetchone()
    return row


# ─── Period helpers ────────────────────────────────────────────────────────────

def period_bounds(period: str):
    """Return (start_iso, end_iso) strings for the named period, or (None, None)."""
    today = date.today()
    if period == "today":
        start = today.isoformat()
        end = today.isoformat()
    elif period == "mtd":
        start = today.replace(day=1).isoformat()
        end = today.isoformat()
    elif period == "ytd":
        start = today.replace(month=1, day=1).isoformat()
        end = today.isoformat()
    elif period in (None, "inception", ""):
        return None, None
    else:
        return None, None
    return start, end


# ─── Command handlers ──────────────────────────────────────────────────────────

def cmd_init_account(conn: sqlite3.Connection, params: dict) -> dict:
    initial_capital = float(params.get("initial_capital", 100_000.0))
    row = ensure_account(conn, initial_capital)
    return {
        "account_id": row["account_id"],
        "cash": row["cash"],
        "initial_capital": row["initial_capital"],
        "created_at": row["created_at"],
    }


def cmd_get_account(conn: sqlite3.Connection, params: dict) -> dict:
    row = conn.execute("SELECT * FROM account WHERE account_id = 'default'").fetchone()
    if row is None:
        row = ensure_account(conn)
    return {
        "account_id": row["account_id"],
        "cash": row["cash"],
        "initial_capital": row["initial_capital"],
        "created_at": row["created_at"],
    }


def cmd_submit_order(conn: sqlite3.Connection, params: dict, data_dir: str) -> dict:
    # ── Required params ──────────────────────────────────────────────────────
    symbol = params.get("symbol")
    asset_type = params.get("asset_type", "stock").lower()
    side = params.get("side", "").lower()
    quantity = int(params.get("quantity", 0))
    order_type = params.get("order_type", "market").lower()
    limit_price = params.get("limit_price")
    strategy_id = params.get("strategy_id", "default")
    slippage_bps = float(params.get("slippage_bps", 5))

    if not symbol:
        return {"error": "symbol is required"}
    if side not in ("buy", "sell"):
        return {"error": "side must be 'buy' or 'sell'"}
    if quantity <= 0:
        return {"error": "quantity must be positive"}
    if limit_price is None:
        return {"error": "limit_price is required (provide current market price for market orders)"}

    limit_price = float(limit_price)

    # ── Ensure account exists ─────────────────────────────────────────────────
    account_row = ensure_account(conn)

    # ── Determine fill price ──────────────────────────────────────────────────
    slippage = slippage_bps / 10_000.0
    if order_type == "market":
        if side == "buy":
            fill_price = limit_price * (1.0 + slippage)
        else:
            fill_price = limit_price * (1.0 - slippage)
    else:
        # Limit order: fill immediately at limit_price (paper simplification)
        fill_price = limit_price

    # ── Commission ────────────────────────────────────────────────────────────
    # 0.65 per contract for options, 0 for stock
    if asset_type == "option":
        commission = 0.65 * quantity
    else:
        commission = 0.0

    # ── Cash impact ───────────────────────────────────────────────────────────
    # Options: 1 contract = 100 shares notional
    multiplier = 100 if asset_type == "option" else 1
    notional = fill_price * quantity * multiplier

    if side == "buy":
        cash_delta = -(notional + commission)
    else:
        cash_delta = notional - commission

    new_cash = account_row["cash"] + cash_delta
    # Allow negative cash in paper trading (no margin check)

    # ── Timestamps ────────────────────────────────────────────────────────────
    now = utcnow_iso()
    order_id = str(uuid.uuid4())

    # ── Update positions ──────────────────────────────────────────────────────
    position_id = None
    if side == "buy":
        # Check for existing open long position
        existing = conn.execute(
            "SELECT * FROM positions WHERE strategy_id=? AND symbol=? AND side='long' AND is_open=1",
            (strategy_id, symbol),
        ).fetchone()
        if existing:
            # Update avg cost and quantity
            old_qty = existing["quantity"]
            old_cost = existing["avg_cost"]
            new_qty = old_qty + quantity
            new_avg_cost = (old_cost * old_qty + fill_price * quantity) / new_qty
            with conn:
                conn.execute(
                    "UPDATE positions SET quantity=?, avg_cost=? WHERE position_id=?",
                    (new_qty, new_avg_cost, existing["position_id"]),
                )
            position_id = existing["position_id"]
        else:
            position_id = str(uuid.uuid4())
            with conn:
                conn.execute(
                    """INSERT INTO positions
                       (position_id, strategy_id, symbol, asset_type, side, quantity, avg_cost, opened_at, is_open)
                       VALUES (?, ?, ?, ?, 'long', ?, ?, ?, 1)""",
                    (position_id, strategy_id, symbol, asset_type, quantity, fill_price, now),
                )
    else:
        # sell: close existing long first, then create short if remainder
        remaining_to_sell = quantity

        # Find existing open long positions (FIFO)
        existing_longs = conn.execute(
            "SELECT * FROM positions WHERE strategy_id=? AND symbol=? AND side='long' AND is_open=1 ORDER BY opened_at ASC",
            (strategy_id, symbol),
        ).fetchall()

        for pos in existing_longs:
            if remaining_to_sell <= 0:
                break
            pos_qty = pos["quantity"]
            if pos_qty <= remaining_to_sell:
                # Close entire position
                with conn:
                    conn.execute(
                        "UPDATE positions SET is_open=0, closed_at=? WHERE position_id=?",
                        (now, pos["position_id"]),
                    )
                position_id = pos["position_id"]
                remaining_to_sell -= pos_qty
            else:
                # Partially reduce position
                with conn:
                    conn.execute(
                        "UPDATE positions SET quantity=? WHERE position_id=?",
                        (pos_qty - remaining_to_sell, pos["position_id"]),
                    )
                position_id = pos["position_id"]
                remaining_to_sell = 0

        if remaining_to_sell > 0:
            # Open a short position for the remainder
            position_id = str(uuid.uuid4())
            with conn:
                conn.execute(
                    """INSERT INTO positions
                       (position_id, strategy_id, symbol, asset_type, side, quantity, avg_cost, opened_at, is_open)
                       VALUES (?, ?, ?, ?, 'short', ?, ?, ?, 1)""",
                    (position_id, strategy_id, symbol, asset_type, remaining_to_sell, fill_price, now),
                )

    # ── Write order ────────────────────────────────────────────────────────────
    with conn:
        conn.execute(
            """INSERT INTO orders
               (order_id, strategy_id, symbol, asset_type, side, quantity, order_type,
                limit_price, status, fill_price, fill_quantity, submitted_at, filled_at, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'filled', ?, ?, ?, ?, ?)""",
            (
                order_id, strategy_id, symbol, asset_type, side, quantity, order_type,
                limit_price, fill_price, quantity, now, now,
                f"commission={commission:.4f}",
            ),
        )
        conn.execute(
            "UPDATE account SET cash=? WHERE account_id='default'",
            (new_cash,),
        )

    return {
        "order_id": order_id,
        "status": "filled",
        "fill_price": round(fill_price, 6),
        "fill_quantity": quantity,
        "commission": round(commission, 4),
        "cash_after": round(new_cash, 4),
        "position_id": position_id,
        "message": f"Order filled: {side} {quantity}x {symbol} @ {fill_price:.4f}",
    }


def cmd_cancel_order(conn: sqlite3.Connection, params: dict) -> dict:
    order_id = params.get("order_id")
    if not order_id:
        return {"error": "order_id is required"}

    row = conn.execute("SELECT * FROM orders WHERE order_id=?", (order_id,)).fetchone()
    if row is None:
        return {"error": f"Order {order_id} not found"}

    if row["status"] == "filled":
        return {"error": f"Order {order_id} is already filled and cannot be cancelled"}
    if row["status"] == "cancelled":
        return {"error": f"Order {order_id} is already cancelled"}

    now = utcnow_iso()
    with conn:
        conn.execute(
            "UPDATE orders SET status='cancelled', cancelled_at=? WHERE order_id=?",
            (now, order_id),
        )
    return {"order_id": order_id, "status": "cancelled"}


def cmd_get_positions(conn: sqlite3.Connection, params: dict) -> dict:
    strategy_id = params.get("strategy_id")

    if strategy_id:
        rows = conn.execute(
            "SELECT * FROM positions WHERE is_open=1 AND strategy_id=? ORDER BY opened_at DESC",
            (strategy_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM positions WHERE is_open=1 ORDER BY opened_at DESC"
        ).fetchall()

    positions = []
    for row in rows:
        positions.append({
            "position_id": row["position_id"],
            "strategy_id": row["strategy_id"],
            "symbol": row["symbol"],
            "asset_type": row["asset_type"],
            "side": row["side"],
            "quantity": row["quantity"],
            "avg_cost": row["avg_cost"],
            "opened_at": row["opened_at"],
            "unrealized_pnl": None,  # caller provides current price for MTM
        })

    return {"positions": positions, "count": len(positions)}


def cmd_get_pnl(conn: sqlite3.Connection, params: dict) -> dict:
    strategy_id = params.get("strategy_id")
    period = params.get("period", "inception")

    start_date, end_date = period_bounds(period)

    # Build query for closed positions
    query = "SELECT * FROM positions WHERE is_open=0"
    args = []

    if strategy_id:
        query += " AND strategy_id=?"
        args.append(strategy_id)

    if start_date:
        query += " AND closed_at >= ?"
        args.append(start_date)
    if end_date:
        # Include the full end day
        query += " AND closed_at < ?"
        # Add one day to end_date for inclusive upper bound
        try:
            end_dt = datetime.strptime(end_date, "%Y-%m-%d")
            from datetime import timedelta
            next_day = (end_dt + timedelta(days=1)).strftime("%Y-%m-%d")
            args.append(next_day)
        except ValueError:
            args.append(end_date)

    rows = conn.execute(query, args).fetchall()

    # For each closed position, we need to look up the fill price from the
    # corresponding sell/close order to compute realized PnL.
    # Realized PnL = (close_price - avg_cost) * qty * multiplier  (for longs)
    #              = (avg_cost - close_price) * qty * multiplier  (for shorts)
    # We approximate close_price by looking at orders with same symbol/strategy
    # that were filled around the closed_at time.

    total_pnl = 0.0
    positions_closed = 0
    by_strategy = {}

    for pos in rows:
        sid = pos["strategy_id"]
        symbol = pos["symbol"]
        asset_type = pos["asset_type"]
        qty = pos["quantity"]
        avg_cost = pos["avg_cost"]
        closed_at = pos["closed_at"] or ""
        pos_side = pos["side"]
        multiplier = 100 if asset_type == "option" else 1

        # Find the closing order: a sell (for long) or buy (for short) filled around closed_at
        close_side = "sell" if pos_side == "long" else "buy"
        close_order = conn.execute(
            """SELECT * FROM orders
               WHERE strategy_id=? AND symbol=? AND side=? AND status='filled'
               AND filled_at <= ? AND filled_at >= ?
               ORDER BY ABS(JULIANDAY(filled_at) - JULIANDAY(?)) ASC
               LIMIT 1""",
            (sid, symbol, close_side, closed_at, closed_at[:10], closed_at),
        ).fetchone()

        if close_order:
            close_price = close_order["fill_price"]
        else:
            # Fallback: use avg_cost (zero PnL) if no matching order found
            close_price = avg_cost

        if pos_side == "long":
            pnl = (close_price - avg_cost) * qty * multiplier
        else:
            pnl = (avg_cost - close_price) * qty * multiplier

        # Subtract commission from order if available
        commission = 0.0
        if close_order and close_order["notes"]:
            try:
                note = close_order["notes"]
                if "commission=" in note:
                    commission = float(note.split("commission=")[1].split(",")[0])
            except (ValueError, IndexError):
                pass
        pnl -= commission

        total_pnl += pnl
        positions_closed += 1

        if sid not in by_strategy:
            by_strategy[sid] = {"realized_pnl": 0.0, "positions_closed": 0}
        by_strategy[sid]["realized_pnl"] += pnl
        by_strategy[sid]["positions_closed"] += 1

    return {
        "period": period or "inception",
        "realized_pnl": round(total_pnl, 4),
        "positions_closed": positions_closed,
        "by_strategy": {k: {**v, "realized_pnl": round(v["realized_pnl"], 4)} for k, v in by_strategy.items()},
    }


def cmd_roll_position(conn: sqlite3.Connection, params: dict) -> dict:
    position_id = params.get("position_id")
    new_expiry = params.get("new_expiry")
    new_strike = params.get("new_strike")

    if not position_id:
        return {"error": "position_id is required"}
    if not new_expiry:
        return {"error": "new_expiry is required"}

    pos = conn.execute("SELECT * FROM positions WHERE position_id=?", (position_id,)).fetchone()
    if pos is None:
        return {"error": f"Position {position_id} not found"}
    if not pos["is_open"]:
        return {"error": f"Position {position_id} is already closed"}
    if pos["asset_type"] != "option":
        return {"error": "roll_position only supports option positions"}

    # Parse existing symbol to get underlying/strike/type
    parsed = parse_occ_symbol(pos["symbol"])
    if parsed is None:
        return {"error": f"Cannot parse OCC symbol: {pos['symbol']}"}

    underlying = parsed["underlying"]
    old_strike = parsed["strike"]
    old_option_type = parsed["option_type"]

    # Determine new strike (default to existing)
    if new_strike is None:
        new_strike = old_strike
    else:
        new_strike = float(new_strike)

    new_symbol = build_occ_symbol(underlying, new_expiry, new_strike, old_option_type)

    now = utcnow_iso()

    # Close old position
    with conn:
        conn.execute(
            "UPDATE positions SET is_open=0, closed_at=? WHERE position_id=?",
            (now, position_id),
        )

    # Open new position with same quantity/side/avg_cost
    new_position_id = str(uuid.uuid4())
    with conn:
        conn.execute(
            """INSERT INTO positions
               (position_id, strategy_id, symbol, asset_type, side, quantity, avg_cost, opened_at, is_open)
               VALUES (?, ?, ?, 'option', ?, ?, ?, ?, 1)""",
            (
                new_position_id,
                pos["strategy_id"],
                new_symbol,
                pos["side"],
                pos["quantity"],
                pos["avg_cost"],
                now,
            ),
        )

    return {
        "old_position_id": position_id,
        "new_position_id": new_position_id,
        "old_symbol": pos["symbol"],
        "new_symbol": new_symbol,
        "message": f"Rolled {pos['symbol']} -> {new_symbol}",
    }


def cmd_get_order_history(conn: sqlite3.Connection, params: dict) -> dict:
    strategy_id = params.get("strategy_id")
    start_date = params.get("start_date")
    end_date = params.get("end_date")

    query = "SELECT * FROM orders WHERE 1=1"
    args = []

    if strategy_id:
        query += " AND strategy_id=?"
        args.append(strategy_id)
    if start_date:
        query += " AND submitted_at >= ?"
        args.append(start_date)
    if end_date:
        query += " AND submitted_at <= ?"
        # Include the full end day
        if len(end_date) == 10:
            args.append(end_date + "T23:59:59.999999")
        else:
            args.append(end_date)

    query += " ORDER BY submitted_at DESC"

    rows = conn.execute(query, args).fetchall()

    orders = []
    for row in rows:
        orders.append({
            "order_id": row["order_id"],
            "strategy_id": row["strategy_id"],
            "symbol": row["symbol"],
            "asset_type": row["asset_type"],
            "side": row["side"],
            "quantity": row["quantity"],
            "order_type": row["order_type"],
            "limit_price": row["limit_price"],
            "status": row["status"],
            "fill_price": row["fill_price"],
            "fill_quantity": row["fill_quantity"],
            "submitted_at": row["submitted_at"],
            "filled_at": row["filled_at"],
            "cancelled_at": row["cancelled_at"],
            "notes": row["notes"],
        })

    return {"orders": orders, "count": len(orders)}


# ─── Dispatch ──────────────────────────────────────────────────────────────────

HANDLERS = {
    "init_account": cmd_init_account,
    "get_account": cmd_get_account,
    "submit_order": cmd_submit_order,
    "cancel_order": cmd_cancel_order,
    "get_positions": cmd_get_positions,
    "get_pnl": cmd_get_pnl,
    "roll_position": cmd_roll_position,
    "get_order_history": cmd_get_order_history,
}


def dispatch(command: str, params: dict, data_dir: str) -> dict:
    if command not in HANDLERS:
        return {"error": f"Unknown command: {command}"}

    conn = get_db(data_dir)
    try:
        handler = HANDLERS[command]
        # submit_order needs data_dir for potential OHLCV reads
        if command == "submit_order":
            result = handler(conn, params, data_dir)
        else:
            result = handler(conn, params)
        return result
    except Exception as exc:
        return {"error": str(exc), "command": command}
    finally:
        conn.close()


# ─── Entry point ───────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) != 3:
        error = {"error": "Usage: paper_broker.py <input.json> <output.json>"}
        print(json.dumps(error))
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    def write_result(result: dict):
        with open(output_path, "w") as f:
            json.dump(result, f, indent=2)

    try:
        with open(input_path) as f:
            payload = json.load(f)
    except Exception as exc:
        write_result({"error": f"Failed to read input: {exc}"})
        sys.exit(1)

    command = payload.get("command", "")
    params = payload.get("params", {})
    data_dir = payload.get("data_dir", ".")

    result = dispatch(command, params, data_dir)
    write_result(result)


if __name__ == "__main__":
    main()

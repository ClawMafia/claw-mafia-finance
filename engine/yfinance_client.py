"""
yfinance market data client for international and US equities.
Called by the TypeScript plugin via subprocess.

Usage: python3 yfinance_client.py <input.json> <output.json>

Supports: quotes, historical OHLCV, options chains, IV surfaces,
earnings calendar, and dividend history for any symbol yfinance covers
(US, HK, London, Euronext, Tokyo, etc.).
"""
import sys
import json
from datetime import datetime, timedelta

import yfinance as yf


def get_quote(params: dict) -> dict:
    """Get current quote for a symbol."""
    symbol = params["symbol"]
    ticker = yf.Ticker(symbol)
    info = ticker.info

    if not info or (info.get("trailingPegRatio") is None and info.get("regularMarketPrice") is None):
        # Try fast_info as fallback
        try:
            fi = ticker.fast_info
            return {
                "symbol": symbol,
                "price": fi.get("lastPrice") or fi.get("regularMarketPrice"),
                "open": fi.get("open") or fi.get("regularMarketOpen"),
                "high": fi.get("dayHigh") or fi.get("regularMarketDayHigh"),
                "low": fi.get("dayLow") or fi.get("regularMarketDayLow"),
                "prev_close": fi.get("previousClose") or fi.get("regularMarketPreviousClose"),
                "volume": fi.get("lastVolume") or fi.get("regularMarketVolume"),
                "market_cap": fi.get("marketCap"),
                "currency": fi.get("currency"),
                "source": "yfinance_fast_info",
            }
        except Exception:
            return {"symbol": symbol, "error": f"No data found for symbol: {symbol}"}

    return {
        "symbol": symbol,
        "price": info.get("regularMarketPrice") or info.get("currentPrice"),
        "bid": info.get("bid"),
        "ask": info.get("ask"),
        "open": info.get("regularMarketOpen") or info.get("open"),
        "high": info.get("regularMarketDayHigh") or info.get("dayHigh"),
        "low": info.get("regularMarketDayLow") or info.get("dayLow"),
        "prev_close": info.get("regularMarketPreviousClose") or info.get("previousClose"),
        "volume": info.get("regularMarketVolume") or info.get("volume"),
        "market_cap": info.get("marketCap"),
        "currency": info.get("currency"),
        "exchange": info.get("exchange"),
        "name": info.get("shortName") or info.get("longName"),
        "fifty_two_week_high": info.get("fiftyTwoWeekHigh"),
        "fifty_two_week_low": info.get("fiftyTwoWeekLow"),
        "trailing_pe": info.get("trailingPE"),
        "forward_pe": info.get("forwardPE"),
        "dividend_yield": info.get("dividendYield"),
        "source": "yfinance",
    }


def get_historical_ohlcv(params: dict) -> dict:
    """Fetch historical OHLCV bars."""
    symbol = params["symbol"]
    start_date = params["start_date"]
    end_date = params.get("end_date") or datetime.now().strftime("%Y-%m-%d")
    interval = params.get("interval", "1d")

    ticker = yf.Ticker(symbol)
    df = ticker.history(start=start_date, end=end_date, interval=interval)

    if df.empty:
        return {
            "symbol": symbol,
            "bars": [],
            "count": 0,
            "error": f"No historical data for {symbol} from {start_date} to {end_date}",
        }

    bars = []
    for idx, row in df.iterrows():
        bars.append({
            "t": idx.isoformat(),
            "o": round(row["Open"], 4),
            "h": round(row["High"], 4),
            "l": round(row["Low"], 4),
            "c": round(row["Close"], 4),
            "v": int(row["Volume"]),
        })

    return {
        "symbol": symbol,
        "start_date": start_date,
        "end_date": end_date,
        "interval": interval,
        "source": "yfinance",
        "bars": bars,
        "count": len(bars),
    }


def get_options_chain(params: dict) -> dict:
    """Fetch options chain for a symbol."""
    symbol = params["symbol"]
    ticker = yf.Ticker(symbol)

    try:
        expirations = ticker.options
    except Exception:
        return {
            "symbol": symbol,
            "available": False,
            "message": f"No options data available for {symbol}. Options are typically only available for US-listed equities.",
        }

    if not expirations:
        return {
            "symbol": symbol,
            "available": False,
            "message": f"No options expirations found for {symbol}.",
        }

    target_exp = params.get("expiration")
    strike_range_pct = params.get("strike_range_pct", 20)
    option_type = params.get("option_type")  # "call", "put", or None for both

    # If specific expiration requested, use it; otherwise pick nearest
    if target_exp and target_exp in expirations:
        selected_exps = [target_exp]
    elif target_exp:
        # Find closest expiration
        target_dt = datetime.strptime(target_exp, "%Y-%m-%d")
        closest = min(expirations, key=lambda e: abs((datetime.strptime(e, "%Y-%m-%d") - target_dt).days))
        selected_exps = [closest]
    else:
        # Return first 3 expirations
        selected_exps = list(expirations[:3])

    # Get current price for strike filtering
    try:
        fi = ticker.fast_info
        current_price = fi["lastPrice"]
    except Exception:
        current_price = None

    chains = []
    for exp in selected_exps:
        chain = ticker.option_chain(exp)
        result = {"expiration": exp, "calls": [], "puts": []}

        for label, df in [("calls", chain.calls), ("puts", chain.puts)]:
            if option_type and label != option_type + "s":
                continue

            for _, row in df.iterrows():
                strike = row["strike"]
                # Filter by strike range if we have a current price
                if current_price and strike_range_pct:
                    low_bound = current_price * (1 - strike_range_pct / 100)
                    high_bound = current_price * (1 + strike_range_pct / 100)
                    if strike < low_bound or strike > high_bound:
                        continue

                result[label].append({
                    "strike": strike,
                    "lastPrice": row.get("lastPrice"),
                    "bid": row.get("bid"),
                    "ask": row.get("ask"),
                    "volume": int(row["volume"]) if row.get("volume") and row["volume"] == row["volume"] else 0,
                    "openInterest": int(row["openInterest"]) if row.get("openInterest") and row["openInterest"] == row["openInterest"] else 0,
                    "impliedVolatility": round(row.get("impliedVolatility", 0), 4),
                    "inTheMoney": bool(row.get("inTheMoney", False)),
                })

        chains.append(result)

    return {
        "symbol": symbol,
        "current_price": current_price,
        "available_expirations": list(expirations),
        "chains": chains,
        "source": "yfinance",
    }


def get_iv_surface(params: dict) -> dict:
    """Build implied volatility surface from options chain data."""
    symbol = params["symbol"]
    ticker = yf.Ticker(symbol)

    try:
        expirations = ticker.options
    except Exception:
        return {
            "symbol": symbol,
            "available": False,
            "message": f"No options data available for {symbol}.",
        }

    if not expirations:
        return {"symbol": symbol, "available": False, "message": "No expirations found."}

    try:
        fi = ticker.fast_info
        current_price = fi["lastPrice"]
    except Exception:
        return {"symbol": symbol, "available": False, "message": "Cannot determine current price."}

    # Limit to first 8 expirations to keep response reasonable
    selected_exps = list(expirations[:8])

    surface = []
    all_strikes = set()

    for exp in selected_exps:
        try:
            chain = ticker.option_chain(exp)
        except Exception:
            continue

        exp_dt = datetime.strptime(exp, "%Y-%m-%d")
        dte = max((exp_dt - datetime.now()).days, 1)

        for _, row in chain.calls.iterrows():
            strike = row["strike"]
            iv = row.get("impliedVolatility", 0)
            # Only include strikes within 30% of current price
            if current_price * 0.7 <= strike <= current_price * 1.3 and iv > 0:
                all_strikes.add(strike)
                surface.append({
                    "expiration": exp,
                    "dte": dte,
                    "strike": strike,
                    "moneyness": round(strike / current_price, 4),
                    "iv": round(iv, 4),
                    "type": "call",
                })

        for _, row in chain.puts.iterrows():
            strike = row["strike"]
            iv = row.get("impliedVolatility", 0)
            if current_price * 0.7 <= strike <= current_price * 1.3 and iv > 0:
                all_strikes.add(strike)
                surface.append({
                    "expiration": exp,
                    "dte": dte,
                    "strike": strike,
                    "moneyness": round(strike / current_price, 4),
                    "iv": round(iv, 4),
                    "type": "put",
                })

    return {
        "symbol": symbol,
        "current_price": current_price,
        "expirations": selected_exps,
        "strikes": sorted(all_strikes),
        "surface": surface,
        "point_count": len(surface),
        "source": "yfinance",
    }


def get_earnings_calendar(params: dict) -> dict:
    """Get earnings dates for a list of symbols."""
    symbols = params.get("symbols", [])
    if not symbols:
        return {"error": "No symbols provided."}

    results = []
    for symbol in symbols:
        ticker = yf.Ticker(symbol)
        try:
            cal = ticker.calendar
            if cal is not None and not (hasattr(cal, "empty") and cal.empty):
                # calendar can be a dict or DataFrame depending on yfinance version
                if isinstance(cal, dict):
                    entry = {
                        "symbol": symbol,
                        "earnings_date": str(cal.get("Earnings Date", ["N/A"])[0]) if isinstance(cal.get("Earnings Date"), list) else str(cal.get("Earnings Date", "N/A")),
                        "revenue_estimate": cal.get("Revenue Estimate", None),
                        "earnings_estimate": cal.get("Earnings Estimate", None),
                    }
                else:
                    # DataFrame format
                    entry = {
                        "symbol": symbol,
                        "calendar": cal.to_dict() if hasattr(cal, "to_dict") else str(cal),
                    }
                results.append(entry)
            else:
                results.append({"symbol": symbol, "earnings_date": "N/A"})
        except Exception as e:
            results.append({"symbol": symbol, "error": str(e)})

    return {"earnings": results, "source": "yfinance"}


def get_dividend_history(params: dict) -> dict:
    """Get dividend history for a symbol."""
    symbol = params["symbol"]
    years = params.get("years", 3)
    ticker = yf.Ticker(symbol)

    start = (datetime.now() - timedelta(days=years * 365)).strftime("%Y-%m-%d")
    dividends = ticker.dividends

    if dividends is None or dividends.empty:
        return {
            "symbol": symbol,
            "dividends": [],
            "count": 0,
            "message": f"No dividend history found for {symbol}.",
        }

    # Filter by date range
    filtered = dividends[dividends.index >= start]
    records = [
        {"date": idx.strftime("%Y-%m-%d"), "amount": round(float(val), 4)}
        for idx, val in filtered.items()
    ]

    # Compute annualized yield if we have price
    annual_total = sum(r["amount"] for r in records[-4:]) if records else 0  # last ~4 payments
    try:
        fi = ticker.fast_info
        current_price = fi["lastPrice"]
        implied_yield = round(annual_total / current_price, 4) if current_price else None
    except Exception:
        current_price = None
        implied_yield = None

    return {
        "symbol": symbol,
        "dividends": records,
        "count": len(records),
        "recent_annual_total": round(annual_total, 4),
        "current_price": current_price,
        "implied_yield": implied_yield,
        "source": "yfinance",
    }


# ── CLI entry point ──

FUNCTIONS = {
    "get_quote": get_quote,
    "get_historical_ohlcv": get_historical_ohlcv,
    "get_options_chain": get_options_chain,
    "get_iv_surface": get_iv_surface,
    "get_earnings_calendar": get_earnings_calendar,
    "get_dividend_history": get_dividend_history,
}

if __name__ == "__main__":
    input_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(input_path) as f:
        request = json.load(f)

    func_name = request["function"]
    params = request["params"]

    if func_name not in FUNCTIONS:
        result = {"error": f"Unknown function: {func_name}"}
    else:
        try:
            result = FUNCTIONS[func_name](params)
        except Exception as e:
            result = {"error": str(e)}

    with open(output_path, "w") as f:
        json.dump(result, f, indent=2)

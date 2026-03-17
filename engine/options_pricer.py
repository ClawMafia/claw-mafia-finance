"""
Options pricing engine using Black-Scholes model.
Called by the TypeScript plugin via subprocess.

Usage: python3 options_pricer.py <input.json> <output.json>
"""
import sys
import json
import math
from scipy.stats import norm


def black_scholes(params: dict) -> dict:
    """Price a single option and compute greeks."""
    S = params["spot"]
    K = params["strike"]
    T = params["dte"] / 365.0
    r = params["risk_free_rate"]
    sigma = params["iv"]
    q = params.get("dividend_yield", 0.0)
    opt_type = params["option_type"]

    if T <= 0:
        # Expired
        if opt_type == "call":
            intrinsic = max(S - K, 0)
        else:
            intrinsic = max(K - S, 0)
        return {
            "price": intrinsic,
            "delta": 1.0 if (opt_type == "call" and S > K) else (-1.0 if (opt_type == "put" and S < K) else 0.0),
            "gamma": 0.0,
            "theta": 0.0,
            "vega": 0.0,
            "rho": 0.0,
        }

    d1 = (math.log(S / K) + (r - q + 0.5 * sigma**2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)

    if opt_type == "call":
        price = S * math.exp(-q * T) * norm.cdf(d1) - K * math.exp(-r * T) * norm.cdf(d2)
        delta = math.exp(-q * T) * norm.cdf(d1)
        rho = K * T * math.exp(-r * T) * norm.cdf(d2) / 100
    else:
        price = K * math.exp(-r * T) * norm.cdf(-d2) - S * math.exp(-q * T) * norm.cdf(-d1)
        delta = -math.exp(-q * T) * norm.cdf(-d1)
        rho = -K * T * math.exp(-r * T) * norm.cdf(-d2) / 100

    gamma = math.exp(-q * T) * norm.pdf(d1) / (S * sigma * math.sqrt(T))
    theta = (
        -(S * sigma * math.exp(-q * T) * norm.pdf(d1)) / (2 * math.sqrt(T))
        - r * K * math.exp(-r * T) * norm.cdf(d2 if opt_type == "call" else -d2) * (1 if opt_type == "call" else -1)
        + q * S * math.exp(-q * T) * norm.cdf(d1 if opt_type == "call" else -d1) * (1 if opt_type == "call" else -1)
    ) / 365
    vega = S * math.exp(-q * T) * math.sqrt(T) * norm.pdf(d1) / 100

    return {
        "price": round(price, 4),
        "delta": round(delta, 4),
        "gamma": round(gamma, 6),
        "theta": round(theta, 4),
        "vega": round(vega, 4),
        "rho": round(rho, 4),
        "inputs": {"S": S, "K": K, "T_days": params["dte"], "r": r, "sigma": sigma, "q": q, "type": opt_type},
    }


def payoff(params: dict) -> dict:
    """Calculate payoff diagram for a multi-leg options structure."""
    legs = params["legs"]
    underlying_price = params["underlying_price"]
    range_pct = params.get("price_range_pct", 20)

    low = underlying_price * (1 - range_pct / 100)
    high = underlying_price * (1 + range_pct / 100)
    prices = [low + (high - low) * i / 100 for i in range(101)]

    total_cost = 0.0
    payoffs = []

    for price in prices:
        total_pnl = 0.0
        for leg in legs:
            qty = leg["quantity"]
            side_mult = 1 if leg["side"] == "buy" else -1

            if leg["type"] == "stock":
                pnl = (price - underlying_price) * qty * side_mult
            elif leg["type"] == "call":
                intrinsic = max(price - leg["strike"], 0)
                premium = leg.get("premium", 0)
                pnl = (intrinsic - premium) * qty * 100 * side_mult
            elif leg["type"] == "put":
                intrinsic = max(leg["strike"] - price, 0)
                premium = leg.get("premium", 0)
                pnl = (intrinsic - premium) * qty * 100 * side_mult
            else:
                pnl = 0

            total_pnl += pnl

        payoffs.append({"underlying_price": round(price, 2), "pnl": round(total_pnl, 2)})

    # Key metrics
    max_profit = max(p["pnl"] for p in payoffs)
    max_loss = min(p["pnl"] for p in payoffs)
    breakevens = []
    for i in range(1, len(payoffs)):
        if payoffs[i - 1]["pnl"] * payoffs[i]["pnl"] < 0:
            breakevens.append(round((payoffs[i - 1]["underlying_price"] + payoffs[i]["underlying_price"]) / 2, 2))

    return {
        "payoff_curve": payoffs,
        "max_profit": max_profit,
        "max_loss": max_loss,
        "breakeven_prices": breakevens,
        "current_price": underlying_price,
    }


def portfolio_greeks(params: dict) -> dict:
    """Calculate aggregated portfolio greeks."""
    positions = params["positions"]
    r = params.get("risk_free_rate", 0.05)
    today = __import__("datetime").date.today()

    by_underlying = {}
    totals = {"delta": 0, "gamma": 0, "theta": 0, "vega": 0}

    for pos in positions:
        symbol = pos["symbol"]
        if symbol not in by_underlying:
            by_underlying[symbol] = {"delta": 0, "gamma": 0, "theta": 0, "vega": 0}

        if pos["type"] == "stock":
            d = pos["quantity"]
            by_underlying[symbol]["delta"] += d
            totals["delta"] += d
            continue

        # For options, compute greeks
        spot = pos.get("spot", 100)
        iv = pos.get("iv", 0.25)
        exp_str = pos.get("expiration", "")
        strike = pos.get("strike", spot)

        if exp_str:
            exp_date = __import__("datetime").date.fromisoformat(exp_str)
            dte = max((exp_date - today).days, 0)
        else:
            dte = 30

        greeks = black_scholes({
            "spot": spot,
            "strike": strike,
            "dte": dte,
            "risk_free_rate": r,
            "iv": iv,
            "option_type": pos["type"],
        })

        multiplier = pos["quantity"] * 100  # options are per 100 shares

        for greek in ["delta", "gamma", "theta", "vega"]:
            val = greeks[greek] * multiplier
            by_underlying[symbol][greek] += round(val, 4)
            totals[greek] += val

    for greek in totals:
        totals[greek] = round(totals[greek], 4)

    return {"by_underlying": by_underlying, "totals": totals}


# ── CLI entry point ──

FUNCTIONS = {
    "black_scholes": black_scholes,
    "payoff": payoff,
    "portfolio_greeks": portfolio_greeks,
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

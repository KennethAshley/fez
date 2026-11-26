"""Read every gamma service registered on chain, run the free checks, write status.json.

Usage: .venv/bin/python run.py [network]
Sends only GET requests. Signed requests use a hotkey generated for this run and never funded.
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import bittensor as bt
import requests
from bittensor_wallet import Keypair

import checks

HERE = Path(__file__).resolve().parent
AGENT = {"User-Agent": "gamma-status-check"}
TIMEOUT = 15
ROUTES_TRIED = 3


def fetch(url, headers=None):
    """(status, parsed JSON or None, response headers); status 0 when nothing answered."""
    try:
        response = requests.get(url, headers={**AGENT, **(headers or {})}, timeout=TIMEOUT)
    except requests.RequestException as error:
        return 0, None, {"error": type(error).__name__}
    try:
        body = response.json()
    except ValueError:
        body = None
    return response.status_code, body, response.headers


def signed(key, url, receiver):
    parts = urlsplit(url)
    path = (parts.path or "/") + ("?" + parts.query if parts.query else "")
    return bt.http_auth.sign(key, method="GET", path=path, body=b"", receiver_ss58=receiver)


def service(netuid, hotkey, url, enabled, key):
    out = [
        checks.result(
            "enabled",
            "pass" if enabled else "fail",
            "" if enabled else "Minting is off for this subnet.",
        )
    ]
    status, doc, headers = fetch(url)
    reached = status == 200
    out.append(
        checks.result("reachable", "pass" if reached else "fail", "" if reached else f"HTTP {status}")
    )
    doc = doc if reached and isinstance(doc, dict) else None
    out += checks.document(doc, netuid, hotkey, headers.get("Access-Control-Allow-Origin"))

    balance_url = checks.balance_url(doc)
    if balance_url:
        target = f"{balance_url}{'&' if '?' in balance_url else '?'}hotkey={key.ss58_address}"
        code, body, _ = fetch(target)
        if code in (401, 403):  # the standard lets the balance need the hotkey's own signature
            code, body, _ = fetch(target, signed(key, target, hotkey))
        out.append(checks.balance(code, body, key.ss58_address))
    else:
        out.append(checks.result("balance", "unknown", "No balance URL to call."))

    seen = []
    balance_path = urlsplit(balance_url).path if balance_url else None
    for spec_url in checks.spec_urls(doc):
        _, spec, _ = fetch(spec_url)
        for route in checks.get_routes(spec, spec_url, balance_path)[: ROUTES_TRIED - len(seen)]:
            code, body, _ = fetch(route, signed(key, route, hotkey))
            seen.append((route, code, body))
    out.append(checks.refusal(seen))
    name = doc.get("name") if doc else None
    return {
        "netuid": netuid,
        "name": name if isinstance(name, str) else None,
        "hotkey": hotkey,
        "url": url,
        "checks": out,
    }


def main(network="finney"):
    chain = bt.Subtensor(network=network)
    block = chain.block
    registered = [(k[0], k[1], v["url"]) for k, v in chain.query_map(("SubtensorModule", "Services"))]
    on = {
        netuid: bool(chain.query(("SubtensorModule", "SubnetGammaEnabled"), [netuid]))
        for netuid in {r[0] for r in registered}
    }
    key = Keypair.create_from_mnemonic(Keypair.generate_mnemonic())
    with ThreadPoolExecutor(8) as pool:
        services = list(pool.map(lambda r: service(*r, on[r[0]], key), sorted(registered)))
    report = {
        "standard": "Gamma Integration Standard V1.3",
        "network": network,
        "block": block,
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "services": services,
    }
    (HERE / "status.json").write_text(json.dumps(report, indent=1) + "\n")
    for s in services:
        marks = "".join({"pass": "+", "fail": "x", "unknown": "?"}[c["status"]] for c in s["checks"])
        print(f"{s['netuid']:>4} {marks} {s['name'] or s['url']}")


if __name__ == "__main__":
    main(*sys.argv[1:2])

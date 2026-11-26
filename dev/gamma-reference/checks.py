"""The checks of the Gamma Integration Standard V1.3 that cost nothing to run.

Each check returns {"id", "status", "detail"}; status is "pass", "fail" or "unknown".
"unknown" means this checker could not tell, never that the service is wrong.
"""

import json
import re
from urllib.parse import urljoin

MONEY = re.compile(r"\d+(\.\d+)?")


def result(check, status, detail=""):
    return {"id": check, "status": status, "detail": detail}


def _dicts(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def document(doc, netuid, hotkey, cors):
    """Requirement 1: the services document `set_service` points at."""
    out = [
        result("cors", "pass" if cors == "*" else "fail", f"Access-Control-Allow-Origin: {cors}")
    ]
    if not isinstance(doc, dict):
        out.insert(0, result("json", "fail", "The URL does not return a JSON object."))
        return out + [
            result(check, "unknown", "No document to read.")
            for check in ("publisher", "btauth", "balance_url", "spec", "pricing")
        ]
    out.insert(0, result("json", "pass"))
    listed = any(
        p.get("hotkey") == hotkey and p.get("netuid") == netuid for p in _dicts(doc.get("publishers"))
    )
    out.append(
        result(
            "publisher",
            "pass" if listed else "fail",
            "" if listed else "The hotkey registered on chain is not a listed publisher.",
        )
    )
    gamma = [p for p in _dicts(doc.get("payments")) if p.get("type") == "gamma"]
    signed = any(p.get("signature") == "btauth/1" for p in gamma)
    out.append(
        result(
            "btauth",
            "pass" if signed else "fail",
            "" if signed else 'No gamma payment entry with "signature": "btauth/1".',
        )
    )
    has_balance = bool(balance_url(doc))
    out.append(
        result(
            "balance_url",
            "pass" if has_balance else "fail",
            "" if has_balance else "The gamma payment entry has no balance URL.",
        )
    )
    specs = spec_urls(doc)
    out.append(
        result(
            "spec",
            "pass" if specs else "unknown",
            "" if specs else "No OpenAPI entry; other spec types are not checked.",
        )
    )
    priced = bool(doc.get("pricing"))
    out.append(
        result(
            "pricing",
            "pass" if priced else "unknown",
            "" if priced else "No pricing key; prices may be inside the spec.",
        )
    )
    return out


def balance_url(doc):
    for payment in _dicts(doc.get("payments")) if isinstance(doc, dict) else []:
        if payment.get("type") == "gamma" and isinstance(payment.get("balance"), str):
            return payment["balance"]
    return None


def spec_urls(doc):
    return [
        s["endpoint"]
        for s in (_dicts(doc.get("services")) if isinstance(doc, dict) else [])
        if s.get("type") == "openapi" and isinstance(s.get("endpoint"), str)
    ]


def get_routes(spec, spec_url, balance_path):
    """Full URLs of the spec's GET routes that take no path parameter, without the balance route."""
    if not isinstance(spec, dict) or "openapi" not in spec or not isinstance(spec.get("paths"), dict):
        return []
    servers = _dicts(spec.get("servers"))
    server = str(servers[0].get("url") or "/") if servers else "/"
    variables = servers[0].get("variables") if servers else None
    for name, variable in (variables if isinstance(variables, dict) else {}).items():
        if isinstance(variable, dict) and isinstance(variable.get("default"), str):
            server = server.replace("{" + name + "}", variable["default"])
    base = urljoin(spec_url, "/" if "{" in server else server)
    return [
        base.rstrip("/") + path
        for path, methods in spec["paths"].items()
        if isinstance(methods, dict) and "get" in methods and "{" not in path and path != balance_path
    ]


def balance(status, payload, hotkey):
    """Requirement 3: a hotkey never seen reads zero, in decimal strings, not a 404."""
    if status != 200 or not isinstance(payload, dict):
        return result("balance", "fail", f"HTTP {status} for a hotkey never seen; zeros expected.")
    fields = [payload.get(k) for k in ("credited_usd", "used_usd", "remaining_usd")]
    if not all(isinstance(v, str) and MONEY.fullmatch(v) for v in fields):
        return result("balance", "fail", "Amounts are not decimal strings: " + json.dumps(fields))
    if any(float(v) for v in fields):
        return result("balance", "fail", "A hotkey never funded has a balance: " + json.dumps(fields))
    return result("balance", "pass")


def refusal(seen):
    """Requirement 5: a signed request from a hotkey never funded gets a 402. `seen` is
    [(url, status, body)]. Other answers are unknown: the route tried may not be a paid one."""
    for url, status, body in seen:
        if status == 402 and "insufficient_balance" in json.dumps(body):
            return result("refuses", "pass", url)
    if not seen:
        return result("refuses", "unknown", "No GET route without parameters in an OpenAPI spec.")
    tried = ", ".join(f"{status} {url}" for url, status, _ in seen)
    return result("refuses", "unknown", "No 402 on the routes tried: " + tried)

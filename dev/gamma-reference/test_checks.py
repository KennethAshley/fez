"""The free checks of the Gamma Integration Standard V1.3, on fixed inputs (no network)."""

import unittest

import checks

HOTKEY = "5EKrpcqVNWfVfmKiq8v3LRrgb3E3ENBwYzmAziDhMK58gtb5"
USER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
GOOD = {
    "name": "Example",
    "description": "Things.",
    "publishers": [{"netuid": 7, "hotkey": HOTKEY}],
    "services": [{"type": "openapi", "endpoint": "https://api.example.com/openapi.json"}],
    "pricing": "https://api.example.com/pricing",
    "payments": [
        {"type": "gamma", "signature": "btauth/1", "balance": "https://api.example.com/balance"}
    ],
}


def status(results):
    return {r["id"]: r["status"] for r in results}


class DocumentTest(unittest.TestCase):
    def test_a_complete_document_passes_every_document_check(self):
        got = status(checks.document(GOOD, 7, HOTKEY, cors="*"))
        self.assertEqual(set(got.values()), {"pass"}, got)
        self.assertEqual(
            set(got), {"json", "cors", "publisher", "btauth", "balance_url", "spec", "pricing"}
        )

    def test_a_page_that_is_not_json_fails_json_and_leaves_the_rest_unknown(self):
        got = status(checks.document(None, 7, HOTKEY, cors="*"))
        self.assertEqual(got["json"], "fail")
        self.assertEqual({v for k, v in got.items() if k not in ("json", "cors")}, {"unknown"})

    def test_missing_cors_fails(self):
        self.assertEqual(status(checks.document(GOOD, 7, HOTKEY, cors=None))["cors"], "fail")

    def test_the_chain_hotkey_must_be_a_listed_publisher_of_this_subnet(self):
        other = {**GOOD, "publishers": [{"netuid": 8, "hotkey": HOTKEY}]}
        self.assertEqual(status(checks.document(other, 7, HOTKEY, cors="*"))["publisher"], "fail")

    def test_a_gamma_entry_without_btauth_or_balance_fails_those_checks(self):
        doc = {**GOOD, "payments": [{"type": "gamma"}]}
        got = status(checks.document(doc, 7, HOTKEY, cors="*"))
        self.assertEqual((got["btauth"], got["balance_url"]), ("fail", "fail"))

    def test_no_openapi_entry_and_no_pricing_key_are_unknown_not_failures(self):
        doc = {k: v for k, v in GOOD.items() if k != "pricing"}
        doc["services"] = [{"type": "http", "endpoint": "https://api.example.com"}]
        got = status(checks.document(doc, 7, HOTKEY, cors="*"))
        self.assertEqual((got["spec"], got["pricing"]), ("unknown", "unknown"))

    def test_malformed_fields_do_not_crash(self):
        doc = {"publishers": "x", "services": [3], "payments": {"type": "gamma"}}
        got = status(checks.document(doc, 7, HOTKEY, cors="*"))
        self.assertEqual(got["publisher"], "fail")


class RoutesTest(unittest.TestCase):
    SPEC = {
        "openapi": "3.1.0",
        "servers": [{"url": "https://api.example.com/base"}],
        "paths": {
            "/v1/models": {"get": {}},
            "/v1/jobs/{id}": {"get": {}},
            "/v1/run": {"post": {}},
            "/v1/gamma/balance": {"get": {}},
        },
    }

    def test_only_get_routes_without_parameters_and_never_the_balance_route(self):
        self.assertEqual(
            checks.get_routes(self.SPEC, "https://x.example/openapi.json", "/v1/gamma/balance"),
            ["https://api.example.com/base/v1/models"],
        )

    def test_without_servers_routes_resolve_against_the_spec_url(self):
        spec = {"openapi": "3.0.0", "paths": {"/a": {"get": {}}}}
        self.assertEqual(
            checks.get_routes(spec, "https://x.example/api/openapi.json", None),
            ["https://x.example/a"],
        )

    def test_server_variables_take_their_defaults_or_fall_back_to_the_spec_origin(self):
        spec = {
            "openapi": "3.1.0",
            "servers": [
                {"url": "{baseUrl}/api", "variables": {"baseUrl": {"default": "https://api.example.com"}}}
            ],
            "paths": {"/a": {"get": {}}},
        }
        self.assertEqual(
            checks.get_routes(spec, "https://x.example/s.json", None),
            ["https://api.example.com/api/a"],
        )
        spec["servers"] = [{"url": "{baseUrl}"}]
        self.assertEqual(
            checks.get_routes(spec, "https://x.example/s.json", None), ["https://x.example/a"]
        )

    def test_something_that_is_not_an_openapi_document_has_no_routes(self):
        self.assertEqual(checks.get_routes({"hello": 1}, "https://x.example/s.json", None), [])
        self.assertEqual(checks.get_routes(None, "https://x.example/s.json", None), [])


class BalanceTest(unittest.TestCase):
    ZERO = {"hotkey": USER, "credited_usd": "0", "used_usd": "0.00", "remaining_usd": "0.000"}

    def test_an_unknown_hotkey_reads_zero_in_decimal_strings(self):
        self.assertEqual(checks.balance(200, self.ZERO, USER)["status"], "pass")

    def test_a_404_or_numbers_instead_of_strings_fail(self):
        self.assertEqual(checks.balance(404, None, USER)["status"], "fail")
        self.assertEqual(
            checks.balance(200, {**self.ZERO, "remaining_usd": 0}, USER)["status"], "fail"
        )

    def test_a_never_funded_hotkey_with_money_fails(self):
        self.assertEqual(
            checks.balance(200, {**self.ZERO, "remaining_usd": "5.00"}, USER)["status"], "fail"
        )


class RefusalTest(unittest.TestCase):
    def test_a_402_naming_insufficient_balance_passes(self):
        seen = [("https://a/x", 404, None), ("https://a/y", 402, {"error": "insufficient_balance"})]
        self.assertEqual(checks.refusal(seen)["status"], "pass")

    def test_the_error_may_be_nested_as_long_as_the_body_names_it(self):
        seen = [("https://a/y", 402, {"error": {"code": "insufficient_balance"}})]
        self.assertEqual(checks.refusal(seen)["status"], "pass")

    def test_anything_else_is_unknown_because_the_route_may_not_be_a_paid_one(self):
        self.assertEqual(checks.refusal([("https://a/x", 200, {})])["status"], "unknown")
        self.assertEqual(checks.refusal([])["status"], "unknown")
        self.assertIn("401", checks.refusal([("https://a/x", 401, None)])["detail"])


if __name__ == "__main__":
    unittest.main()

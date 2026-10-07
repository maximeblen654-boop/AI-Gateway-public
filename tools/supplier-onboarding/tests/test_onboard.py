import importlib.util
import sys
import unittest
from unittest import mock
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "onboard.py"
SPEC = importlib.util.spec_from_file_location("supplier_onboard", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class OnboardTests(unittest.TestCase):
    def test_endpoint_does_not_duplicate_v1(self):
        self.assertEqual(
            MODULE.endpoint("https://example.test/v1", "/v1/responses"),
            "https://example.test/v1/responses",
        )

    def test_extract_sse_usage(self):
        text = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":2}}}\n\n'
        self.assertEqual(MODULE.extract_sse_usage(text), {"input_tokens": 2})

    def test_extract_sse_event_types_deduplicates_in_order(self):
        text = (
            'data: {"type":"response.created"}\n\n'
            'data: {"type":"response.output_text.delta"}\n\n'
            'data: {"type":"response.output_text.delta"}\n\n'
            'data: [DONE]\n\n'
        )
        self.assertEqual(
            MODULE.extract_sse_event_types(text),
            ["response.created", "response.output_text.delta"],
        )

    def test_response_summary_records_safe_fingerprint_and_shapes(self):
        result = MODULE.HTTPResult(
            status=400,
            headers={"server": "edge", "set-cookie": "secret", "content-type": "application/json"},
            body=b'{"error":{"message":"bad","code":"invalid_request"}}',
            first_byte_seconds=0.1,
            total_seconds=0.2,
        )
        summary = MODULE.response_summary(result)
        self.assertEqual(summary["response_headers"], {"server": "edge"})
        self.assertNotIn("set-cookie", summary["response_headers"])
        self.assertEqual(summary["error_shape"]["error"]["message"], "str")

    def test_request_preserves_first_byte_and_partial_body_on_incomplete_read(self):
        class PartialResponse:
            status = 200
            headers = {"Content-Type": "text/event-stream"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, size=None):
                if size == 1:
                    return b"a"
                raise MODULE.http.client.IncompleteRead(b"bc", 5)

        with mock.patch.object(MODULE.urllib.request, "urlopen", return_value=PartialResponse()):
            result = MODULE.request("GET", "https://example.test", timeout=1)
        self.assertEqual(result.body, b"abc")
        self.assertIn("IncompleteRead", result.read_error)
        self.assertLessEqual(result.first_byte_seconds, result.total_seconds)

    def test_aggregate_samples_preserves_timing_range(self):
        samples = [
            {"pass": True, "status": 200, "first_byte_seconds": 1.0, "total_seconds": 2.0},
            {"pass": True, "status": 200, "first_byte_seconds": 3.0, "total_seconds": 5.0},
        ]
        result = MODULE.aggregate_samples(samples)
        self.assertEqual(result["avg_first_byte_seconds"], 2.0)
        self.assertEqual(result["max_total_seconds"], 5.0)
        self.assertEqual(len(result["sample_timings"]), 2)

    def test_final_status_requires_configured_real_codex_cli(self):
        probe = {
            "stream": {"pass": True}, "codex_protocol": {"pass": True},
            "usage": True, "codex_cli": {"pass": False},
        }
        self.assertEqual(MODULE.final_status(probe, None), "NOT_READY")
        probe["codex_cli"]["pass"] = True
        self.assertEqual(MODULE.final_status(probe, None), "READY")

    def test_probe_retry_records_pre_response_transport_failure(self):
        failed = {"status": 0, "pass": False, "error": "tls eof"}
        passed = {"status": 200, "pass": True, "error": None}
        with mock.patch.object(MODULE, "probe_responses", side_effect=[failed, passed]):
            result = MODULE.probe_responses_with_retries(
                "https://example.test", "key", "model", stream=True,
                transport_retries=1,
            )
        self.assertTrue(result["pass"])
        self.assertEqual(result["transport_attempts"], 2)
        self.assertEqual(result["retry_errors"], ["tls eof"])

    def test_rejects_duplicate_lines(self):
        config = {
            "supplier": "A", "base_url": "https://example.test/v1",
            "provider": "openai_responses",
            "lines": [
                {"name": "one", "api_key_env": "K1", "model": "m", "product": "p1"},
                {"name": "one", "api_key_env": "K2", "model": "m", "product": "p2"},
            ],
        }
        with self.assertRaises(MODULE.OnboardingError):
            MODULE.validate_config(config)

    def test_rejects_secretless_line(self):
        config = {
            "supplier": "A", "base_url": "https://example.test/v1",
            "provider": "openai_responses",
            "lines": [{"name": "one", "model": "m", "product": "p"}],
        }
        with self.assertRaises(MODULE.OnboardingError):
            MODULE.validate_config(config)

    def test_billing_delta_requires_both_local_and_upstream_debits(self):
        result = MODULE.billing_delta(
            10.0, 9.99,
            {"balance": 5.0, "requests": 2.0, "actual_cost": 1.0},
            {"balance": 4.99, "requests": 3.0, "actual_cost": 1.01},
        )
        self.assertTrue(result["pass"])
        self.assertEqual(result["upstream_requests"], 1)
        self.assertEqual(result["upstream_snapshot_transport"]["before_attempts"], 1)

    def test_account_rate_limit_maps_to_native_base_rpm_extra(self):
        client = object.__new__(MODULE.Sub2APIClient)
        client.find_account = lambda _name: {"id": 9}
        captured = {}
        client.call = lambda method, path, payload=None, **_kwargs: captured.update(payload or {})
        with mock.patch.dict("os.environ", {"UPSTREAM_KEY": "test-only"}):
            account_id, action = client.ensure_account(
                {"supplier": "S", "base_url": "https://example.test/v1"},
                {
                    "name": "L", "account_name": "S / L", "api_key_env": "UPSTREAM_KEY",
                    "model": "m", "rate_limit_rpm": 25,
                },
                3,
                dry_run=False,
            )
        self.assertEqual((account_id, action), (9, "updated"))
        self.assertEqual(captured["extra"]["base_rpm"], 25)


if __name__ == "__main__":
    unittest.main()

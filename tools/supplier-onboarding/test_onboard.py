import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "onboard", Path(__file__).with_name("onboard.py")
)
assert SPEC and SPEC.loader
onboard = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = onboard
SPEC.loader.exec_module(onboard)


class FingerprintDiagnosticsTest(unittest.TestCase):
    def test_final_status_respects_required_non_stream(self):
        probe = {
            "stream": {"pass": True}, "codex_protocol": {"pass": True}, "usage": True,
            "non_stream": {"pass": False}, "expect_non_stream": True,
        }
        self.assertEqual(onboard.final_status(probe, None), "NOT_READY")
        probe["expect_non_stream"] = False
        self.assertEqual(onboard.final_status(probe, None), "READY")

    def test_artifacts_are_secret_free_and_include_all_requested_outputs(self):
        config = {
            "supplier": "Example", "base_url": "https://example.test/v1", "provider": "openai_responses",
            "lines": [{"name": "A01", "api_key_env": "EXAMPLE_KEY", "model": "public", "product": "Public"}],
        }
        probe = {
            "line": "A01", "model": "upstream", "product": "Public", "stream": {"pass": True},
            "non_stream": {"pass": True}, "codex_protocol": {"pass": True}, "usage": True,
            "fingerprint_diagnostics": {"status": "PASS"}, "reasoning": {}, "known_limitations": [],
        }
        report = {"compatibility": onboard.compatibility_report(config, [probe]), "risk": onboard.risk_report(config, [probe], [])}
        with tempfile.TemporaryDirectory() as directory:
            artifacts = onboard.write_artifacts(directory, config, report)
            self.assertEqual(set(artifacts), {"configuration_template", "compatibility_report", "risk_report", "onboarding_report"})
            rendered = Path(artifacts["onboarding_report"]).read_text(encoding="utf-8")
        self.assertNotIn("secret", rendered)
        self.assertIn('"compatibility"', rendered)
    def test_status_classification(self):
        self.assertEqual(onboard.status_classification(200), "PASS")
        self.assertEqual(onboard.status_classification(403), "FAIL")
        self.assertEqual(onboard.status_classification(0), "UNKNOWN")

    def test_response_headers_keep_names_but_redact_unsafe_values(self):
        result = onboard.HTTPResult(
            status=200,
            headers={
                "content-type": "application/json",
                "x-request-id": "safe-request-id",
                "set-cookie": "session=must-not-appear",
                "authorization": "Bearer must-not-appear",
            },
            body=b'{"id":"response-id","usage":{"input_tokens":1}}',
            first_byte_seconds=0.1,
            total_seconds=0.2,
            response_http_version="HTTP/1.1",
        )
        rendered = json.dumps(onboard.response_summary(result, request_user_agent="curl/8.5.0"))
        self.assertIn('"set-cookie": "[redacted]"', rendered)
        self.assertIn('"authorization": "[redacted]"', rendered)
        self.assertNotIn("must-not-appear", rendered)
        self.assertIn('"status_classification": "PASS"', rendered)
        self.assertIn('"response_http_version": "HTTP/1.1"', rendered)

    def test_python_urllib_rejection_is_reported_as_failure(self):
        def result_for_profile(*_args, **kwargs):
            is_python = kwargs["user_agent"].startswith("Python-urllib/")
            return {
                "status": 403 if is_python else 200,
                "status_classification": "FAIL" if is_python else "PASS",
                "request_fingerprint": {"user_agent": kwargs["user_agent"], "http_version": "HTTP/1.1"},
                "response_header_summary": {"content-type": "application/json"},
                "request_id": "request-id",
                "body_json_shape": {"error": {"message": "str"}} if is_python else {"id": "str"},
                "read_error": None,
            }

        with patch.object(onboard, "probe_responses_with_retries", side_effect=result_for_profile):
            report = onboard.probe_fingerprint_diagnostics(
                "https://example.test", "secret-not-recorded", "model", timeout=1, transport_retries=0
            )
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["reason"], "python_urllib_user_agent_rejected")
        self.assertEqual(report["profiles"]["controlled"]["status"], 200)
        self.assertEqual(report["profiles"]["python_urllib_reference"]["status"], 403)


if __name__ == "__main__":
    unittest.main()

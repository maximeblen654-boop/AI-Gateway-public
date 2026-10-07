import importlib.util
import json
import runpy
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


MODULE_PATH = Path(__file__).with_name("wizard.py")
SPEC = importlib.util.spec_from_file_location("supplier_wizard", MODULE_PATH)
wizard = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = wizard
SPEC.loader.exec_module(wizard)


def sample_input(**overrides):
    values = {
        "supplier": "Supplier A",
        "base_url": "https://supplier.example/v1",
        "api_key": "secret-value",
        "line_name": "A01",
        "upstream_model": "upstream-model",
        "public_model": "public-model",
        "product": "Public Model A01",
        "account_name": "Supplier A / A01",
        "product_description": "Supplier A A01 product pool",
        "concurrency": 1,
        "rate_limit_rpm": 0,
        "priority": 0,
        "expect_non_stream": True,
        "known_limitations": [],
        "probe_models": False,
        "samples": 1,
        "timeout_seconds": 120,
        "cost_multiplier": Decimal("0.8"),
        "target_margin_percent": Decimal("20"),
        "channel_fee_percent": Decimal("0"),
        "risk_reserve_percent": Decimal("0"),
        "price_multiplier": Decimal("1"),
    }
    values.update(overrides)
    return wizard.WizardInput(**values)


class WizardTests(unittest.TestCase):
    def test_price_multiplier(self):
        result = wizard.calculate_price_multiplier(
            Decimal("0.8"), Decimal("20"), Decimal("0"), Decimal("0")
        )
        self.assertEqual(Decimal("1.00000000"), result)

    def test_price_multiplier_includes_fee_and_reserve(self):
        result = wizard.calculate_price_multiplier(
            Decimal("0.8"), Decimal("20"), Decimal("3"), Decimal("5")
        )
        self.assertEqual(Decimal("1.09090909"), result)

    def test_price_multiplier_rejects_impossible_margin(self):
        with self.assertRaises(wizard.WizardError):
            wizard.calculate_price_multiplier(
                Decimal("1"), Decimal("90"), Decimal("10"), Decimal("0")
            )

    def test_price_multiplier_rejects_zero_cost(self):
        with self.assertRaises(wizard.WizardError):
            wizard.calculate_price_multiplier(
                Decimal("0"), Decimal("20"), Decimal("0"), Decimal("0")
            )

    def test_generated_config_has_no_secret(self):
        data = sample_input()
        config = wizard.build_onboarding_config(data)
        rendered = json.dumps(config)
        self.assertNotIn(data.api_key, rendered)
        self.assertEqual("SUPPLIER_A_A01_API_KEY", config["lines"][0]["api_key_env"])
        self.assertEqual("public-model", config["lines"][0]["model"])
        self.assertEqual("upstream-model", config["lines"][0]["upstream_model"])

    def test_generated_config_passes_existing_onboarding_validation(self):
        config = wizard.build_onboarding_config(sample_input())
        onboarding = runpy.run_path(str(wizard.DEFAULT_ONBOARDING))
        onboarding["validate_config"](config)

    def test_non_ascii_supplier_gets_stable_env_slug(self):
        first = wizard.normalize_env_slug("供应商甲", "SUPPLIER")
        second = wizard.normalize_env_slug("供应商甲", "SUPPLIER")
        self.assertEqual(first, second)
        self.assertRegex(first, r"^SUPPLIER_[A-F0-9]{8}$")

    def test_saved_config_keeps_public_and_upstream_model_mapping(self):
        config = wizard.build_onboarding_config(sample_input())
        self.assertEqual("public-model", config["lines"][0]["model"])
        self.assertEqual("upstream-model", config["lines"][0]["upstream_model"])

    def test_evaluate_probe_enforces_expected_non_stream(self):
        report = {
            "probes": [{
                "stream": {"pass": True},
                "non_stream": {"pass": False},
                "usage": True,
                "codex_protocol": {"pass": True},
            }]
        }
        ready, failures = wizard.evaluate_probe(report, expect_non_stream=True)
        self.assertFalse(ready)
        self.assertIn("非流式 Responses probe 未通过", failures)
        ready, failures = wizard.evaluate_probe(report, expect_non_stream=False)
        self.assertTrue(ready)
        self.assertEqual([], failures)

    def test_serialized_config_and_report_are_secret_free(self):
        data = sample_input()
        config = wizard.build_onboarding_config(data)
        report = {
            "input": wizard.redacted_input(data),
            "pricing": wizard.pricing_report(data),
        }
        combined = json.dumps(config) + json.dumps(report)
        self.assertNotIn(data.api_key, combined)

    @mock.patch.object(wizard.subprocess, "run")
    def test_run_pipeline_injects_secret_only_in_child_environment(self, run_mock):
        data = sample_input()
        probe_report = {
            "probes": [{
                "stream": {"pass": True},
                "non_stream": {"pass": True},
                "usage": True,
                "codex_protocol": {"pass": True},
            }]
        }

        def fake_run(command, **kwargs):
            report_path = Path(command[command.index("--report") + 1])
            report_path.write_text(json.dumps(probe_report), encoding="utf-8")
            self.assertEqual(data.api_key, kwargs["env"][wizard.api_key_env_name(data)])
            self.assertNotIn(data.api_key, " ".join(command))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        run_mock.side_effect = fake_run
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            config_path = temp / "config.json"
            report_path = temp / "probe.json"
            wizard.write_json(config_path, wizard.build_onboarding_config(data))
            code, parsed, error, command = wizard.run_pipeline(
                onboarding_script=wizard.DEFAULT_ONBOARDING,
                config_path=config_path,
                onboarding_report_path=report_path,
                data=data,
            )
        self.assertEqual(0, code)
        self.assertEqual(probe_report, parsed)
        self.assertIsNone(error)
        self.assertNotIn(data.api_key, " ".join(command))
        self.assertIn("onboard", command)
        self.assertIn("--output-dir", command)


if __name__ == "__main__":
    unittest.main()

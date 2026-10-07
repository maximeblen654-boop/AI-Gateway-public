#!/usr/bin/env python3
"""Interactive entry point for the standard supplier onboarding pipeline."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import uuid
from dataclasses import asdict, dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ONBOARDING = REPO_ROOT / "tools" / "supplier-onboarding" / "onboard.py"
DEFAULT_OUTPUT_DIR = REPO_ROOT / ".local-sub2api-release" / "runtime" / "supplier-wizard"
DECIMAL_PLACES = Decimal("0.00000001")


class WizardError(RuntimeError):
    pass


@dataclass(frozen=True)
class WizardInput:
    supplier: str
    base_url: str
    api_key: str
    line_name: str
    upstream_model: str
    public_model: str
    product: str
    account_name: str
    product_description: str
    concurrency: int
    rate_limit_rpm: int
    priority: int
    expect_non_stream: bool
    known_limitations: list[str]
    probe_models: bool
    samples: int
    timeout_seconds: int
    cost_multiplier: Decimal
    target_margin_percent: Decimal
    channel_fee_percent: Decimal
    risk_reserve_percent: Decimal
    price_multiplier: Decimal


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def normalize_env_slug(value: str, fallback_prefix: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^A-Za-z0-9]+", "_", ascii_value).strip("_").upper()
    if slug:
        return slug
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:8].upper()
    return f"{fallback_prefix}_{digest}"


def normalize_line_name(value: str) -> str:
    return normalize_env_slug(value, "LINE")


def validate_base_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise WizardError("Base URL 必须是完整的 http/https URL")
    hostname = (parsed.hostname or "").lower()
    if parsed.scheme == "http" and hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise WizardError("非本机上游必须使用 HTTPS")
    return normalized


def parse_decimal(value: str, field: str, *, minimum: Decimal = Decimal("0")) -> Decimal:
    try:
        number = Decimal(value.strip())
    except (InvalidOperation, AttributeError) as exc:
        raise WizardError(f"{field} 必须是数字") from exc
    if not number.is_finite() or number < minimum:
        raise WizardError(f"{field} 必须是不小于 {minimum} 的有限数字")
    return number


def calculate_price_multiplier(
    cost_multiplier: Decimal,
    target_margin_percent: Decimal,
    channel_fee_percent: Decimal,
    risk_reserve_percent: Decimal,
) -> Decimal:
    if not cost_multiplier.is_finite() or cost_multiplier <= 0:
        raise WizardError("成本倍率必须是大于 0 的有限数字")
    for name, value in (
        ("目标毛利率", target_margin_percent),
        ("渠道费率", channel_fee_percent),
        ("风险准备率", risk_reserve_percent),
    ):
        if not value.is_finite() or value < 0:
            raise WizardError(f"{name} 必须是不小于 0 的有限数字")
    margin = target_margin_percent / Decimal("100")
    fee = channel_fee_percent / Decimal("100")
    reserve = risk_reserve_percent / Decimal("100")
    denominator = Decimal("1") - margin - fee
    if denominator <= 0:
        raise WizardError("目标毛利率与渠道费率之和必须小于 100%")
    return (cost_multiplier * (Decimal("1") + reserve) / denominator).quantize(
        DECIMAL_PLACES, rounding=ROUND_HALF_UP
    )


def decimal_to_json(value: Decimal) -> float:
    return float(value.quantize(DECIMAL_PLACES, rounding=ROUND_HALF_UP))


def prompt_text(
    label: str,
    *,
    default: str | None = None,
    secret: bool = False,
    input_fn: Callable[[str], str] = input,
    secret_fn: Callable[[str], str] = getpass.getpass,
) -> str:
    suffix = f" [{default}]" if default is not None else ""
    prompt = f"{label}{suffix}: "
    while True:
        raw = secret_fn(prompt) if secret else input_fn(prompt)
        value = raw.strip() or (default if default is not None else "")
        if value:
            return value
        print("该字段不能为空。")


def prompt_int(
    label: str,
    default: int,
    *,
    minimum: int = 0,
    input_fn: Callable[[str], str] = input,
) -> int:
    while True:
        raw = input_fn(f"{label} [{default}]: ").strip()
        try:
            value = default if not raw else int(raw)
        except ValueError:
            print("请输入整数。")
            continue
        if value < minimum:
            print(f"请输入不小于 {minimum} 的整数。")
            continue
        return value


def prompt_decimal(
    label: str,
    default: str,
    *,
    minimum: Decimal = Decimal("0"),
    input_fn: Callable[[str], str] = input,
) -> Decimal:
    while True:
        raw = input_fn(f"{label} [{default}]: ").strip() or default
        try:
            return parse_decimal(raw, label, minimum=minimum)
        except WizardError as exc:
            print(exc)


def prompt_bool(label: str, default: bool, *, input_fn: Callable[[str], str] = input) -> bool:
    hint = "Y/n" if default else "y/N"
    while True:
        raw = input_fn(f"{label} [{hint}]: ").strip().lower()
        if not raw:
            return default
        if raw in {"y", "yes", "是"}:
            return True
        if raw in {"n", "no", "否"}:
            return False
        print("请输入 y 或 n。")


def collect_input() -> WizardInput:
    print("Supplier Wizard（标准 onboarding pipeline）")
    print("API Key 仅注入 onboarding 子进程，不会写入配置或报告。\n")

    supplier = prompt_text("供应商名称")
    while True:
        try:
            base_url = validate_base_url(prompt_text("上游 Base URL"))
            break
        except WizardError as exc:
            print(exc)
    api_key = prompt_text("上游 API Key", secret=True)
    line_name = normalize_line_name(prompt_text("线路名称", default="A01"))
    upstream_model = prompt_text("上游真实模型")
    public_model = prompt_text("下游公开模型", default=upstream_model)
    product = prompt_text("产品名称", default=f"{public_model} {line_name}")
    account_name = prompt_text("Account 名称", default=f"{supplier} / {line_name}")
    product_description = prompt_text(
        "产品说明", default=f"{supplier} {line_name} product pool"
    )

    concurrency = prompt_int("并发上限", 1)
    rate_limit_rpm = prompt_int("RPM 上限（0 表示不限制）", 0)
    priority = prompt_int("调度优先级", 0)
    expect_non_stream = prompt_bool("必须支持非流式", True)
    limitations_raw = input("已知限制（多个以分号分隔，可留空）: ").strip()
    known_limitations = [item.strip() for item in limitations_raw.split(";") if item.strip()]
    probe_models = prompt_bool("上游确认支持 /v1/models", False)
    samples = prompt_int("探测采样次数", 1, minimum=1)
    timeout_seconds = prompt_int("单请求超时秒数", 120, minimum=1)

    cost_multiplier = prompt_decimal(
        "上游成本相对参考价倍率", "1", minimum=Decimal("0.00000001")
    )
    target_margin = prompt_decimal("目标毛利率（%）", "20")
    channel_fee = prompt_decimal("支付/渠道费率（%）", "0")
    risk_reserve = prompt_decimal("风险准备率（%）", "0")
    while True:
        try:
            price_multiplier = calculate_price_multiplier(
                cost_multiplier, target_margin, channel_fee, risk_reserve
            )
            break
        except WizardError as exc:
            print(exc)
            target_margin = prompt_decimal("目标毛利率（%）", "20")
            channel_fee = prompt_decimal("支付/渠道费率（%）", "0")

    return WizardInput(
        supplier=supplier,
        base_url=base_url,
        api_key=api_key,
        line_name=line_name,
        upstream_model=upstream_model,
        public_model=public_model,
        product=product,
        account_name=account_name,
        product_description=product_description,
        concurrency=concurrency,
        rate_limit_rpm=rate_limit_rpm,
        priority=priority,
        expect_non_stream=expect_non_stream,
        known_limitations=known_limitations,
        probe_models=probe_models,
        samples=samples,
        timeout_seconds=timeout_seconds,
        cost_multiplier=cost_multiplier,
        target_margin_percent=target_margin,
        channel_fee_percent=channel_fee,
        risk_reserve_percent=risk_reserve,
        price_multiplier=price_multiplier,
    )


def api_key_env_name(data: WizardInput) -> str:
    supplier_slug = normalize_env_slug(data.supplier, "SUPPLIER")
    line_slug = normalize_env_slug(data.line_name, "LINE")
    return f"{supplier_slug}_{line_slug}_API_KEY"


def build_onboarding_config(data: WizardInput) -> dict[str, Any]:
    return {
        "supplier": data.supplier,
        "base_url": data.base_url,
        "provider": "openai_responses",
        "probe_models": data.probe_models,
        "samples": data.samples,
        "timeout_seconds": data.timeout_seconds,
        "reasoning_efforts": ["high", "xhigh", "max"],
        "lines": [
            {
                "name": data.line_name,
                "account_name": data.account_name,
                "api_key_env": api_key_env_name(data),
                "model": data.public_model,
                "upstream_model": data.upstream_model,
                "product": data.product,
                "product_description": data.product_description,
                "cost_multiplier": decimal_to_json(data.cost_multiplier),
                "price_multiplier": decimal_to_json(data.price_multiplier),
                "concurrency": data.concurrency,
                "rate_limit_rpm": data.rate_limit_rpm,
                "priority": data.priority,
                "expect_non_stream": data.expect_non_stream,
                "known_limitations": data.known_limitations,
            }
        ],
    }


def pricing_report(data: WizardInput) -> dict[str, Any]:
    return {
        "mode": "reference_multiplier",
        "cost_multiplier": decimal_to_json(data.cost_multiplier),
        "target_margin_percent": decimal_to_json(data.target_margin_percent),
        "channel_fee_percent": decimal_to_json(data.channel_fee_percent),
        "risk_reserve_percent": decimal_to_json(data.risk_reserve_percent),
        "price_multiplier": decimal_to_json(data.price_multiplier),
        "formula": "cost_multiplier * (1 + risk_reserve) / (1 - target_margin - channel_fee)",
    }


def config_sha256(config: dict[str, Any]) -> str:
    canonical = json.dumps(config, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def write_json(path: Path, value: dict[str, Any], *, overwrite: bool = False) -> None:
    if path.exists() and not overwrite:
        raise WizardError(f"输出文件已存在：{path}（使用 --force 覆盖）")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def ensure_output_paths(paths: list[Path], *, overwrite: bool) -> None:
    resolved = [path.resolve() for path in paths]
    if len(set(resolved)) != len(resolved):
        raise WizardError("所有配置和报告必须使用不同文件路径")
    if not overwrite:
        existing = [str(path) for path in resolved if path.exists()]
        if existing:
            raise WizardError("输出文件已存在（使用 --force 覆盖）：" + ", ".join(existing))


def sanitize_error(value: str, secret: str) -> str:
    text = value.replace(secret, "[REDACTED]") if secret else value
    return text[-4000:]


def evaluate_probe(report: dict[str, Any], *, expect_non_stream: bool) -> tuple[bool, list[str]]:
    failures: list[str] = []
    probes = report.get("probes")
    if not isinstance(probes, list) or len(probes) != 1 or not isinstance(probes[0], dict):
        return False, ["probe 报告缺少唯一线路结果"]
    probe = probes[0]
    if not bool((probe.get("stream") or {}).get("pass")):
        failures.append("流式 Responses probe 未通过")
    if expect_non_stream and not bool((probe.get("non_stream") or {}).get("pass")):
        failures.append("非流式 Responses probe 未通过")
    if not bool(probe.get("usage")):
        failures.append("响应未提供 usage")
    if not bool((probe.get("codex_protocol") or {}).get("pass")):
        failures.append("Codex 协议 probe 未通过")
    return not failures, failures


def probe_timeout_seconds(data: WizardInput) -> int:
    request_count = data.samples * 2 + 4
    if data.probe_models:
        request_count += 1
    return data.timeout_seconds * request_count + 30


def run_pipeline(
    *,
    onboarding_script: Path,
    config_path: Path,
    onboarding_report_path: Path,
    data: WizardInput,
) -> tuple[int, dict[str, Any] | None, str | None, list[str]]:
    command = [
        sys.executable,
        str(onboarding_script),
        "onboard",
        "--config",
        str(config_path),
        "--report",
        str(onboarding_report_path),
        "--output-dir",
        str(onboarding_report_path.with_name(onboarding_report_path.stem + "-artifacts")),
    ]
    if not onboarding_script.is_file():
        return 1, None, f"找不到 onboarding 脚本：{onboarding_script}", command
    child_env = os.environ.copy()
    child_env[api_key_env_name(data)] = data.api_key
    try:
        result = subprocess.run(
            command,
            cwd=REPO_ROOT,
            env=child_env,
            capture_output=True,
            text=True,
            timeout=probe_timeout_seconds(data),
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return 1, None, f"onboarding 超过 Wizard 总超时：{exc.timeout} 秒", command
    except OSError as exc:
        return 1, None, f"无法启动 onboarding：{exc}", command

    parsed: dict[str, Any] | None = None
    if onboarding_report_path.is_file():
        try:
            value = json.loads(onboarding_report_path.read_text(encoding="utf-8"))
            if isinstance(value, dict):
                parsed = value
        except (OSError, json.JSONDecodeError):
            parsed = None
    error = None
    if parsed is None:
        message = result.stderr.strip() or "onboarding 未生成有效报告"
        error = sanitize_error(message, data.api_key)
    elif result.returncode not in {0, 2}:
        message = result.stderr.strip() or f"onboarding 异常退出：{result.returncode}"
        error = sanitize_error(message, data.api_key)
    return result.returncode, parsed, error, command


def redacted_input(data: WizardInput) -> dict[str, Any]:
    value = asdict(data)
    value.pop("api_key", None)
    for key, item in list(value.items()):
        if isinstance(item, Decimal):
            value[key] = decimal_to_json(item)
    return value


def preview(data: WizardInput, config: dict[str, Any]) -> None:
    line = config["lines"][0]
    print("\n即将生成：")
    print(f"  供应商：{data.supplier}")
    print(f"  模型映射：{data.public_model} -> {data.upstream_model}")
    print(f"  Product：{data.product}")
    print(f"  Account：{data.account_name}")
    print(f"  API Key 环境变量：{line['api_key_env']}")
    print(f"  成本倍率：{line['cost_multiplier']:.8f}")
    print(f"  售价倍率：{line['price_multiplier']:.8f}")
    print("  本次执行 probe → fingerprint → apply → verify。")


def output_paths(args: argparse.Namespace, data: WizardInput, run_id: str) -> tuple[Path, Path, Path]:
    output_dir = Path(args.output_dir).resolve()
    stem = f"{time.strftime('%Y%m%d-%H%M%S')}-{normalize_env_slug(data.supplier, 'SUPPLIER').lower()}-{data.line_name.lower()}-{run_id[:8]}"
    config_path = Path(args.config_output).resolve() if args.config_output else output_dir / f"{stem}-onboarding.json"
    wizard_report = Path(args.report_output).resolve() if args.report_output else output_dir / f"{stem}-wizard-report.json"
    onboarding_report = wizard_report.with_name(wizard_report.stem + "-onboarding-probe.json")
    return config_path, wizard_report, onboarding_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Interactive Supplier Wizard for standard onboarding")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--config-output")
    parser.add_argument("--report-output")
    parser.add_argument("--onboarding-script", default=str(DEFAULT_ONBOARDING))
    parser.add_argument("--force", action="store_true", help="overwrite explicitly selected output files")
    args = parser.parse_args(argv)

    run_id = str(uuid.uuid4())
    started_at = utc_now()
    try:
        data = collect_input()
        config = build_onboarding_config(data)
        config_path, report_path, onboarding_report_path = output_paths(args, data, run_id)
        preview(data, config)
        if not prompt_bool("确认生成配置并开始 onboarding", True):
            print("已取消，未生成配置或执行 onboarding。")
            return 130

        ensure_output_paths(
            [config_path, report_path, onboarding_report_path],
            overwrite=args.force,
        )
        write_json(config_path, config, overwrite=args.force)
        if args.force:
            onboarding_report_path.unlink(missing_ok=True)
        print(f"\n配置已生成：{config_path}")
        print("正在调用 supplier-onboarding 标准 pipeline...")
        exit_code, probe_report, probe_error, command = run_pipeline(
            onboarding_script=Path(args.onboarding_script).resolve(),
            config_path=config_path,
            onboarding_report_path=onboarding_report_path,
            data=data,
        )

        ready = False
        failures: list[str] = []
        if probe_report is not None:
            ready, failures = evaluate_probe(
                probe_report, expect_non_stream=data.expect_non_stream
            )
        if probe_error:
            failures.append(probe_error)
        pipeline_status = (probe_report or {}).get("pipeline", {}).get("status")
        status = "READY" if ready and exit_code == 0 and pipeline_status == "COMPLETE" else "NOT_READY"
        wizard_report = {
            "schema_version": 1,
            "wizard_run_id": run_id,
            "status": status,
            "started_at": started_at,
            "finished_at": utc_now(),
            "config_path": str(config_path),
            "config_sha256": config_sha256(config),
            "input": redacted_input(data),
            "generated": {
                "api_key_env": api_key_env_name(data),
                "account_name": data.account_name,
                "product": data.product,
            },
            "pricing": pricing_report(data),
            "pipeline": {
                "command": command,
                "model": data.upstream_model,
                "exit_code": exit_code,
                "onboarding_report_path": str(onboarding_report_path),
                "failures": failures,
                "report": probe_report,
            },
        }
        write_json(report_path, wizard_report, overwrite=args.force)
        print(f"Wizard 报告：{report_path}")
        if status == "READY":
            print("结果：READY（probe、fingerprint、apply、verify 均已完成）。")
            return 0
        print("结果：NOT_READY")
        for failure in failures:
            print(f"  - {failure}")
        return 2
    except (WizardError, OSError) as exc:
        print(f"Supplier Wizard 失败：{exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n已取消。", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())

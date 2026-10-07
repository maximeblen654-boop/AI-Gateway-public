#!/usr/bin/env python3
"""Reusable supplier onboarding for Sub2API.

The configuration contains only non-secret supplier metadata. All credentials are
resolved from environment variables at runtime and are never written to reports.
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class OnboardingError(RuntimeError):
    pass


def load_json(path: str | Path) -> dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise OnboardingError(f"cannot read config {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise OnboardingError("config root must be a JSON object")
    return value


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise OnboardingError(f"required environment variable is missing: {name}")
    return value


def normalize_base_url(value: str) -> str:
    value = value.strip().rstrip("/")
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise OnboardingError(f"invalid base_url: {value!r}")
    return value


def endpoint(base_url: str, path: str) -> str:
    base = normalize_base_url(base_url)
    suffix = path if path.startswith("/") else f"/{path}"
    if base.endswith("/v1") and suffix.startswith("/v1/"):
        suffix = suffix[3:]
    return base + suffix


def validate_config(config: dict[str, Any]) -> None:
    for key in ("supplier", "base_url", "provider", "lines"):
        if not config.get(key):
            raise OnboardingError(f"config field is required: {key}")
    normalize_base_url(str(config["base_url"]))
    if config["provider"] not in {"openai_responses"}:
        raise OnboardingError(
            f"unsupported provider {config['provider']!r}; supported: openai_responses"
        )
    if not isinstance(config["lines"], list) or not config["lines"]:
        raise OnboardingError("lines must be a non-empty array")
    names: set[str] = set()
    for index, line in enumerate(config["lines"]):
        if not isinstance(line, dict):
            raise OnboardingError(f"lines[{index}] must be an object")
        for key in ("name", "api_key_env", "model", "product"):
            if not line.get(key):
                raise OnboardingError(f"lines[{index}].{key} is required")
        if line["name"] in names:
            raise OnboardingError(f"duplicate line name: {line['name']}")
        names.add(line["name"])
        for numeric in ("cost_multiplier", "price_multiplier", "concurrency", "priority", "rate_limit_rpm"):
            if numeric in line and float(line[numeric]) < 0:
                raise OnboardingError(f"lines[{index}].{numeric} must be >= 0")


@dataclass
class HTTPResult:
    status: int
    headers: dict[str, str]
    body: bytes
    first_byte_seconds: float
    total_seconds: float
    read_error: str | None = None
    response_http_version: str = "UNKNOWN"

    def json(self) -> Any:
        try:
            return json.loads(self.body.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            return None


def request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    payload: Any = None,
    timeout: float = 120,
) -> HTTPResult:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    # Python's default urllib signature is blocked by some supplier CDNs (for
    # example Cloudflare 1010). A curl-compatible UA keeps the generic probe
    # representative of normal API clients; Codex probes override it below.
    final_headers = {"Accept": "application/json", "User-Agent": "curl/8.5.0", **(headers or {})}
    if data is not None:
        final_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=final_headers, method=method)
    started = time.monotonic()
    try:
        response = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        response = exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise OnboardingError(f"request failed for {url}: {exc}") from exc
    with response:
        read_error = None
        try:
            first = response.read(1)
            first_byte = time.monotonic()
            body = first
            try:
                body += response.read()
            except http.client.IncompleteRead as exc:
                body += exc.partial
                read_error = f"IncompleteRead: {exc}"
            except (OSError, TimeoutError) as exc:
                read_error = f"{type(exc).__name__}: {exc}"
        except http.client.IncompleteRead as exc:
            first_byte = time.monotonic()
            body = exc.partial
            read_error = f"IncompleteRead: {exc}"
        except (OSError, TimeoutError) as exc:
            first_byte = time.monotonic()
            body = b""
            read_error = f"{type(exc).__name__}: {exc}"
        finished = time.monotonic()
        response_version = {10: "HTTP/1.0", 11: "HTTP/1.1"}.get(
            getattr(response, "version", None), "UNKNOWN"
        )
        return HTTPResult(
            status=int(response.status),
            headers={key.lower(): value for key, value in response.headers.items()},
            body=body,
            first_byte_seconds=first_byte - started,
            total_seconds=finished - started,
            read_error=read_error,
            response_http_version=response_version,
        )


FINGERPRINT_HEADERS = (
    "server", "via", "cf-ray", "cf-cache-status", "x-request-id",
    "request-id", "openai-request-id", "x-envoy-upstream-service-time",
    "x-powered-by", "x-served-by", "x-cache",
)

# Header values outside this allowlist are deliberately not persisted. Upstreams
# can echo credentials or set cookies, while these headers identify only transport
# and request-routing behaviour.
SAFE_RESPONSE_HEADER_VALUES = frozenset(("content-type", *FINGERPRINT_HEADERS))


def status_classification(status: int) -> str:
    if status == 0:
        return "UNKNOWN"
    return "PASS" if 200 <= status < 300 else "FAIL"


def object_shape(value: Any, *, depth: int = 0) -> Any:
    """Return keys/types only, never response values that may contain content."""
    if depth >= 3:
        return type(value).__name__
    if isinstance(value, dict):
        return {str(key): object_shape(item, depth=depth + 1) for key, item in value.items()}
    if isinstance(value, list):
        return [object_shape(value[0], depth=depth + 1)] if value else []
    if value is None:
        return "null"
    return type(value).__name__


def header_fingerprint(headers: dict[str, str]) -> dict[str, str]:
    return {name: headers[name] for name in FINGERPRINT_HEADERS if name in headers}


def response_header_summary(headers: dict[str, str]) -> dict[str, str]:
    """Record every response header name without retaining unsafe values."""
    return {
        name: value if name in SAFE_RESPONSE_HEADER_VALUES else "[redacted]"
        for name, value in sorted(headers.items())
    }


def response_summary(result: HTTPResult, *, request_user_agent: str | None = None) -> dict[str, Any]:
    parsed = result.json()
    error = None
    usage = None
    model = None
    if isinstance(parsed, dict):
        model = parsed.get("model")
        usage = parsed.get("usage")
        raw_error = parsed.get("error")
        if isinstance(raw_error, dict):
            error = raw_error.get("message") or raw_error.get("code")
        elif raw_error:
            error = str(raw_error)
    if not error and result.status >= 400:
        error = result.body.decode("utf-8", errors="replace")[:300]
    return {
        "status": result.status,
        "pass": 200 <= result.status < 300,
        "status_classification": status_classification(result.status),
        "first_byte_seconds": round(result.first_byte_seconds, 3),
        "total_seconds": round(result.total_seconds, 3),
        "model": model,
        "usage": usage,
        "usage_shape": object_shape(usage) if usage is not None else None,
        "body_json_shape": object_shape(parsed) if parsed is not None else None,
        "error": error,
        "error_shape": object_shape(parsed) if result.status >= 400 and parsed is not None else None,
        "content_type": result.headers.get("content-type"),
        "response_headers": header_fingerprint(result.headers),
        "response_header_summary": response_header_summary(result.headers),
        "request_id": next(
            (result.headers[name] for name in ("x-request-id", "request-id", "openai-request-id") if name in result.headers),
            None,
        ),
        "request_fingerprint": {
            "user_agent": request_user_agent or "UNKNOWN",
            # urllib.request uses HTTP/1.1. The response version is read from
            # the actual HTTPResponse object rather than assumed.
            "http_version": "HTTP/1.1",
            "response_http_version": result.response_http_version,
        },
        "body_bytes": len(result.body),
        "read_error": result.read_error,
    }


def probe_responses(
    base_url: str,
    api_key: str,
    model: str,
    *,
    stream: bool,
    effort: str | None = None,
    prompt: str = "Reply with exactly: OK",
    timeout: float = 120,
    codex_headers: bool = False,
    user_agent: str | None = None,
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {api_key}"}
    if codex_headers:
        headers.update({"User-Agent": "codex_cli_rs/onboarding", "OpenAI-Beta": "responses=experimental"})
    if user_agent:
        headers["User-Agent"] = user_agent
    payload: dict[str, Any] = {
        "model": model,
        "input": prompt,
        "stream": stream,
    }
    if effort:
        payload["reasoning"] = {"effort": effort}
    try:
        result = request(
            "POST", endpoint(base_url, "/v1/responses"), headers=headers, payload=payload, timeout=timeout
        )
    except OnboardingError as exc:
        return {
            "status": 0, "pass": False, "first_byte_seconds": None,
            "total_seconds": None, "model": None, "usage": None,
            "usage_shape": None, "error": str(exc), "error_shape": None,
            "content_type": None, "response_headers": {}, "body_bytes": 0,
            "read_error": str(exc),
            "status_classification": "UNKNOWN", "response_header_summary": {},
            "request_id": None,
            "request_fingerprint": {
                "user_agent": headers.get("User-Agent", "curl/8.5.0"),
                "http_version": "HTTP/1.1", "response_http_version": "UNKNOWN",
            },
        }
    summary = response_summary(result, request_user_agent=headers.get("User-Agent", "curl/8.5.0"))
    if stream and summary["pass"]:
        text = result.body.decode("utf-8", errors="replace")
        event_types = extract_sse_event_types(text)
        summary["stream_events"] = sum(1 for line in text.splitlines() if line.startswith("data:"))
        summary["stream_event_types"] = event_types
        summary["completed"] = "response.completed" in text or "[DONE]" in text
        summary["pass"] = bool(
            summary["stream_events"] and summary["completed"] and not summary["read_error"]
        )
        summary["usage"] = extract_sse_usage(text)
        summary["usage_shape"] = object_shape(summary["usage"]) if summary["usage"] is not None else None
    return summary


def probe_responses_with_retries(
    base_url: str, api_key: str, model: str, *, transport_retries: int = 0, **kwargs: Any
) -> dict[str, Any]:
    """Retry only failures that occurred before any HTTP response was received."""
    retry_errors: list[str] = []
    for attempt in range(transport_retries + 1):
        result = probe_responses(base_url, api_key, model, **kwargs)
        if result.get("status") != 0:
            result["transport_attempts"] = attempt + 1
            result["retry_errors"] = retry_errors
            return result
        if result.get("error"):
            retry_errors.append(str(result["error"]))
    result["transport_attempts"] = transport_retries + 1
    result["retry_errors"] = retry_errors[:-1]
    return result


def fingerprint_profile(summary: dict[str, Any]) -> dict[str, Any]:
    """Keep the automatic comparison concise and free of request/response content."""
    return {
        "status": summary.get("status", 0),
        "status_classification": summary.get("status_classification", "UNKNOWN"),
        "request_fingerprint": summary.get("request_fingerprint", {}),
        "response_header_summary": summary.get("response_header_summary", {}),
        "request_id": summary.get("request_id"),
        "body_json_shape": summary.get("body_json_shape"),
        "read_error": summary.get("read_error"),
    }


def probe_fingerprint_diagnostics(
    base_url: str, api_key: str, model: str, *, timeout: float, transport_retries: int
) -> dict[str, Any]:
    """Compare a controlled API-client fingerprint to urllib's historical default.

    The two requests are identical except for User-Agent. This makes a CDN or WAF
    rejection directly visible before account creation or downstream verification.
    """
    controlled = probe_responses_with_retries(
        base_url, api_key, model, stream=False, timeout=timeout,
        transport_retries=transport_retries, user_agent="curl/8.5.0",
    )
    python_urllib = probe_responses_with_retries(
        base_url, api_key, model, stream=False, timeout=timeout,
        transport_retries=transport_retries,
        user_agent=f"Python-urllib/{sys.version_info.major}.{sys.version_info.minor}",
    )
    controlled_status = controlled.get("status_classification", "UNKNOWN")
    python_status = python_urllib.get("status_classification", "UNKNOWN")
    if controlled_status == "PASS" and python_status == "PASS":
        status, reason = "PASS", "both_user_agent_profiles_accepted"
    elif controlled_status == "PASS" and python_status == "FAIL":
        status, reason = "FAIL", "python_urllib_user_agent_rejected"
    elif controlled_status == "UNKNOWN" or python_status == "UNKNOWN":
        status, reason = "UNKNOWN", "no_http_response_for_at_least_one_profile"
    else:
        status, reason = "FAIL", "controlled_user_agent_rejected"
    return {
        "status": status,
        "reason": reason,
        "comparison": "identical non-stream Responses requests; User-Agent differs only",
        "profiles": {
            "controlled": fingerprint_profile(controlled),
            "python_urllib_reference": fingerprint_profile(python_urllib),
        },
    }


def extract_sse_usage(text: str) -> Any:
    usage = None
    for line in text.splitlines():
        if not line.startswith("data:"):
            continue
        raw = line[5:].strip()
        if not raw or raw == "[DONE]":
            continue
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            response = event.get("response")
            if isinstance(response, dict) and response.get("usage") is not None:
                usage = response["usage"]
            elif event.get("usage") is not None:
                usage = event["usage"]
    return usage


def extract_sse_event_types(text: str) -> list[str]:
    event_types: list[str] = []
    for line in text.splitlines():
        if not line.startswith("data:"):
            continue
        raw = line[5:].strip()
        if not raw or raw == "[DONE]":
            continue
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and event.get("type"):
            event_type = str(event["type"])
            if event_type not in event_types:
                event_types.append(event_type)
    return event_types


def probe_models(base_url: str, api_key: str, timeout: float) -> dict[str, Any]:
    result = request(
        "GET",
        endpoint(base_url, "/v1/models"),
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=timeout,
    )
    parsed = result.json()
    models: list[str] = []
    if isinstance(parsed, dict) and isinstance(parsed.get("data"), list):
        models = [str(item.get("id")) for item in parsed["data"] if isinstance(item, dict) and item.get("id")]
    return {"status": result.status, "pass": 200 <= result.status < 300, "models": models}


def probe_codex_command(
    command: list[str], env_overrides: dict[str, str], timeout: float,
    expected_output: str | None = None,
) -> dict[str, Any]:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command,
            env={**os.environ, **env_overrides},
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"pass": False, "error": str(exc)}
    output = (completed.stdout + "\n" + completed.stderr).strip()
    output_matched = expected_output is None or expected_output in output
    return {
        "pass": completed.returncode == 0 and output_matched,
        "exit_code": completed.returncode,
        "total_seconds": round(time.monotonic() - started, 3),
        "expected_output_matched": output_matched,
        "reconnect_mentions": output.lower().count("reconnecting") + output.lower().count("retrying sampling request"),
        "error_events": output.count('"type":"error"') + output.count('"type": "error"'),
        "output_tail": output[-500:],
    }


def probe_http_error(base_url: str, model: str, timeout: float) -> dict[str, Any]:
    """Capture an authentication error's status and shape without using a real secret."""
    try:
        result = request(
            "POST",
            endpoint(base_url, "/v1/responses"),
            headers={"Authorization": "Bearer onboarding-intentionally-invalid"},
            payload={"model": model, "input": "OK", "stream": False},
            timeout=timeout,
        )
    except OnboardingError as exc:
        return {"status": 0, "pass": False, "error": str(exc), "error_shape": None}
    summary = response_summary(result)
    summary["pass"] = 400 <= result.status < 500
    return summary


def probe_line(config: dict[str, Any], line: dict[str, Any]) -> dict[str, Any]:
    api_key = require_env(str(line["api_key_env"]))
    timeout = float(config.get("timeout_seconds", 120))
    samples = max(1, int(config.get("samples", 1)))
    transport_retries = max(0, int(config.get("probe_transport_retries", 0)))
    result: dict[str, Any] = {
        "supplier": config["supplier"],
        "line": line["name"],
        "model": line.get("upstream_model", line["model"]),
        "public_model": line["model"],
        "product": line["product"],
        "provider": config["provider"],
        "expect_non_stream": bool(line.get("expect_non_stream", True)),
    }
    if config.get("probe_models", False):
        result["models"] = probe_models(config["base_url"], api_key, timeout)
    result["fingerprint_diagnostics"] = probe_fingerprint_diagnostics(
        config["base_url"], api_key, result["model"], timeout=timeout,
        transport_retries=transport_retries,
    )
    non_stream = [
        probe_responses_with_retries(
            config["base_url"], api_key, result["model"], stream=False, timeout=timeout,
            transport_retries=transport_retries,
        )
        for _ in range(samples)
    ]
    stream = [
        probe_responses_with_retries(
            config["base_url"], api_key, result["model"], stream=True, timeout=timeout,
            transport_retries=transport_retries,
        )
        for _ in range(samples)
    ]
    result["non_stream"] = aggregate_samples(non_stream)
    result["stream"] = aggregate_samples(stream)
    result["usage"] = any(item.get("usage") is not None for item in non_stream + stream)
    result["reasoning"] = {}
    for effort in config.get("reasoning_efforts", ["high", "xhigh", "max"]):
        item = probe_responses_with_retries(
            config["base_url"], api_key, result["model"], stream=True,
            effort=str(effort), timeout=timeout, transport_retries=transport_retries,
        )
        result["reasoning"][str(effort)] = {
            "accepted": item["pass"],
            "actual_effort": "unknown",
            "status": item["status"],
            "error": item.get("error"),
            "first_byte_seconds": item.get("first_byte_seconds"),
            "total_seconds": item.get("total_seconds"),
            "usage_shape": item.get("usage_shape"),
            "response_headers": item.get("response_headers", {}),
            "stream_event_types": item.get("stream_event_types"),
            "completed": item.get("completed"),
            "read_error": item.get("read_error"),
            "transport_attempts": item.get("transport_attempts", 1),
            "retry_errors": item.get("retry_errors", []),
        }
    if config.get("probe_http_error", False):
        result["http_error"] = probe_http_error(config["base_url"], result["model"], timeout)
    result["codex_protocol"] = probe_responses_with_retries(
        config["base_url"], api_key, result["model"], stream=True,
        timeout=timeout, codex_headers=True, transport_retries=transport_retries,
    )
    codex = config.get("codex")
    if isinstance(codex, dict) and codex.get("command"):
        substitutions = {
            "{base_url}": str(config["base_url"]),
            "{model}": str(result["model"]),
            "{api_key_env}": str(line["api_key_env"]),
        }
        command = []
        for part in codex["command"]:
            value = str(part)
            for old, new in substitutions.items():
                value = value.replace(old, new)
            command.append(value)
        env_overrides = {
            str(key): str(value).replace("{api_key}", api_key)
            for key, value in codex.get("env", {}).items()
        }
        result["codex_cli"] = probe_codex_command(
            command, env_overrides, timeout,
            str(codex["expected_output"]) if codex.get("expected_output") is not None else None,
        )
    limitations = list(line.get("known_limitations", []))
    if any(item.get("actual_effort") == "unknown" for item in result["reasoning"].values()):
        limitations.append("reasoning effort acceptance does not prove the upstream execution tier")
    result["known_limitations"] = sorted(set(limitations))
    return result


def aggregate_samples(samples: list[dict[str, Any]]) -> dict[str, Any]:
    passed = [item for item in samples if item["pass"]]
    ttft = [float(item["first_byte_seconds"]) for item in samples if item.get("first_byte_seconds") is not None]
    totals = [float(item["total_seconds"]) for item in samples if item.get("total_seconds") is not None]
    return {
        "pass": len(passed) == len(samples),
        "passed": len(passed),
        "samples": len(samples),
        "status": samples[-1]["status"],
        "avg_first_byte_seconds": round(statistics.mean(ttft), 3) if ttft else None,
        "min_first_byte_seconds": round(min(ttft), 3) if ttft else None,
        "max_first_byte_seconds": round(max(ttft), 3) if ttft else None,
        "avg_total_seconds": round(statistics.mean(totals), 3) if totals else None,
        "min_total_seconds": round(min(totals), 3) if totals else None,
        "max_total_seconds": round(max(totals), 3) if totals else None,
        "sample_timings": [
            {
                "status": item["status"], "pass": item["pass"],
                "first_byte_seconds": item.get("first_byte_seconds"),
                "total_seconds": item.get("total_seconds"),
                "read_error": item.get("read_error"),
                "transport_attempts": item.get("transport_attempts", 1),
                "retry_errors": item.get("retry_errors", []),
            }
            for item in samples
        ],
        "usage": samples[-1].get("usage"),
        "usage_shape": samples[-1].get("usage_shape"),
        "error": samples[-1].get("error"),
        "error_shape": samples[-1].get("error_shape"),
        "response_headers": samples[-1].get("response_headers", {}),
        "content_type": samples[-1].get("content_type"),
        "stream_event_types": samples[-1].get("stream_event_types"),
        "completed": samples[-1].get("completed"),
    }


class Sub2APIClient:
    def __init__(self, base_url: str, email: str, password: str, timeout: float = 60):
        self.base_url = normalize_base_url(base_url)
        self.timeout = timeout
        login = self.call("POST", "/api/v1/auth/login", {"email": email, "password": password}, authenticated=False)
        self.login_response = login
        try:
            self.token = str(login["data"]["access_token"])
        except (KeyError, TypeError) as exc:
            raise OnboardingError("Sub2API login response did not contain an access token") from exc

    def call(self, method: str, path: str, payload: Any = None, *, authenticated: bool = True) -> Any:
        headers: dict[str, str] = {}
        if authenticated:
            headers["Authorization"] = f"Bearer {self.token}"
        result = request(method, endpoint(self.base_url, path), headers=headers, payload=payload, timeout=self.timeout)
        parsed = result.json()
        if not 200 <= result.status < 300:
            message = parsed if parsed is not None else result.body.decode("utf-8", errors="replace")[:500]
            raise OnboardingError(f"Sub2API {method} {path} returned {result.status}: {message}")
        return parsed

    @staticmethod
    def items(response: Any) -> list[dict[str, Any]]:
        data = response.get("data") if isinstance(response, dict) else None
        if isinstance(data, dict):
            values = data.get("items", [])
        else:
            values = data or []
        return values if isinstance(values, list) else []

    def find_group(self, name: str) -> dict[str, Any] | None:
        query = urllib.parse.urlencode({"page": 1, "page_size": 100, "search": name})
        for item in self.items(self.call("GET", f"/api/v1/admin/groups?{query}")):
            if item.get("name") == name:
                return item
        return None

    def find_account(self, name: str) -> dict[str, Any] | None:
        query = urllib.parse.urlencode({"page": 1, "page_size": 100, "search": name})
        for item in self.items(self.call("GET", f"/api/v1/admin/accounts?{query}")):
            if item.get("name") == name:
                return item
        return None

    def ensure_group(self, line: dict[str, Any], *, dry_run: bool) -> tuple[int | None, str]:
        existing = self.find_group(str(line["product"]))
        payload = {
            "name": line["product"],
            "description": line.get("product_description", f"Product pool for {line['model']}"),
            "platform": "openai",
            "rate_multiplier": float(line.get("price_multiplier", 1)),
            "subscription_type": "standard",
            "long_context_pricing_enabled": True,
            "model_allowlist": {"enabled": True, "models": [line["model"]]},
            "max_reasoning_effort": line.get("max_reasoning_effort", ""),
            "max_reasoning_effort_over_limit": "downgrade",
        }
        if existing:
            group_id = int(existing["id"])
            if not dry_run:
                self.call("PUT", f"/api/v1/admin/groups/{group_id}", payload)
            return group_id, "updated" if not dry_run else "would-update"
        if dry_run:
            return None, "would-create"
        created = self.call("POST", "/api/v1/admin/groups", payload)
        return int(created["data"]["id"]), "created"

    def ensure_account(
        self, config: dict[str, Any], line: dict[str, Any], group_id: int | None, *, dry_run: bool
    ) -> tuple[int | None, str]:
        account_name = str(line.get("account_name", f"{config['supplier']} / {line['name']}"))
        existing = self.find_account(account_name)
        credentials = {
            "api_key": require_env(str(line["api_key_env"])),
            "base_url": normalize_base_url(str(config["base_url"])),
            "api_protocol": "responses",
            "model_mapping": {str(line["model"]): str(line.get("upstream_model", line["model"]))},
        }
        extra = {"supplier": config["supplier"], "supplier_line": line["name"]}
        if line.get("rate_limit_rpm") is not None:
            extra["base_rpm"] = int(line["rate_limit_rpm"])
        payload = {
            "name": account_name,
            "notes": f"Supplier {config['supplier']}; line {line['name']}",
            "platform": "openai",
            "type": "apikey",
            "credentials": credentials,
            "extra": extra,
            "concurrency": int(line.get("concurrency", 1)),
            "priority": int(line.get("priority", 0)),
            "rate_multiplier": float(line.get("cost_multiplier", 1)),
            "group_ids": [] if group_id is None else [group_id],
            "confirm_mixed_channel_risk": bool(line.get("confirm_mixed_channel_risk", False)),
        }
        if existing:
            account_id = int(existing["id"])
            update = {key: value for key, value in payload.items() if key != "platform"}
            if not dry_run:
                self.call("PUT", f"/api/v1/admin/accounts/{account_id}", update)
            return account_id, "updated" if not dry_run else "would-update"
        if dry_run:
            return None, "would-create"
        created = self.call(
            "POST", "/api/v1/admin/accounts", payload,
        )
        return int(created["data"]["id"]), "created"

    def recover_account(self, account_id: int) -> None:
        self.call("POST", f"/api/v1/admin/accounts/{account_id}/recover-state", {})

    def user_balance(self) -> float:
        response = self.call("GET", "/api/v1/user/profile")
        data = response.get("data") if isinstance(response, dict) else None
        user = data.get("user", data) if isinstance(data, dict) else None
        if not isinstance(user, dict) or user.get("balance") is None:
            raise OnboardingError("user profile response did not contain balance")
        return float(user["balance"])


def ensure_downstream_binding(
    config: dict[str, Any], line: dict[str, Any], group_id: int | None, *, dry_run: bool
) -> tuple[int | None, str]:
    key_name = line.get("downstream_key_name")
    if not key_name:
        return None, "not-configured"
    sub = config.get("sub2api") or {}
    email_env = sub.get("test_email_env")
    password_env = sub.get("test_password_env")
    if not email_env or not password_env:
        raise OnboardingError(
            "sub2api.test_email_env and test_password_env are required when downstream_key_name is set"
        )
    client = Sub2APIClient(
        str(sub.get("base_url", "http://127.0.0.1:8080")),
        require_env(str(email_env)),
        require_env(str(password_env)),
        float(config.get("timeout_seconds", 120)),
    )
    response = client.call("GET", "/api/v1/keys?page=1&page_size=100")
    existing = next((item for item in client.items(response) if item.get("name") == key_name), None)
    if not existing:
        raise OnboardingError(f"downstream test key not found: {key_name}")
    key_id = int(existing["id"])
    if dry_run:
        return key_id, "would-bind"
    if group_id is None:
        raise OnboardingError(f"cannot bind {key_name}: product group has no id")
    client.call("PUT", f"/api/v1/keys/{key_id}", {"group_id": group_id})
    return key_id, "bound"


def admin_client(config: dict[str, Any]) -> Sub2APIClient:
    sub = config.get("sub2api") or {}
    if not isinstance(sub, dict):
        raise OnboardingError("sub2api must be an object")
    return Sub2APIClient(
        str(sub.get("base_url", "http://127.0.0.1:8080")),
        require_env(str(sub.get("admin_email_env", "SUB2API_ADMIN_EMAIL"))),
        require_env(str(sub.get("admin_password_env", "SUB2API_ADMIN_PASSWORD"))),
        float(config.get("timeout_seconds", 120)),
    )


def apply_lines(config: dict[str, Any], dry_run: bool) -> list[dict[str, Any]]:
    client = admin_client(config)
    output = []
    for line in config["lines"]:
        group_id, group_action = client.ensure_group(line, dry_run=dry_run)
        account_id, account_action = client.ensure_account(config, line, group_id, dry_run=dry_run)
        key_id, key_action = ensure_downstream_binding(config, line, group_id, dry_run=dry_run)
        output.append({
            "supplier": config["supplier"], "line": line["name"], "product": line["product"],
            "group_id": group_id, "group_action": group_action,
            "account_id": account_id, "account_action": account_action,
            "downstream_key_id": key_id, "downstream_key_action": key_action,
        })
    return output


def verify_line(
    config: dict[str, Any], line: dict[str, Any], admin: Sub2APIClient | None = None
) -> dict[str, Any]:
    sub = config.get("sub2api") or {}
    downstream_env = line.get("downstream_api_key_env")
    if not downstream_env:
        return {
            "supplier": config["supplier"], "line": line["name"], "product": line["product"],
            "status": "SKIPPED", "reason": "downstream_api_key_env is not configured",
        }
    api_key = require_env(str(downstream_env))
    base_url = str(sub.get("base_url", "http://127.0.0.1:8080"))
    timeout = float(config.get("timeout_seconds", 120))
    if admin is not None:
        account_name = str(line.get("account_name", f"{config['supplier']} / {line['name']}"))
        account = admin.find_account(account_name)
        if account:
            admin.recover_account(int(account["id"]))
    test_client = test_user_client(config)
    local_balance_before = test_client.user_balance() if test_client else None
    upstream_before = upstream_usage_snapshot(config, line)
    non_stream = probe_responses(base_url, api_key, line["model"], stream=False, timeout=timeout)
    stream = probe_responses(base_url, api_key, line["model"], stream=True, timeout=timeout)
    upstream_after = upstream_usage_snapshot(config, line)
    local_balance_after = test_client.user_balance() if test_client else None
    passed = non_stream["pass"] or stream["pass"]
    if line.get("expect_non_stream", True):
        passed = passed and non_stream["pass"]
    passed = passed and stream["pass"] and (non_stream.get("usage") is not None or stream.get("usage") is not None)
    billing = billing_delta(local_balance_before, local_balance_after, upstream_before, upstream_after)
    if billing.get("available"):
        passed = passed and bool(billing.get("pass"))
    return {
        "supplier": config["supplier"], "line": line["name"], "product": line["product"],
        "status": "PASS" if passed else "FAIL", "non_stream": non_stream, "stream": stream,
        "usage": bool(non_stream.get("usage") is not None or stream.get("usage") is not None),
        "billing": billing,
    }


def test_user_client(config: dict[str, Any]) -> Sub2APIClient | None:
    sub = config.get("sub2api") or {}
    email_env = sub.get("test_email_env")
    password_env = sub.get("test_password_env")
    if not email_env or not password_env:
        return None
    return Sub2APIClient(
        str(sub.get("base_url", "http://127.0.0.1:8080")),
        require_env(str(email_env)),
        require_env(str(password_env)),
        float(config.get("timeout_seconds", 120)),
    )


def upstream_usage_snapshot(config: dict[str, Any], line: dict[str, Any]) -> dict[str, Any] | None:
    path = config.get("upstream_usage_path")
    if not path:
        return None
    api_key = require_env(str(line["api_key_env"]))
    retries = max(0, int(config.get("usage_transport_retries", config.get("probe_transport_retries", 0))))
    retry_errors: list[str] = []
    for attempt in range(retries + 1):
        try:
            result = request(
                "GET",
                endpoint(str(config["base_url"]), str(path)),
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=float(config.get("timeout_seconds", 120)),
            )
            break
        except OnboardingError as exc:
            if attempt >= retries:
                raise
            retry_errors.append(str(exc))
    parsed = result.json()
    if result.status < 200 or result.status >= 300 or not isinstance(parsed, dict):
        raise OnboardingError(f"upstream usage endpoint returned {result.status} for line {line['name']}")
    total = parsed.get("usage", {}).get("total", {})
    try:
        return {
            "balance": float(parsed["balance"]),
            "requests": float(total["requests"]),
            "actual_cost": float(total["actual_cost"]),
            "_transport_attempts": attempt + 1,
            "_retry_errors": retry_errors,
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise OnboardingError("upstream usage response has an unsupported shape") from exc


def billing_delta(
    local_before: float | None,
    local_after: float | None,
    upstream_before: dict[str, Any] | None,
    upstream_after: dict[str, Any] | None,
) -> dict[str, Any]:
    if local_before is None or local_after is None or upstream_before is None or upstream_after is None:
        return {"available": False, "pass": None, "reason": "local user or upstream usage snapshots are not configured"}
    local_debit = local_before - local_after
    upstream_cost = upstream_after["actual_cost"] - upstream_before["actual_cost"]
    upstream_balance_debit = upstream_before["balance"] - upstream_after["balance"]
    requests = upstream_after["requests"] - upstream_before["requests"]
    return {
        "available": True,
        "pass": local_debit > 0 and upstream_cost > 0 and upstream_balance_debit > 0 and requests >= 1,
        "local_user_debit_usd": round(local_debit, 9),
        "upstream_actual_cost_usd": round(upstream_cost, 9),
        "upstream_balance_debit_usd": round(upstream_balance_debit, 9),
        "upstream_requests": int(requests),
        "upstream_snapshot_transport": {
            "before_attempts": int(upstream_before.get("_transport_attempts", 1)),
            "before_retry_errors": upstream_before.get("_retry_errors", []),
            "after_attempts": int(upstream_after.get("_transport_attempts", 1)),
            "after_retry_errors": upstream_after.get("_retry_errors", []),
        },
    }


def final_status(probe: dict[str, Any], verify: dict[str, Any] | None) -> str:
    required = probe["stream"]["pass"] and probe["codex_protocol"]["pass"] and probe["usage"]
    if probe.get("expect_non_stream", True):
        required = required and probe["non_stream"]["pass"]
    if "codex_cli" in probe:
        required = required and bool(probe["codex_cli"].get("pass"))
    if verify is not None and verify.get("status") not in {"PASS", "SKIPPED"}:
        required = False
    return "READY" if required else "NOT_READY"


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def compatibility_report(config: dict[str, Any], probes: list[dict[str, Any]]) -> dict[str, Any]:
    """Return the portable, secret-free result of the upstream compatibility check."""
    lines = []
    for probe in probes:
        fingerprint = probe.get("fingerprint_diagnostics", {})
        lines.append({
            "line": probe["line"],
            "model": probe["model"],
            "product": probe["product"],
            "responses": {
                "non_stream": bool(probe.get("non_stream", {}).get("pass")),
                "stream": bool(probe.get("stream", {}).get("pass")),
                "usage": bool(probe.get("usage")),
                "codex_protocol": bool(probe.get("codex_protocol", {}).get("pass")),
            },
            "reasoning_acceptance": {
                effort: bool(value.get("accepted"))
                for effort, value in probe.get("reasoning", {}).items()
            },
            "fingerprint_status": fingerprint.get("status", "UNKNOWN"),
            "known_limitations": probe.get("known_limitations", []),
        })
    return {
        "schema_version": 1,
        "supplier": config["supplier"],
        "base_url": config["base_url"],
        "provider": config["provider"],
        "lines": lines,
    }


def risk_report(
    config: dict[str, Any], probes: list[dict[str, Any]], verified: list[dict[str, Any]]
) -> dict[str, Any]:
    """Make operational risks explicit without copying sensitive probe payloads."""
    risks: list[dict[str, str]] = []
    for probe in probes:
        line = str(probe["line"])
        fingerprint = probe.get("fingerprint_diagnostics", {})
        if fingerprint.get("status") != "PASS":
            risks.append({"line": line, "level": "high", "code": "fingerprint", "detail": "API-client fingerprint compatibility is not PASS"})
        for capability, value in (("stream", probe.get("stream", {}).get("pass")), ("codex_protocol", probe.get("codex_protocol", {}).get("pass")), ("usage", probe.get("usage"))):
            if not value:
                risks.append({"line": line, "level": "high", "code": capability, "detail": f"required {capability} capability did not pass"})
        for limitation in probe.get("known_limitations", []):
            risks.append({"line": line, "level": "medium", "code": "known_limitation", "detail": str(limitation)})
    for item in verified:
        if item.get("status") == "FAIL":
            risks.append({"line": str(item["line"]), "level": "high", "code": "downstream_verify", "detail": "Sub2API downstream verification failed"})
        elif item.get("status") == "SKIPPED":
            risks.append({"line": str(item["line"]), "level": "medium", "code": "downstream_verify", "detail": str(item.get("reason", "verification skipped"))})
    return {"schema_version": 1, "supplier": config["supplier"], "risks": risks}


def write_artifacts(
    output_dir: str | None, config: dict[str, Any], report: dict[str, Any]
) -> dict[str, str]:
    if not output_dir:
        return {}
    destination = Path(output_dir)
    artifacts = {
        "configuration_template": destination / "configuration-template.json",
        "compatibility_report": destination / "compatibility-report.json",
        "risk_report": destination / "risk-report.json",
        "onboarding_report": destination / "onboarding-report.json",
    }
    write_json(artifacts["configuration_template"], config)
    write_json(artifacts["compatibility_report"], report["compatibility"])
    write_json(artifacts["risk_report"], report["risk"])
    write_json(artifacts["onboarding_report"], report)
    return {name: str(path) for name, path in artifacts.items()}


def write_report(path: str | None, report: dict[str, Any]) -> None:
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if path:
        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Probe and onboard suppliers into Sub2API")
    parser.add_argument("command", choices=("probe", "apply", "verify", "run", "onboard"))
    parser.add_argument("--config", required=True)
    parser.add_argument("--report", help="optional JSON report path (keep sensitive runtime output outside Git)")
    parser.add_argument("--output-dir", help="write configuration template, compatibility, risk, and unified reports here")
    parser.add_argument("--dry-run", action="store_true", help="show management actions without writing")
    args = parser.parse_args(argv)
    try:
        config = load_json(args.config)
        validate_config(config)
        report: dict[str, Any] = {
            "schema_version": 1,
            "run_id": str(uuid.uuid4()),
            "supplier": config["supplier"],
            "command": args.command,
            "dry_run": args.dry_run,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        pipeline = args.command in {"run", "onboard"}
        probes = [probe_line(config, line) for line in config["lines"]] if args.command in {"probe", "run", "onboard"} else []
        probe_ready = all(final_status(probe, None) == "READY" for probe in probes)
        apply_allowed = args.command == "apply" or (pipeline and probe_ready)
        applied = apply_lines(config, args.dry_run) if apply_allowed else []
        verify_allowed = args.command == "verify" or (pipeline and probe_ready and not args.dry_run)
        verify_admin = admin_client(config) if verify_allowed else None
        verified = [verify_line(config, line, verify_admin) for line in config["lines"]] if verify_admin else []
        report.update({"probes": probes, "applied": applied, "verified": verified})
        if pipeline and not probe_ready:
            report["pipeline"] = {"status": "STOPPED", "reason": "probe gate failed; apply and verify were not run"}
        elif pipeline:
            report["pipeline"] = {"status": "COMPLETE" if not args.dry_run else "DRY_RUN"}
        if probes:
            report["lines"] = [
                {
                    "line": probe["line"],
                    "product": probe["product"],
                    "status": final_status(probe, verified[index] if verified else None),
                }
                for index, probe in enumerate(probes)
            ]
        report["compatibility"] = compatibility_report(config, probes)
        report["risk"] = risk_report(config, probes, verified)
        report["artifacts"] = write_artifacts(args.output_dir, config, report)
        write_report(args.report, report)
        return 0 if (not pipeline or report.get("pipeline", {}).get("status") in {"COMPLETE", "DRY_RUN"}) and all(item.get("status") != "NOT_READY" for item in report.get("lines", [])) else 2
    except OnboardingError as exc:
        print(json.dumps({"status": "FAILED", "stage": args.command, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

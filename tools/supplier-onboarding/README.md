# Supplier onboarding

This tool keeps supplier onboarding outside the Sub2API core. It probes an upstream,
creates or updates the native Sub2API product group and upstream account through the
management API, then verifies the downstream path.

## Inputs

Copy `examples/first-supplier.example.json` to a local ignored directory. Keep only
non-secret metadata in JSON:

- supplier name and Base URL;
- provider type and line name;
- model and target public product name;
- upstream cost multiplier and public price multiplier;
- concurrency, optional RPM limit, and priority;
- environment-variable names for upstream and downstream keys.

For an end-to-end verification key, set `downstream_key_name` and the test-user
credential environment-variable names. `apply` rebinds that existing test key to the
target product through the ordinary user API; it never creates or prints a new secret.

Secrets are read only from the named environment variables. The tool never prints or
writes key values. The current provider adapter is `openai_responses`; adding another
protocol means adding a probe adapter rather than assuming `/v1/models` exists.

## Commands

```powershell
python tools/supplier-onboarding/onboard.py probe --config local-supplier.json
python tools/supplier-onboarding/onboard.py apply --config local-supplier.json --dry-run
python tools/supplier-onboarding/onboard.py apply --config local-supplier.json
python tools/supplier-onboarding/onboard.py verify --config local-supplier.json
python tools/supplier-onboarding/onboard.py onboard --config local-supplier.json --output-dir .local-sub2api-release/runtime/supplier-a --report .local-sub2api-release/runtime/supplier-a/onboarding.json
```

`onboard` is the standard pipeline: `probe → fingerprint → apply → verify`.
Fingerprint diagnostics are part of `probe`; they are not a separate supplier-specific
step. The pipeline gates writes: if compatibility probe requirements fail, `apply` and
`verify` do not run. `run` remains a backwards-compatible alias for this flow.

A single `onboard --output-dir` generates four secret-free artifacts:

- `configuration-template.json`: the reusable environment-variable based config;
- `compatibility-report.json`: protocol, usage, reasoning-parameter, and fingerprint results;
- `risk-report.json`: explicit operational risks and unverified conditions;
- `onboarding-report.json`: the unified report with all stages and artifact paths.

`apply` is name-idempotent: it updates an exact-name product group/account, otherwise
it creates one. It uses only `/api/v1/admin/groups` and `/api/v1/admin/accounts`; it
does not write PostgreSQL directly.

`probe` checks non-stream Responses, stream completion, usage, `high`/`xhigh`/`max`
parameter acceptance, and a Codex-style streaming request. Parameter acceptance is
reported separately from the actual reasoning tier, which remains unknown. Set
`probe_models` only when the supplier implements `/v1/models`.

Every `probe` also performs a non-stream fingerprint comparison before onboarding: a
controlled `curl/8.5.0` User-Agent and the current Python `urllib` default-style
User-Agent issue otherwise identical Responses requests. This exposes CDN/WAF rules
that accept normal API clients but reject Python's default signature (the Supplier-B
failure mode) before an account is created. It adds two upstream probe requests per
line; it does not change `apply`, `verify`, downstream traffic, or supplier settings.

`fingerprint_diagnostics.status` is `PASS` when both profiles receive a 2xx response,
`FAIL` when an HTTP response proves a rejection (including a Python-urllib-only
rejection), and `UNKNOWN` when at least one profile receives no HTTP response. Each
profile records the controlled UA, request HTTP version, observed response HTTP
version, HTTP status classification, response header names, safe infrastructure/header
values, request id, and JSON field shape. Response content, API keys, authorization
values, cookie values, and values of unrecognised headers are never recorded.

Other probe fields retain the same non-sensitive runtime fingerprint: selected
infrastructure and request-id headers, status/content type, error and usage field
shapes, SSE event types, true first-body-byte timing, total timing, and
interrupted/incomplete reads. `probe_transport_retries` may retry failures only when
no HTTP response was received; the attempt count and every pre-response error remain
visible in the report.
Read-only upstream usage snapshots use the same retry count by default (override with
`usage_transport_retries`) and expose their retry evidence in the billing result.

`verify` sends both non-stream and stream requests through a configured downstream
Sub2API key. It confirms response usage. When `upstream_usage_path` and test-user
credentials are configured, it snapshots the user's Sub2API balance and the supplier's
aggregate request/cost/balance counters before and after the calls; billing passes only
when both sides show a positive debit. Providers with a different usage schema need a
small provider-specific parser.

For a real Codex CLI check, an optional `codex.command` array can be supplied. It is
executed directly without a shell. `{base_url}`, `{model}`, and `{api_key_env}` are
substituted in arguments; `{api_key}` may be used only inside `codex.env` values.
Set `codex.expected_output` to require a semantic marker in addition to exit code zero.
Set `probe_http_error` to capture the status and JSON shape produced by an intentionally
invalid bearer token; no real credential is sent by that error probe.

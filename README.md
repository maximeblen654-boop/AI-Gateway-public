# AI-Gateway

[简体中文](README_CN.md) · [日本語](README_JA.md)

AI-Gateway is a source distribution derived from [Sub2API](https://github.com/Wei-Shaw/sub2api). It includes the Go API gateway, Vue administration interface, native account/group/key management, and image/video task components. The public tree contains source, tests, synthetic fixtures, and configuration examples.

This snapshot combines the Sub2API foundation with this project's Studio/BFF, media task and administration integration changes and related tests. Those changes include edits to upstream files as well as added files; the complete tree is not wholly original work.

## Source layout

| Path | Purpose |
| --- | --- |
| `backend/` | Go services, database migrations, embedded resources and tests |
| `frontend/` | Vue/TypeScript application and browser/unit tests |
| `studio/` | Media request planning, BFF, durable tasks and contract tests |
| `deploy/` | Deployment examples and shell regression tests |
| `docs/` | Public API, legal and configuration documentation |

## Build and test

The checked-in CI uses Go `1.27.0`, Node.js `24.21.0` and pnpm `9.15.9`. See `backend/go.mod`, `frontend/package.json`, the lockfiles and `.github/workflows/` for the exact inputs.

```sh
pnpm --dir frontend install --frozen-lockfile
make build
make test-frontend
make -C backend test-unit
make -C backend test-integration
```

Frontend output is generated into `backend/internal/web/dist`; generated bundles are not shipped in this source tree. An `embed` build requires generating the frontend first, as the root Dockerfile does. Integration tests may provision disposable PostgreSQL/Redis containers. Media tests may require ffmpeg/ffprobe; the CI installs those tools. Tests use local fixtures and do not need production or supplier credentials.

The root `Dockerfile` builds the source and embedded frontend. Deployment examples are in [deploy/README.md](deploy/README.md). Select the image built from the intended source when deploying; inherited upstream image defaults do not identify this source distribution. Configure real credentials only in private runtime configuration, never in examples or Git.

Public references: [asynchronous images](docs/ASYNC_IMAGE_TASKS.md), [payment configuration](docs/PAYMENT.md), [plugin development](docs/PLUGIN_DEVELOPMENT.md), and [local media tests](tools/phase5-media-e2e/README.md). Synthetic test prices and account IDs are examples, not offers of service.

Native Antigravity OAuth requires `ANTIGRAVITY_OAUTH_CLIENT_ID` and `ANTIGRAVITY_OAUTH_CLIENT_SECRET`; native Gemini CLI (`code_assist` / `google_one`) requires `GEMINI_CLI_OAUTH_CLIENT_ID` and `GEMINI_CLI_OAUTH_CLIENT_SECRET`. Supply an authorized pair through private runtime configuration. There are no built-in credentials. Missing or incomplete pairs disable only the corresponding authorization and refresh paths, including refresh of existing OAuth Accounts. Website login, API Key connections, Studio sessions and separately configured AI Studio OAuth remain independent. Existing refresh tokens require the same client identity that originally issued them.

## License and attribution

The existing [GNU Lesser General Public License v3.0](LICENSE) (or later) and [upstream contributor agreement](CLA.md) are retained. Sub2API upstream authors and contributors retain their copyrights; source-file notices remain in place. Public Sub2API development and sponsor information is available in the [upstream repository](https://github.com/Wei-Shaw/sub2api).

Copyright (c) 2026 Wesley Liddick

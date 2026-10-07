# AI-Gateway

[English](README.md) · [日本語](README_JA.md)

AI-Gateway 基于 [Sub2API](https://github.com/Wei-Shaw/sub2api)，保留 Go 网关、Vue 管理端、原生账户/分组/API Key 管理及图片、视频任务组件。公开目录包含源码、锁文件、测试、合成 fixture 和配置样例。

本快照包含 Sub2API 底座，以及本项目在其基础上的 Studio/BFF、媒体任务、管理集成和相关测试修改。修改既涉及上游已有文件，也包含新增文件；完整源码并非全部原创。

## 开发构建

当前 CI 固定 Go `1.27.0`、Node.js `24.21.0`、pnpm `9.15.9`；精确依赖见 `backend/go.mod`、`frontend/package.json` 与锁文件。

```sh
pnpm --dir frontend install --frozen-lockfile
make build
make test-frontend
make -C backend test-unit
make -C backend test-integration
```

前端输出由构建生成至 `backend/internal/web/dist`，源码目录不携带旧构建包。使用 `embed` 构建标签前需先生成前端，根 Dockerfile 已包含这个顺序。集成测试可能启动临时 PostgreSQL/Redis 容器；部分媒体测试需要 ffmpeg/ffprobe，CI 会安装相应工具。测试使用本地合成输入，不需要生产或供应商凭据。

根 `Dockerfile` 用于从源码构建带前端的应用。部署入口见 [部署说明](deploy/README.md)；部署时明确选择对应源码构建的镜像，继承的上游默认镜像不能代表本源码快照。真实凭据只在私有运行配置中填写。

Antigravity 原生 OAuth 需要运行配置 `ANTIGRAVITY_OAUTH_CLIENT_ID` 与 `ANTIGRAVITY_OAUTH_CLIENT_SECRET`；Gemini CLI 原生 OAuth（`code_assist` / `google_one`）需要 `GEMINI_CLI_OAUTH_CLIENT_ID` 与 `GEMINI_CLI_OAUTH_CLIENT_SECRET`。两项必须完整且有权使用，源码没有内置凭据。缺失时只停用对应授权和刷新，包括已有 OAuth Account 的刷新；网站登录、API Key 对接、Studio session 及单独配置的 AI Studio OAuth 不依赖这些配置。已有 refresh token 必须继续使用原授权客户端身份。

## 文档与测试

- [异步图片任务](docs/ASYNC_IMAGE_TASKS.md)
- [支付配置](docs/PAYMENT_CN.md)
- [插件开发](docs/PLUGIN_DEVELOPMENT.md)
- [本地媒体测试](tools/phase5-media-e2e/README.md)

`backend/`、`frontend/`、`studio/` 保留对应实现与测试，`deploy/` 保留部署样例和 shell 回归。样例中的价格、账户与素材均不能替代真实服务配置或销售承诺。

## 许可与上游归属

保留已有 [GNU LGPL v3.0](LICENSE)（或更新版本）、[上游贡献者协议](CLA.md) 及源码版权标注。感谢 Sub2API 作者与贡献者；上游开发和赞助信息见 [Sub2API](https://github.com/Wei-Shaw/sub2api)。

Copyright (c) 2026 Wesley Liddick

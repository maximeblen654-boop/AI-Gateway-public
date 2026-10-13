# AI Gateway 客户工作台 · 方向比较

本阶段目标是重新设计客户生成工作台，不是管理员五步向导或旧表单的局部润色。

[打开离线对比页](style-explorer.html)（下载后在浏览器打开；GitHub 本身只显示 HTML 源码）。

| 方案 | 工作方式 | 截图 |
| --- | --- | --- |
| A · 轻聊（推荐） | 居中创作输入，悬浮模型/比例，左侧任务历史 | [A](screenshots/a.png) |
| B · 对照 | 左侧描述、右侧查看已有作品 | [B](screenshots/b.png) |
| C · 作品桌 | 历史作品作为主工作区，底部创作条 | [C](screenshots/c.png) |

主文案：**让想法有画面。**

三版使用同一份 `content.json` 合成内容；海报为 HTML/CSS 排版的设计素材，不是供应商生成结果。截图是 1440×900 的 Chromium 实际渲染，已经逐张查看。原始参考截图未上传，未包含生产账号/价格/凭据。

目前交付为静态方向稿，比较页支持并排、单张与选择；方案内模型选择、模式切换、下载、报价没有接入业务。未宣称手机、深色、动画或完整工作流已经验收。选定后再实现完整页面、移动端和业务状态。

- 本地服务：`python -m http.server 4294 --bind 127.0.0.1 --directory docs/ui/studio-redesign-2026-10-14`。
- 原始 HTML：`a.html`、`b.html`、`c.html`；比较页可离线打开。
- 重建方向 HTML：`python docs/ui/studio-redesign-2026-10-14/build_previews.py`。
- 对比页由 oil-ui 0.22.2 的 `scripts/build_explorer.py manifest.json --force` 生成。
- [本阶段工程交接](HANDOFF.md)。

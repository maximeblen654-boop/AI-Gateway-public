# AI-Gateway 作品桌 UI：交给 ChatGPT 的审核说明

更新日期：2026-10-14。当前状态：**源码、截图、CI、安全与真实隔离联调已完成；未部署，尚未构建包含新前端的完整运行候选。**

## 请审核什么

本次是用户选定的 C「作品桌」客户工作台改造，以及先前已完成的两处管理员按钮优化。请以代码差异、截图和隔离证据为依据审查是否可以进入运行候选准备阶段，列出具体阻塞或非阻塞建议；不要把已结束的 runner 或视觉 fixture 当作生产验收，不要求真实付费生成。

## 版本与代码位置

- 仓库：`maximeblen654-boop/AI-Gateway-public`；分支：`codex/studio-native-media`。
- 用户最后确认的生产基线：`b2fcdac93afa6ae194ee81801a9b37813f8f39eb`。本次没有连接生产重新审计。
- 已验收运行前端与联调脚本：`40310e2961a5e8150e0c9df4cc86bb8087406c06`。
- 后续提交只归档文档/截图；不是新运行代码或镜像版本。
- [生产基线至本次源码的完整差异](https://github.com/maximeblen654-boop/AI-Gateway-public/compare/b2fcdac93afa6ae194ee81801a9b37813f8f39eb...40310e2961a5e8150e0c9df4cc86bb8087406c06)。
- 主要实现：`frontend/src/components/video/StudioMediaPanel.vue`、`StudioSpecPicker.vue`、`StudioMark.vue`、`frontend/src/styles/studio-workspace.css`、`frontend/src/views/user/VideoStudioView.vue`。
- 管理员两处优化：`frontend/src/views/admin/MediaWorkbenchView.vue`、`frontend/src/styles/media-workbench.css`。
- 差异另含现有非生产验收 workflow/harness 与测试文件；`backend/`、`studio/` 运行源码与 b2 基线无差异。

## 已完成的用户行为

1. 文生图、图生图、单视频与历史任务导航；暖铜色折光 G、空历史状态、桌面/手机和浅/深主题。
2. 悬浮模型选择、比例点选；数量 1～10 改为五列两行，服从商品允许的子范围；分辨率、画质、时长采用有高度上限的紧凑面板。
3. 文生图无附件入口；图生图和支持素材的视频使用回形针，沿用粘贴、拖拽及私有上传。视频仍一次一条。
4. 点击“开始生成”先取服务端报价，再确认本次金额，确认后才提交。报价、权限、资金和结算继续使用现有后端。
5. 历史、下载、partial 的原报价/实际结算和未知任务恢复保持正确；未知结果不自动重发。
6. 管理员“返回模型列表”更清楚；Account 级“发布配置”移到易见位置，保留二次确认与“不会自动开启销售”的说明。

## 已运行的证据

- 组件/视图/API：51 项 PASS；ESLint PASS。
- Chromium：11 项连续三轮 PASS，1440px 桌面和390px 手机；截图已经人工检查。
- [完整 CI 38472646408](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38472646408)：PASS。
- [Security 38472646470](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38472646470)：PASS。
- [真实隔离后端联调 38472664634](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38472664634)：PASS。真实 Vue → Core/Bridge/BFF/PostgreSQL/Redis，仅上游为模拟器，没有浏览器 API 伪造。
- 文生图3张/3请求、编辑2张/2请求、视频1条/1提交；各一次原生usage及结算。刷新、查询、重复下载无新增生成或扣费；原片摘要一致，视频实际播放通过。
- 联调后端精确复用 b2 三组件。当前前端由隔离 Vite 提供，**这证明接口联调，不代表已构建或部署新 Core 镜像**。
- [精简联调结果](evidence/real-backend-summary.json)、[本地验证](evidence/local-validation.json)、[历史策略证据](evidence/history-policy.json)。原始小证据 Artifact `11853315700` 有效至 `2026-10-27T21:45:10Z`，本目录摘要和截图随 Git 保存。

## 看哪些截图

- [作品桌桌面](screenshots/c-gallery-desktop.png) / [手机](screenshots/c-gallery-mobile.png)
- [无历史](screenshots/c-empty-desktop.png) / [参考素材](screenshots/c-edit-mobile.png)
- [数量面板桌面](screenshots/c-quantity-desktop.png) / [手机](screenshots/c-quantity-mobile.png)
- [partial 与结算](screenshots/c-partial-desktop.png) / [生成金额确认](screenshots/c-generation-confirmation.png)
- [真实后端图片](screenshots/c-backend-image.png) / [编辑](screenshots/c-backend-edit.png) / [视频](screenshots/c-backend-video-compatible.png)

咖啡作品来自 UI fixture，只证明视觉。真实后端图片模拟器提供有效1×1 PNG，截图因此显示纯色块，不冒充真实供应商作品。当前4295本地预览也是视觉 fixture；云端真实隔离栈已结束。

## 审核重点与下一步

请重点检查规格控件没有改变服务端报价/数量合同；文生图与编辑素材边界；partial/unknown/恢复与原片权限；手机、键盘与长选项；管理员发布范围及确认保护。

历史策略未改：视频接口默认最近50条是返回上限，不是删除；图片历史没有相同条数上限。新图片原片默认72小时，历史记录不等于永久保存原片。不要将前端重设计扩展为新的保留/删除策略。

审核通过后还需用既有 GitHub-hosted 流程准备包含新前端的 Core 运行候选，并核对最终产物、必要启动验收及精确指纹；Bridge/BFF 运行代码未改，可核对现有镜像的复用条件，不重复构建无关组件。

**GPT 审核通过不等同于用户生产部署授权。** 用户明确授权本次上线后，Codex 才执行现网必要核对、维护/切换和非付费验收。商品发布、启售与真实供应商调用仍是独立事项。

本阶段未部署、未修改生产账号/商品/价格/开关、未发真实供应商或实付请求。正式根 `AI-Gateway-Handoff.md` 和 Constraints 未改；本目录为 Codex 工作证据，正式交接由 ChatGPT 根据实证维护。

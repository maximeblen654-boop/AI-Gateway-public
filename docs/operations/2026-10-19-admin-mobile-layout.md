# 管理员移动布局与浏览器验收规则（2026-10-19）

本地修复完成，NOT_DEPLOYED。生产仍为 b9796b975c1ced95366d7e65c8976364664f658c，本轮未登录、连接或修改生产。

## 根因与更正

生产截图显示的严重窄列不能证明持久布局故障。本地真实 MediaWorkbenchView → AppLayout → AppSidebar 复现：1440 切换到390时，AppLayout transition-all 让 lg:ml-64 的左边距从256px动画过渡至0；即时读数254.152px，500ms后0。直接进入手机页面原本宽度正常。之前验收截图捕获了过渡帧，人工判断应据此更正。

最小修复：AppLayout 内容区添加命名类，在 max-width:1023px 禁用内容区 transition，断点切换立即释放桌面侧栏空间。桌面折叠动画及移动侧栏自身导航动画保持。无需修改 AppSidebar、MediaWorkbenchView 或 media-workbench.css 的业务/布局结构。

## 测试与证据

真实 Vue 外壳 + 商品编辑器，API 使用本地隔离 fixture，非生产联调：360、390、768、1366、1440全部5项 Playwright PASS。检查内容区实际宽度、编辑器宽度、侧栏关闭位置/打开位置及不挤压内容、五步骤、价格输入宽度、保存按钮可触达、脏表单弹窗及关闭。

消融：移除新样式，390测试失败，断言期望0px实际13.1995px（截图后读数）；重新应用后全部通过。完整 vue-tsc --noEmit PASS；受影响 AppLayout/layout.spec ESLint PASS。

证据本机：D:/AI-Gateway/.codex-tmp/admin-layout-20261019/before 与 after；after下每视口包含 resize 和 editor PNG、results.json。生产原始对照仍在 .codex-tmp/b979-browser-acceptance/production-evidence。模拟截图不冒充生产修复后的截图。

## 规则与边界

实际生效 D:/AI-Gateway/AGENTS.md 增加一条浏览器会话生命周期规则：先验证通道，一次认证完成整轮，异常先诊断，不无证据反复要求登录，结束安全关闭。只提交该增量；此前工作树规则修改保持未提交。正式 Constraints 和 Handoff 原件未覆盖。

无商品、售价、业务权限、销售开关、资金或原片改动。源码基于干净 codex/media-paid-controls 的 b05f8f76（b9796b后文档提交）。需要另一次正式生产部署授权；本轮未构建镜像或部署。

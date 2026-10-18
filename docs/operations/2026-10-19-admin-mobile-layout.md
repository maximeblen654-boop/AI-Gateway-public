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

## 远端与新候选核验（2026-10-19）

最终状态：**CANDIDATE_READY_NOT_DEPLOYED**。

- 固定运行源码：`b5b23a1f01721d41d94fb03bc6ac8796453dd24b`。用户消息中的短串漏了 `41d`，以此完整 Git SHA 为准。
- 公共仓库 `codex/media-paid-controls` 已推送该提交；父提交 b05f8f76d8292cdec32af79e8af71f85ce2d1d56 是 b9796b 后的证据文档提交。之后的本报告提交仅含文档和截图，不改变固定候选。
- 项目规则仓库 AI-Gateway 的 `codex/video-studio-portal-bff` 已推送 `f41111b5dc05ad3cf40e7fbd930b93efe34ea5db`，其父提交是既有精确模型身份规则文档9395be6。没有将主工作区270项未提交工作提交或覆盖。AGENTS不在应用仓库跟踪文件中，构建配方不复制规则仓库。
- [CI 39144945843](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/39144945843)：PASS。
- [Security 39144945857](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/39144945857)：PASS。
- [Candidate 39144994561](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/39144994561)：PASS，build_source_sha固定为上述源码，paid-controls标准验收，focused_entry=false。
- 完整Artifact `12143512127`，GitHub归档摘要 `638770c4f2cee4ba8db21cf949975c52aad2650c8eef2642809bb3fa1006697b`。
- 证据Artifact `12143263322`，GitHub归档摘要 `8e08595322a54e45bbfe98882d9e2fb16fc8a000556eeaf7d59765b4a08ef0ff`。
- CI视觉Artifact `12143007158`。
- 最终manifest SHA256：`43912b83efa4b538c323a9ff2b214f6197bff59f17e3ad777b7537bf564bfefd`。通过GitHub官方Artifact API取得授权下载地址，以有限Range独立读取完整包和证据包内manifest/acceptance；两包对应文件字节摘要一致。未下载完整TAR再次计算，本次TAR及OCI身份来自已成功的标准构建/导出校验，下一轮部署导入前仍需核验实际TAR。
- manifest内部 acceptance=PASS、production_action=false；acceptance.json三个实际隔离容器healthy，image与manifest的config digest一致。精确TAR SHA256、OCI manifest及config digest见[封存manifest](2026-10-19-admin-mobile-layout-evidence/candidate-manifest.json)。

### 门禁范围

| 项目 | 结果与证据 |
|---|---|
| 固定源码、CI、安全检查 | PASS，上述三个Run head_sha一致 |
| 三组件构建、隔离非付费验收 | PASS，新manifest与acceptance一致；未沿用b979镜像 |
| 五视口真实组件与反向测试 | PASS，复用同源码证据；[摘要](2026-10-19-admin-mobile-layout-evidence/layout-acceptance-summary.json) |
| 业务范围 | PASS，仅AppLayout一处响应式动画变更；无后端、价格、开关或权限改动 |
| 公网路由、代理、生产回退及现场指纹 | N/A，本轮禁止生产操作；部署授权后另做当次现场门禁，不冒充已通过 |
| 本次生产部署 | 未执行，生产b9796b为用户提供基线，本轮未重新连接核查 |

### 截图

均为本地真实Vue组件、隔离fixture，不是生产修复后截图。

- [旧样式390过渡帧](2026-10-19-admin-mobile-layout-evidence/before-resize-390.png)
- 修复后：[360](2026-10-19-admin-mobile-layout-evidence/after-editor-360.png)、[390](2026-10-19-admin-mobile-layout-evidence/after-editor-390.png)、[768](2026-10-19-admin-mobile-layout-evidence/after-editor-768.png)、[1366](2026-10-19-admin-mobile-layout-evidence/after-editor-1366.png)、[1440](2026-10-19-admin-mobile-layout-evidence/after-editor-1440.png)。

下一步仅为针对固定候选的独立生产部署审批；未经批准不切换，不恢复或修改任何生产开关。无需再次开发此布局修复。

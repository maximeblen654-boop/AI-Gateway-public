# 草稿保护、逐规格成本及媒体商品聚合：实施交付

状态：`SOURCE_READY_UNCOMMITTED_NOT_DEPLOYED`。2026-10-19。

工作仓库 `D:/AI-Gateway-public-staging`，分支 `codex/media-paid-controls`，基础提交仍为 `33c819064ef95666f6b512ebaed1e2d7a09e34d6`。按本轮要求未提交、未推送、未构建候选、未连接生产、未部署、未调用真实供应商。私有工作区、正式 Constraints/Handoff 原件未覆盖。

## 1. 草稿保护及保存确认

- 商品输入变化同步写入本地恢复副本，身份含管理员、Account、Product、SiteModel、UpstreamModel。只保存允许编辑的 Product 字段，不保存 Account DTO、凭据或会话。
- 同一页面按稳定编辑器身份维护独立副本；另一页面关闭不会覆盖本页副本。可选择、比较、明确恢复或丢弃副本；离线新商品刷新后可发现，恢复保留原 Product ID。
- 停输约 1.5 秒后服务器自动保存；编辑器失焦或切换步骤提交待保存内容。请求串行执行，较新输入合并排队，旧回执不能覆盖新输入。
- 保存仍为原 Account 草稿结构及 CAS，不发布、启售或写 API Channel。未完成配置可保存为校验未通过草稿。
- 每次 PUT 使用 `submission_id`、`expected_record_version`；服务器第一次 CAS 原子记录 `draft.save_receipt` 的提交 ID、基准版本及草稿 revision。确认同时比较回执、版本及规范化后的实际输入。并发替代返回 409，不能将其他页面最新 DTO 当作本次保存成功。
- 超时或回读失败只查询确认，不自动重发未知结果的 PUT。重连先读服务器版本；冲突按商品保留，恢复 A 不会解除 B 的冲突。
- 明确拒绝的未修改输入不会因切步/失焦反复自动提交；修改输入或主动手动重试后才能再提交。手动保存操作保留。
- 核对服务器状态不覆盖输入；放弃修改需确认，且只删除属于该操作、内容仍匹配的副本。未恢复的其他商品/其他页面副本继续保留。
- 存储失败、超限、已保存、保存中、失败、待核对和冲突有明确状态。每个 Account 普通本地恢复保护上限 32 份，超限提示，不驱逐已有副本。

## 2. 图片和视频的商品入口、规格与 Offer

- 视频 Catalog 新增专用 `video-product` 域的 `product_scope`，输入包含媒体类型、Account ID、Product ID、Published revision；不复用图片域。图片原 scope 保持不变。
- 模型选择器按可靠 scope 及精确 SiteModel/UpstreamModel 聚合，同一商品一个入口；不同商品即使同名仍独立。没有可靠 scope 的旧条目不猜测合并。
- 原 Offer ID、价格、Published 和历史绑定不删除、不重建。时长、分辨率、比例、画质、数量及素材变更仍匹配具体 Offer，报价使用实际 Offer ID。
- 多维切换可以经过暂时不可售组合；该状态阻止报价，不自动替换用户参数。最终规格必须匹配合法 Offer；后端原校验及冻结合同继续生效。
- 模型摘要包含时长；被动统计及中性无数据状态保留。视频 BFF 透传 scope 和独立 Offer，不做实体合并。
- 删除管理员固定 5/10/15 秒快捷按钮；保留已有时长、自定义范围、合法离散值与已有 Offer。

## 3. 逐规格成本、售价和试算

- 第四步使用相邻的采购成本/售价/毛利列，手机为规格卡片。关联依据合法规格与 Match，成本、售价规则可以数量不同、顺序不同，不按数组行号配对。
- 原共享价格/成本维度保留，界面明确修改影响的共享行数；不会自动拆价、合价或重写其他规格。复杂格式、重叠或超过 256 展示行的配置保留高级规则，不截断。
- 积分换算使用固定点 BigInt：采购金额 ÷ 实际到账积分 × 单张/整条任务积分；不再乘时长。精确换算结果需明确采用后才成为实际成本。
- 毛利润为实际售价减实际成本；毛利率为毛利润 ÷ 售价，空值/无效值不冒算，零售价不算毛利率。不是净利润。
- 成本及售价建议独立。规律建议限同商品、其他条件相同、至少三个一致的显式时长样本；样本不足、冲突、重叠或条件不明不猜价。采用建议须点击；覆盖已有金额须确认。
- 采购金额、到账积分、消耗积分是辅助试算参数，在浏览器立即逐字段/逐规格记忆；兼容读取旧 v1。`0.`、`abc` 等未完成输入原样保留但不能参与有效金额计算；不让某个无效字段阻止其他字段保护，也不写回整份旧快照覆盖其他页面。
- 试算字段每项最长 128 字符，普通规格记忆上限 256，枚举有上界；失败明确提示、不静默删除。该本地容量保护不承诺跨进程配额线性一致。
- **服务器自动保存的是商品成本、售价和规格草稿；辅助试算原始参数仅在本浏览器保存。** 它们不会自动变成正式采购成本或 API Channel 配置。

## 4. 实际验证

| 检查 | 结果 | 证据范围 |
|---|---|---|
| 前端受影响集成/单元 | 359/359 PASS | 20 文件；真实 Vue、API 序列化、草稿、图片/视频、价格、试算存储 |
| Go mediaworkbench + admin handler | 408 顶层 PASS，1 原有性能基线 SKIP，0 FAIL | 子任务实际运行缓存 Go 1.27.2，含子测试 688 PASS；未运行 PostgreSQL 集成 |
| Go 受影响 service | 18 顶层 PASS，0 FAIL/SKIP | 含子测试 55 PASS，视频 scope、WAN Catalog/报价诊断及图片 scope 回归 |
| 视频 BFF scope 透传 | 1/1 PASS | 原生 Node 测试；仅模拟只读 Catalog，禁止其他调用 |
| 管理端 Playwright | 36/36 PASS，0 flaky/skip | 8 恢复/自动保存、4 新计算器、10 五视口浅深布局及 14 保存/发布/销售故障合同回归 |
| 客户端 Playwright | 3/3 PASS | 1440×900、1366×650、390×844；图片/视频聚合、精确 Offer/报价及无生成 POST |
| 完整 vue-tsc、变更源码 ESLint、diff check | PASS | 本地既有依赖；无升级/下载 |

浏览器使用实际 Vue、AppLayout/AppSidebar 及正式 API 序列化，但数据及传输为隔离 fixture/mock adapter，不是生产验收，也不是完整真实 Core/Bridge/BFF 联调。Go/HTTP/BFF 合同测试独立补充；无真实付费交易。两次历史保存失败的最初 HTTP 原因因缺少原始日志仍为 UNKNOWN，以上修复针对源码及故障回归已证实的缺口。

命令与完整结果：`D:/AI-Gateway-public-staging/.codex-tmp/cost-draft-unified-20261019/` 下 `frontend-tests.json`、`workbench-procurement-final.json`、`studio-workspace-final.json`。首次验收失败记录保留为 first-round，用于追溯旧手动保存测试假设及已修复的重复提交反例。

关键源码：

- `backend/internal/mediaworkbench/media.go`、`save_receipt_test.go` 及 admin handler/tests：提交归属与 CAS。
- `backend/internal/service/studio_video_runtime.go`、`studio_video_catalog_scope_test.go`：视频商品 scope。
- `frontend/src/composables/useMediaWorkbench.ts`、`draftRecovery.ts`、API/View 及测试：三层草稿保护。
- `frontend/src/components/video/StudioMediaPanel.vue`、`StudioModelPicker.vue`、`studioProductOffers.ts` 及测试：入口聚合与规格映射。
- `frontend/src/components/admin/media/MediaProductEditor.vue`、`MediaProcurementEditor.vue`、`MediaCostCalculator.vue`、`costSpecRows.ts`、`costCalculator.ts`、`costMemoryStorage.ts` 及测试：统一成本/售价和本地试算。
- `studio/bff/video-account.test.mjs`、`frontend/tests/workbench-procurement/`、`frontend/tests/studio-workspace/`：透传及浏览器验证。

## 5. 兼容性及审查边界

- 无数据库表结构迁移；新版本读取旧草稿兼容，原 Published、Offer、资金、receipt、usage/dedup、历史任务及 API Channel 路径未改写。
- **新增的 `draft.save_receipt` 为持久化 JSON 字段。旧 `8ad` 的严格 JSON reader 不识别此字段。未来若部署并产生新草稿写入，不能直接降级旧镜像；发布前需要单独审查兼容回退方案。** 这里不以删除回执、覆盖 Account 或恢复旧数据库解决兼容问题。
- 高级规则、共享价格和成本仍由管理员明确决定；没有采购商业价格推测、商品发布或销售开关变更。
- 本轮无 Git 提交、CI/Security Actions 或镜像候选。不能把工作区文件集摘要当作新 Git SHA/已验收镜像。
- 38 个源码/测试文件的逐项 SHA256：`source-files.json`；文件集 SHA256 `cdf5a46398e6ccfb9cedd4986297243d2c41cc3ded58e3411ec890a49e95b81f`。文档不在运行源码文件集内。
- 结束时 C 约 5.22 GiB、D 约 22.80 GiB 可用。未清理磁盘/共享缓存；测试复用现有依赖和 Go 缓存，保留小型正式证据，未重复下载候选。

## 6. 截图与最小交接增量

截图均为本地隔离实际 Vue 页面，不是原型或生产：

- [1440 桌面成本/售价](D:/AI-Gateway-public-staging/.codex-tmp/cost-draft-unified-20261019/screenshots/workbench-procurement/unified-calculator-unified-per-spec-costing-1440-light/unified-costs-1440-light.png)
- [390 手机成本/售价](D:/AI-Gateway-public-staging/.codex-tmp/cost-draft-unified-20261019/screenshots/workbench-procurement/unified-calculator-unified-per-spec-costing-390-light/unified-costs-390-light.png)
- [独立页面恢复副本](D:/AI-Gateway-public-staging/.codex-tmp/cost-draft-unified-20261019/screenshots/workbench-procurement/draft-recovery-closing-ano-14359-an-explicit-recovery-choice/independent-editor-recovery.png)
- [视频商品单入口](D:/AI-Gateway-public-staging/.codex-tmp/cost-draft-unified-20261019/screenshots/studio-workspace/product-offers-one-product-exact-specification-Offer-1440/grouped-video-1440.png)
- [精确 Offer 报价](D:/AI-Gateway-public-staging/.codex-tmp/cost-draft-unified-20261019/screenshots/studio-workspace/product-offers-one-product-exact-specification-Offer-390/exact-offer-quote-390.png)

供正式 Handoff 维护者采用的事实：统一实施及非付费本地验证完成，保持未提交；下一步为代码审查，尤其确认 JSON 回退边界及辅助试算参数仅本地的语义。没有候选构建或生产动作，不将此前生产部署事项重新列为待办。

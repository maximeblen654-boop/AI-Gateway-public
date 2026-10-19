# 第一轮独立审查：定向修复结果

2026-10-19。源码、模拟测试与浏览器 fixture 范围；没有提交、推送、候选构建、生产连接、部署或真实供应商调用。

**状态：`SOURCE_FIXES_UNCOMMITTED_NOT_DEPLOYED / P0_DEPLOYMENT_BLOCKED`。**

开发仓库 `D:/AI-Gateway-public-staging`，分支 `codex/media-paid-controls`，HEAD 仍为 `33c819064ef95666f6b512ebaed1e2d7a09e34d6`。这是基线，不是包含本次实现的新提交。原独立审查包及原 IMPLEMENTATION.md 保留。本次 38 个相关源码/测试文件集合的 SHA256 为 `cc2abdf495c93ef4d66a93b33e7e500a3cc09aa40504373e47217b28f25c67c7`；逐文件摘要与相对第一轮审查的 14 文件增量见 [source-files.json](source-files.json)。不把工作树摘要冒充 Git commit。

## 1. P0：已证实不兼容，继续阻断发布

旧运行基线 `8ad2eff39ff5bf6bfd07563041556f4a4c42d9a1` 的严格 Config reader 无法读取含 `draft.save_receipt` 的 Account 配置；新前端的顶层 `submission_id` 也会被旧 handler 拒绝。取消严格解码会使旧结构写回时丢字段，不能作为修复。一次 Account 解码失败还可能使整个媒体目录 List 失败，不能假定影响仅限编辑页。

本地探针从不可变旧 Git 对象与当前源码分别原样提取传递类型和实际 handler 请求类型，以已有 Go 标准库执行：旧类型 10 项、当前类型 11 项预期行为通过。其中特别验证了预期拒绝和宽松读取的预期丢字段，**不是 21 项“旧版已兼容”通过**。这不是应用镜像、SQL 或 HTTP 集成验收。实际探针工具链 Go 1.27.0；应用测试另用 go.mod 对应的 Go 1.27.2。

安全顺序与回退边界：

1. 先准备兼容 Core 的固定源码和不可变镜像：typed receipt、严格解码、原子 CAS、提交归属确认都必须保留，并验证所有实际写入口。旧 UI 与该 Core 的组合也须单独验收。
2. 后端兼容层先行；不能让旧 Core 与会写 receipt 的新实例共享数据混跑，也不能先发新 UI。
3. 再启用新 UI。UI 嵌在 Core 二进制，不能声称现有部署支持独立回退前端；须有“兼容 Core + 旧 UI”组合镜像或真正验证过的资产通道。
4. 首次 receipt 写入后禁止退回 8ad 整镜像。回退时保留兼容 Core 和最新业务数据；管理编辑优先受控只读。任何只读保护必须覆盖真实 mutation 接口，不能只隐藏按钮。
5. 正常保存一份新草稿会使上一份 receipt 失效，不得把旧 receipt 拷到新 draft 假冒确认；同样不能为让旧镜像解码而擦掉字段、恢复旧 Account 或整库。

**当前没有已构建、验收和固定摘要的兼容回退版本，不能解除 P0。** 本轮未擅自增加兼容运行协议或构建第二套系统。详细矩阵、拟议最小 backport、证据与仍缺的门禁见 [compatibility/ASSESSMENT.md](compatibility/ASSESSMENT.md)，可重复脚本及原始结果在同目录。

## 2. P1：未确认保存的人工安全重提

`useMediaWorkbench.ts` 新增 `canRetryUnconfirmedSave` / `retryUnconfirmedSave`，View 提供“重新核对并保存当前草稿”：

- 超时后自动 GET 仍不能确认时继续保留本地输入，不自动重发，也不把旧版本 GET 当成“原请求一定没发出”。
- 用户先点“核对服务器状态”；只有服务器版本、草稿 revision、基准内容和待确认保存身份相符时，才开放人工入口。发布、销售等未知操作不会获得草稿重提入口。
- 人工点击时再次 GET。若原请求已迟到写入，先核对其 receipt 并保留较新的输入，再按新基准保存；若其他页面更新，则保留输入并进入冲突，不发送 PUT。
- 仍是原基准时，只提交当前最新整份 Account 草稿，生成全新 `submission_id` 并携带原 CAS 版本。迟到原请求与新请求只能有一个写入成功；另一方 409，不会覆盖胜者。
- 保存期间的新输入不被旧确认覆盖；只确认实际发送版本。刷新后含 pending_submission 的恢复副本也能走此流程。重新核对失败或登录失效时不重提。

这里的重提是用户明确触发的草稿保存，不是生成重试，不涉及付费 POST、结算、商品发布或销售开关。

## 3. P1：跨 Offer 素材准入与准确报价

`studioProductOffers.ts` 的候选过滤与容量检查要求同一稳定商品范围、模型与 input_mode；保持分辨率、比例、时长、画质、数量及格式等已选规格。整批素材必须能落到一个合法 Offer，不能拼接多个 Offer 的各类别上限。

Panel 的文件类型、批量入队、上传结束和报价前采用一致的解析逻辑。未知 product_scope 保持既有单 Offer 行为，不按名称猜关联。成功上传后与报价前重新解析准确 Offer；不兼容/歧义时拒绝报价，服务端仍独立校验实际 Offer 和规格。

独立审查额外复现了“文生图拖入首张图被 text 目录提前过滤”的连续故障：现已先找目标编辑模式的同商品候选，合法后选中参考 Offer 再切 edit/入队，不调用会重置其他规格的 selectOffer。Offer 短暂未出现在当前模式列表时也不会误清 WebP。失败则保留原模式、格式及输入。

图片 1→2 张、视频参考图片 1→2 张、参考视频 1→2 份均有单元覆盖；真实 Vue fixture 浏览器验证图片及参考视频的 1→2、精确 `offer_id`、不同单价与确认页金额。没有点击“确认并生成”。

## 4. 文案与独立复核

- 原“切换步骤不会保存或发布”改为“停止输入或切换步骤会自动保存草稿，不会正式发布”。
- 待确认恢复副本明确说明“恢复后保留本地输入并暂停自动写入，请核对服务器后继续”，不承诺直接自动保存。
- 独立审查的拖图反例先 FAIL，修正后 PASS；恢复未知提交后以新 ID 保存最新输入的反例 PASS。最终独立反例 2/2，无新增实质问题；P0 保持阻断。

## 5. 实际验证

| 范围 | 结果 |
|---|---|
| 原相关 20 个前端文件的完整单元回归 | **378/378 PASS，0 failed / skipped**；包括 composable 80、View 48、Panel 85、商品 Offer helper 8，以及原计算器/规格/定价/接口等回归 |
| `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` | PASS |
| 9 个本轮前端源码/单元文件的 ESLint（没有 --fix） | PASS |
| Go 1.27.2 `go test ./internal/mediaworkbench -run TestSaveDraft -count=1 -json` | **10 个顶层测试 / 12 个子测试 PASS，0 failed / skipped**；新增真实 Service + 内存 Repository CAS 的先后到达竞争测试。原始输出在本轮工具执行记录，未伪造为磁盘原始日志 |
| 管理员 Playwright 全套 | 首轮 **38/39 PASS**，旧 sales timeout-rejected 在选择 Account 时遇页面重新导航后超时；失败 JSON/trace 原样保留，未归咎账号/服务器保存 |
| 冻结文件后的管理员定向复跑 | **8/8 PASS**，包括上述失败项、自动保存、离线、丢回执、人工重提及两种迟到顺序 |
| 精确 1440×900 / 390×844 重提入口截图补测 | **3/3 PASS**，入口出现前/确认后截图均保留 |
| Studio Playwright 最终版本 | **7/7 PASS**；原 1440/1366/390 规格切换三例及新增图片/视频素材报价 1440/390 四例 |
| 旧/新严格结构探针 | **21/21 预期行为 PASS**；旧版不兼容已证实，不等价于回退可用 |
| 独立审查反例 | 最终 **2/2 PASS**，保留先失败的诊断事实 |
| `git diff --check` | PASS；既有 CRLF→LF 提示不是失败 |

没有新提交，所以没有触发云端 CI/Security，也没有伪造新的候选 SHA 或 PASS。本轮不重复资金/1870 验收。

可复现命令（frontend 工作目录，使用现有依赖）：

```powershell
$testFiles = (Get-Content ../.codex-tmp/cost-draft-unified-20261019/frontend-tests.json -Raw | ConvertFrom-Json).testResults.name
node node_modules/vitest/vitest.mjs run $testFiles --reporter=json --outputFile=../.codex-tmp/cost-draft-review-fixes-20261019/frontend-tests.json
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
node node_modules/@playwright/test/cli.js test --config playwright.procurement.config.ts
node node_modules/@playwright/test/cli.js test --config playwright.studio.config.ts product-offers.spec.ts
```

最终运行采用独立 output 目录及 JSON reporter，避免覆盖上一轮证据。`.codex-tmp/cost-draft-review-fixes-20261019/` 内保留 `frontend-tests.json`、首次/最终管理员 JSON、`retry-evidence.json`、`studio-browser-final.json`、截图和首次失败 trace。管理员唯一初始失败项在冻结后的复跑通过；没有隐藏失败统计，未把最终复跑 8 项冒称整套 39 项的一次全绿运行。

全部浏览器均为真实 Vue 页面和模拟 HTTP/素材回执，不是原型，也不是完整真实 Core/Bridge/BFF 或生产联调。Go 用真实 Service 加内存仓库，未运行 SQL。采购成本和售价仅为合成 fixture 金额。

## 6. 本次具体文件增量

相对第一轮审查 38 文件指纹，只有以下 14 个源码/测试文件变化：

- `backend/internal/mediaworkbench/save_receipt_test.go`（新增迟到请求/CAS 竞争回归，未改后端运行代码）
- `frontend/src/composables/useMediaWorkbench.ts`
- `frontend/src/composables/__tests__/useMediaWorkbench.spec.ts`
- `frontend/src/views/admin/MediaWorkbenchView.vue`
- `frontend/src/views/admin/__tests__/MediaWorkbenchView.spec.ts`
- `frontend/src/components/admin/media/MediaProductEditor.vue`
- `frontend/src/components/video/StudioMediaPanel.vue`
- `frontend/src/components/video/studioProductOffers.ts`
- `frontend/src/components/video/__tests__/StudioMediaPanel.spec.ts`
- `frontend/src/components/video/__tests__/studioProductOffers.spec.ts`
- `frontend/tests/workbench-procurement/main.ts`
- `frontend/tests/workbench-procurement/draft-recovery.spec.ts`
- `frontend/tests/studio-workspace/main.ts`
- `frontend/tests/studio-workspace/product-offers.spec.ts`

原自动保存、统一计算器、规格聚合及其他未提交成果均保留。正式 Constraints/Handoff 原件未覆盖；Git index 未变化。

## 7. 待审核与事实增量

P1/P4 局部修复与相关本地回归已完成；**P0 未解除**：缺兼容 Core/旧 UI 组合的固定运行身份及完整回退验证。下一次获准推进时应先解决这一发布门禁，不能直接部署本工作树或回退 8ad。

原始审查 ZIP 未改写。本轮没有生产访问、价格/商品/资金/销售修改、真实生成、commit 或 push。磁盘开始记录 C 5.19 / D 22.76 GiB；收尾复核 C 5.16 / D 22.65 GiB（并行系统使用会变化），没有执行磁盘清理。可重用测试证据保留，探针一次性临时模块已清除。

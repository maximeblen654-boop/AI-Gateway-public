# 参考素材数量输入完成时提交 — 本地待审查

状态：SOURCE_READY_FOR_REVIEW / UNCOMMITTED / NOT_DEPLOYED。

基线与当前 HEAD 均为 `ac623cc3f6e6782f692dc9b7cbd266276858f62e`，分支 `codex/media-paid-controls`。本轮开始时业务工作区干净；本次未提交、推送或连接生产。VPS 的旧界面不参与本轮修复是否有效的判断。

## 原因与版本核实

`MediaReferenceEditor.vue` 原有数量框通过 `@input → setMax/setTotal` 立即发出 `update:modelValue`；清空时发出 `-1`。`MediaProductEditor.vue:43` 随即调用 `editPricing()`，重新枚举规格和价格。中间非法值会使此前可售规格不可枚举，下一字符修改时 `losesPrices()` 因存在已填售价而要求确认。确认取消后，原实现还会把输入框恢复为旧 props，打断连续输入。

本轮新增真实挂载组件的行为测试先在未修改实现上运行：12 项中 11 项失败、1 项通过，证实提前发出商品修改、提前确认及无效值进入草稿等问题。不是只检查内部 setter。

- **原本没有修复：** 管理员数量输入的逐字符提交。本轮前该文件与 `8ad2eff` 中的版本相同；不存在“已修复又丢失”的证据。
- **已修复且仍保留：** 客户跨 Offer 素材准入、上传后解析 Offer 和报价前同步准确 `offer_id`。`StudioMediaPanel.vue`、`studioProductOffers.ts` 与基线相同，本轮未改动。
- `MediaProductEditor.vue` 的 `losesPrices/editPricing` 价格保护没有删除或降低。本轮只改变数量输入进入该链路的时机和参考素材步骤的导航衔接。

## 最小实现

1. 数量框以组件内字符串缓冲清空、逐字和其他中间输入；`input` 不发出商品更新，不重算价格，也不触发原有草稿自动保存。
2. `change`、失焦或 Enter 使用同一个串行完成入口。有效整数才进入既有 `editPricing`；图片仍受原 16 张边界、视频仍受实际接入上限约束。无效值保留在编辑区并提示，不进入商品草稿。
3. 同一完成操作的 Enter/change/blur 串行去重；最终数值与原值相同时不发出更新。无价格损失不确认；真实损失仍交给原 `losesPrices()` 确认。取消则恢复原值，不发出商品更新。
4. 每次以最新 props 构造修改，未完成的输入不被无关父级更新覆盖。视频类别上限与合计上限分别缓冲；步骤提交时统一校验待编辑值。
5. 离开参考素材步骤前先完成待编辑数量；无效值或取消确认时不跳步。仅在该步骤对导航按钮阻止 pointerdown 的默认焦点转移，避免失焦产生的自动保存/恢复提示改变高度，导致鼠标点击落空。其他步骤保留原有默认行为，键盘 click 路径仍正常。
6. 最终合法商品更新仍走原有本地恢复、1.5 秒自动保存、CAS 与服务器回执确认；这些模块没有修改。

## 用户问题验收对应表

| 用户实际反馈 | 负责组件 | 验收场景 | 当前结果 |
| --- | --- | --- | --- |
| 固定 5/10/15 秒按钮 | MediaProductEditor / MediaTokensField | 无固定常用值按钮；已存 5/10/15 仍可见且可移除，范围/手动输入保留 | 浏览器通过，本轮未改时长逻辑 |
| 参考素材跨 Offer 选择 | StudioMediaPanel / studioProductOffers | 图片、视频从 1 份到 2 份，准确 Offer、价格、请求参数；无生成 POST | 7 项既有浏览器回归通过，相关组件测试通过 |
| 参考素材输入过早确认 | MediaReferenceEditor / MediaProductEditor | 清空、键入 1、键入 2；编辑期无确认、无商品更新、无保存；完成后应用 12 | 新增组件交互及 1440×900、390×844 浏览器通过 |
| 草稿修改丢失 | useMediaWorkbench / draftRecovery | 自动保存、超时人工重试、迟到原请求、断线恢复、并发 CAS | 模块未修改，既有单元回归通过；原浏览器证据仍保留，不冒称本轮重做全部恢复验收 |

## 测试与证据

- 最终相关前端单元/组件：**330 PASS，0 FAIL，0 SKIP**。含 14 项新增数量输入交互测试，以及计费维度、图片/视频模式分别定价、自动保存/CAS/恢复、跨 Offer 的既有覆盖。
- 浏览器：新增数量交互 **5 PASS**；既有素材/时长/旧 total=0 **3 PASS**；既有商品聚合与准确 Offer/报价 **7 PASS**。合计 15 个不同检查，0 FAIL / SKIP / flaky（最终报告）。
- 完整 `vue-tsc --noEmit`：PASS；8 个受影响前端文件 ESLint：PASS；Git 空白检查：PASS。
- 浏览器使用实际 Vue `AppLayout + AppSidebar + MediaWorkbenchView`，仅 HTTP/Axios 和上游数据为本地合成 fixture，所有非 loopback 请求阻断。**不是生产验收，也不是 Core/Bridge/BFF 全链路联调。** 本轮没有后端/合同修改，不重新构建三组件。
- 图片与视频跨 Offer 验证只到合成报价确认，不点击生成，不产生真实付费请求。
- 原始 JSON、日志、截图、失败 trace 位于本轮 D 盘审查目录的 `evidence/`，ZIP 中提供完整副本、命令和逐文件清单。

首轮失败没有删除或改写成通过：旧实现红灯测试 11 FAIL；第一版组件衔接有 3 FAIL，第二版有 1 FAIL（等待异步完成后断言，补齐等待）；浏览器初轮含一次超时、一次参考步骤失焦点击落空、一次旧隐藏返回按钮定位超时；定位后修复步骤按钮的真实交互并改用已存在的可见返回入口。素材/时长旧测试的“任何写入为零”断言不符合已验收自动保存机制，改为只允许草稿 PUT 且确认非法 31 从未进入保存请求，不放宽发布/销售/生成边界。最终原始结果另存，不覆盖失败记录。

## 修改文件

- `frontend/src/components/admin/media/MediaReferenceEditor.vue` — 本地数量缓冲、有效值完成提交和去重。
- `frontend/src/components/admin/media/MediaProductEditor.vue` — 离开参考步骤先提交；该步骤的鼠标焦点/点击顺序。
- `frontend/src/components/admin/media/__tests__/MediaReferenceInput.spec.ts` — 新增 14 项真实输入交互。
- `frontend/src/components/admin/media/__tests__/MediaWizard.spec.ts` — 数量完成操作的异步断言等待。
- `frontend/tests/workbench-procurement/main.ts` — 两个隔离数量情景的合成初始值。
- `frontend/tests/workbench-procurement/reference-input.spec.ts` — 新增 5 项真实 Vue 浏览器检查与截图。
- `frontend/tests/media-workbench/media-limits.spec.ts`、`wizard.spec.ts` — 明确完成输入后检查；自动保存存在时仍只允许合法草稿请求。
- 本报告。

## 兼容性与边界

只修改前端输入时机；API 字段、后端 JSON、商品/报价/Offer、资金、草稿 CAS、自动保存、保留期限均不变。已存的素材数量、时长和售价不会因打开页面而重写。未完成的输入缓冲不是服务器已保存草稿；只有应用最终有效数量后才沿用原有保存确认机制。

旧 Core 严格解码不能识别既有新版 `draft.save_receipt` 的兼容事实仍需在实际升级/旧版回退前确认；本轮没有新增或消除此事实，不以它扩展开发范围，也不声称可以直接降级。

本轮没有新 Commit、CI、候选或部署。等待 ChatGPT 独立审查。旧审查 ZIP 仅在其已完成审查且证据被完整接替时按准确路径轮换；本轮无法确认上一收尾 ZIP 的审查状态，保留原件，不删除旧证据。

# 管理员商品配置五步向导

基于 `d43999516debe506746098e8855da115f50479ad` 的非生产 UI 改造。入口仍为 `/admin/media`，复用现有 Account → 模型 → 商品流程。

## 页面职责

1. **可售规格**：选择分辨率、比例、视频时长。常用按钮仅是输入候选，不声明供应商能力。图片购买范围 1～10、视频 1；历史图片范围保持原值，只在显式应用系统范围并正常保存、校验、发布后更新。
2. **参考素材**：不支持、可选、必填，以及已确认的输入上限。图片只上传图片时，显式编辑后自动对齐合计上限；读取或切换步骤不会改写旧 `total_max=0`。前端立即提示超出 16、非整数和必填数量冲突。
3. **计费维度**：只显示实际配置且适用于商品类型的维度。未勾选的规格仍可选择，但共享单价。行数来自现有 `allowedSpecs` 和 `buildPricingRules`，包括组合限制；数量不参与价格矩阵。
4. **销售单价**：清楚区分缺价、显式免费及格式错误。维度变化保留可明确对应的原价格；移除覆盖或合并不同价格需确认，冲突价格留空。
5. **确认保存**：商品摘要、原价格表、客户报价预览、服务端校验及保存草稿。每部分可返回修改。预览不是正式报价，实际报价继续由服务端核验和冻结。

步骤切换仅改变本地视图。商品、模型、Account 或路由切换继续使用未保存确认。发布及销售位于模型管理页，沿用 Account 级作用范围和独立确认；保存不发布，发布不启售。

## 技术与兼容边界

`MediaTechnicalEditor.vue` 位于向导外的管理员技术入口，保留既有协议配置、尺寸映射、独立 `execution/edit_execution`、画质字段、组合限制和产品标识。没有新增能力数据库或定价引擎。没有可靠的独立供应商素材上限元数据，因此本版不提供可能被误解的“无限/自动最大值”选项；上限必须来自已确认接口，并受本站 16 份限制。

普通页面只展示接入状态及服务端诊断。Account 绑定和历史 PASS 不等于供应商实测；配置变更后仍需保存并检查。前端补充后端已有 `adapter_bindings` 的只读类型，不按模型名称推测协议，也不新增写入绑定 API。

| 接口 | 当前 Published Studio 图片链状态 |
|---|---|
| OpenAI Images 兼容 JSON | 可复用 `openai_images`、API-key Account、同步 `/v1/images/generations` 与 `/v1/images/edits`；按确切接口配置尺寸与数量能力 |
| Grok 原生 Account | 网关已有 Grok 图片处理器，但没有接入本 Published 适配器链；默认 `BUILDER_REFACTOR_REQUIRED`，强绑不匹配平台会得到 `ADAPTER_UNKNOWN` |
| Gemini / Vertex 原生批量 | 原生批量队列存在，但 Studio 未桥接；`IMAGE_PROVIDER_ASYNC_UNAVAILABLE`，不在本轮实现 |
| Midjourney | 旧异步回执入口不等于 Published 适配器；未知 binding 得到 `BUILDER_REFACTOR_REQUIRED`，异步流程得到 `TASK_FLOW_UNSUPPORTED` |

某品牌在第三方 Account 下提供兼容接口，仍须有该具体接口的合同依据；`openai_json` 声明不能用来伪装原生协议支持。依据：`backend/internal/mediaworkbench/adapter.go`、`validator.go`、`runtime.go`，以及 `backend/internal/service/studio_image_account.go`。本轮未访问真实供应商。

## 可重复验收

- `pnpm --dir frontend exec vitest run src/components/admin/media/__tests__ src/views/admin/__tests__/MediaWorkbenchView.spec.ts src/composables/__tests__/useMediaWorkbench.spec.ts src/api/admin/__tests__/mediaWorkbench.spec.ts`
- `pnpm --dir frontend run typecheck`、`pnpm --dir frontend run lint:check`。
- 在 frontend 目录执行 `pnpm exec playwright install chromium`，然后 `pnpm exec playwright test --config playwright.media.config.ts wizard.spec.ts`。
- 本机已有 Chrome 时可设置 `MEDIA_UI_BROWSER_CHANNEL=chrome`。测试使用临时浏览器会话，所有 API 由本地 Axios fixture 处理，非本机网络请求被阻断。
- 浏览器验收覆盖 1440/390、浅色/深色、1/3/6 行、禁止组合 5 行、缺价/免费、保价/合并确认、旧素材 0、16 上限、草稿重读、发布取消、不支持适配器。截图位于 `frontend/test-results/media-workbench/`，必须实际目视检查。
- `go test ./internal/mediaworkbench -count=1` 验证既有真实校验、发布、价格匹配、执行计划与适配诊断。浏览器 fixture 的 PASS 仅用于 UI 状态测试，不替代 Core 校验。
- 现有 CI 增加上述媒体定向测试与隔离向导浏览器步骤，并上传截图；沿用现有 Security Scan。

受影响的运行组件为 Core 内嵌前端资源。Bridge、BFF、数据库与原生账务代码未更改。构建产物和截图属于非生产候选，生产切换仍需另行批准。

# 前后端联调审查与实施验收清单

本文件是本次设计的阶段交接，不取代项目正式 Handoff。以下源码核对基于 `a14000c68c1f090d34c8fde0197d860d2d767215`。此轮只做源码连接核对与原型归档，未运行真实后端联调。

## 已观察到的原型局限

| 原型位置 | 实际行为 | 正式实现必须怎样处理 |
| --- | --- | --- |
| prototype.js 的 data-spec | 仅切换按钮样式，分辨率没有进入真实 Product 状态 | 接回 setCapability 和实际 capabilities.resolutions，返回步骤仍保持值 |
| data-ratio / state.ratios | 修改演示数组；价格摘要仍有固定“1:1、16:9 同价”文字 | 标签、保存、价格行与请求都从同一有效规格读取，不能硬编码摘要 |
| data-dimension | 显示说明弹窗，未重新生成真实价格组合 | 复用 allowedSpecs/buildPricingRules、组合限制和保价确认 |
| state.rows | 预置的示例行，不是从商品规则编译 | 不将这些 fixture 行或 row index 带入正式规则和成本存储键 |
| 第 2 步素材 | 图片参考素材视觉演示；视频合同未完整呈现 | 保留既有图片/视频/音频限制、total_max 旧语义及服务端校验 |
| 保存/发布/销售 | 预览对话框，无 API | 接现有 API、版本检查和确认，不改调用语义 |
| 成本抽屉 | 复用金额纯函数；页面内存，刷新重置 | 保留既有管理员/Account/商品/稳定规格键记忆与存储异常处理 |

这些是设计原型未实现部分，不是新发现的生产缺陷。不能将 prototype.js 直接搬成业务状态管理器。

## 当前真实合同和复用位置

所有路径均相对于仓库根目录。后续实施以这些现成模块为唯一连接入口，不再造一套规格、报价或映射算法。

| 管理员操作 | 既有前端 | 既有服务端 / 数据边界 | 改版验收要点 |
| --- | --- | --- | --- |
| 选择 Account / 模型 / 商品 | views/admin/MediaWorkbenchView.vue；composables/useMediaWorkbench.ts | mediaworkbench/validator.go::resolveAccountModel；Account canonical mapping | 保留真实 product_id 选择与账号上下文；同模型不同商品不串价，不显示内部 media UUID |
| 选择分辨率与比例 | components/admin/media/MediaProductEditor.vue::setCapability | Product.capabilities.resolutions / aspect_ratios；validator.go::Validate | 读取已有值、增删、返回步骤、保存重读完全对应 |
| 参考素材 | MediaReferenceEditor.vue | capabilities.references，validator.go::validCapabilities/specs | 上限 16 和适配器限制；0 不是无限；文生图/编辑独立 execution |
| 哪些规格影响售价 | pricingMatrix.ts::allowedSpecs / buildPricingRules / dimensionsFor | validator.go::Matches / Validate | 计算真正有效组合；保留可用价格，冲突/丢失先确认；数量不进入矩阵维度 |
| 填写单价 | MediaProductEditor.vue；pricing_rules | validator.go::validPrice；服务端冻结报价 | 空白是未配置，明确 0 是免费；唯一正式售价输入不变 |
| 保存草稿 | api/admin/mediaWorkbench.ts::draftInput / saveDraft；useMediaWorkbench.ts::saveDraft | handler/admin/media_workbench_handler.go；mediaworkbench/media.go::SaveDraft | 白名单载荷、expected_record_version、全部商品身份与明确移除指令；成本数据不进入载荷 |
| 发布和销售 | useMediaWorkbench.ts::publish / sales；MediaDialog.vue | media.go::Publish；API publish 与 sales 分离 | Account 级范围，expected_draft_revision，二次确认；发布不自动启售 |
| 参数预览 → 执行 | 服务端返回 validation.previews，不由新页面猜尺寸 | validator.go::Validate → adapter.go::compilePlan；runtime.go::CompilePublishedImagePlanForCount → compilePlan | 同一规格编译器；客户有效分辨率和比例不能丢失或变成 auto |
| 视频执行 | 保留现有商品/API 合同 | video_runtime.go::CompilePublishedVideoPlan | 单视频、已有映射/任务/结算保持；不新增视频协议 |
| 成本估算 | MediaCostCalculator.vue；costCalculator.ts；decimalText.ts | 不进入服务端业务合同 | 使用 storageKey / consumptionKey，不能使用行号；视频按整条，当前售价只读引用 |

上述后端路径前缀为 `backend/internal/`，前端路径前缀为 `frontend/src/`。

## 图片比例与尺寸：必须审查到最终请求

当前代码实证：

1. `adapter.go::compilePlan` 对 Gemini 原有合同使用 `image_size` / `aspect_ratio`，Grok 使用 `resolution` / `aspect_ratio`；不是前端根据模型名决定。
2. 其他图片路径先调用 `image_dimensions.go::ImageDimensions`，有效历史 `size_mappings` 优先，明确像素规格沿现有比例安全校验生成 `size`。
3. 没有 size 映射时，现有 API-key 路径可保留 `resolution` / `aspect_ratio`；`openai_images_oauth` 不走该 fallback。具体 Account 合同继续由后端解析，不能一律宣称任意 K/比例可用。
4. `validator.go` 的预览与 `runtime.go::CompilePublishedImagePlanForCount` 复用 `compilePlan`。新 UI 应消费同一校验结果，不能新增浏览器 K→像素表。

正式集成后使用已有合成 Account 和模拟上游验证：

- 按当前接口已支持规格选择 1K/2K、1:1/16:9，再切回步骤；保存请求、服务端重读、published offer、冻结 quote 与捕获的最终请求逐项一致。
- 3 个分辨率 × 2 个比例：只按分辨率定价 3 行、两维 6 行、统一价 1 行；加入一条禁止组合后，行数与覆盖范围按有效组合计算，不硬做笛卡尔积。
- 明确像素值与比例不匹配应继续拒绝；合法历史 size_mappings 保持；不使用 auto 或猜测通用 K 像素替代选中规格。
- 图生图带参考图重复上述规格检查；图片购买数量与输入参考图数量、上游单请求上限互相独立。
- 5 张、上限 2 → 2+2+1；合法单图接口 → 5 个单图单元。沿用现有模拟执行证据，只补改版影响部分。

## 必须补齐的真实隔离验收（本轮全部 NOT_RUN）

| 关卡 | 合格证据 |
| --- | --- |
| 管理员编辑并保存 | 真实浏览器 → Core API → 隔离 PostgreSQL → 重新读取；不得用 Axios/mock 拦截伪造保存 |
| 发布前诊断 | 缺价/无效规格准确定位商品和字段；真实未支持能力仍阻止；不删校验换绿灯 |
| 发布与销售分离 | 仅隔离发布，Account 多商品范围和二次确认；保存/导航不触发发布或启售 |
| 报价与文生图/编辑 | Core/Bridge/BFF + 模拟上游，实际冻结规格、数量、账户、模型与请求一致 |
| 结果与资金 | 原片摘要/下载、partial、刷新恢复，生成次数与原生结算次数不增加；不得重发未知执行 |
| 视频共用 UI | 普通单视频及既有特殊路径按改动影响补验，商品规格与整条单价不串图片状态 |
| 多商品与草稿管理 | 配置商品+空白草稿，返回/切换不新增；显式移除保护；不会因新布局丢商品 |
| 成本与售价隔离 | 未保存售价保留，身份/Account/商品/规格隔离；存储失败降级；所有业务载荷不含成本参数 |
| 桌面/手机/主题 | 1440px 与390px、浅深色、键盘、抽屉焦点、未保存离开保护；真实 API 下检查而非静态截图 |

复用已有 `tools/native-media-e2e/` 与定向前后端测试，不新建测试平台，不做付费调用。最终产物阶段页面须来自 Core，不能用 Vite 或旧静态原型替代成品。

## 预计修改范围与审核决定

设计确认后预计修改现有 MediaWorkbenchView、MediaProductEditor、MediaCostCalculator 的展示/交互及 media-workbench.css、相关定向测试。保留 composable/API/金额函数/后端合同；是否确需修改这些模块，应以具体集成缺口为依据，不能为了外观重写。

请审核者分别回答：视觉方向是否可继续；计划是否遗漏真实合同；哪些是已实证的问题、哪些只是待实施。设计通过最多进入正式组件实现，不等于候选、部署、发布或启售批准。

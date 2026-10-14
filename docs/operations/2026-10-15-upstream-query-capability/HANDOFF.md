# Image2Pro 图片异常任务查询能力核查

状态：**UPSTREAM_PER_REQUEST_QUERY_UNAVAILABLE**。

2026-10-15 核查结论：在已公开文档和本轮已有授权范围内，未找到可靠的图片单笔最终状态及退款查询合同。不是断言供应商内部没有记录；其网页控制台确有账单功能，但不能把私有登录态接口当作已授权、稳定的服务端 API。按本轮停止条件，不新增自动监测运行代码，不构建、不部署。

## 证据和范围

- [官方 API 文档](https://image2pro.top/api-docs)：本轮仅匿名 GET 公开页面，HTTP 200。文档主体由页面内 JS 生成，核对了实际定义的图片、余额、幂等、错误及视频章节，未只检查初始 DOM。
- 本地公开页面存档：`D:/AI-Gateway/output/image2pro-public-api-docs-20261015.html`；SHA256 `568b70b8054fd5560dacd55f196d5d85089f8576a5879803529922880c9856f4`。不将整个供应商网页复制进仓库。
- 源码审查基准：`7d5486e260dc5170402ccfb579ed8fdd9a2e6cd0`，运行实现为已验收 `d893690abe47f891aacde8876837ccc0c8b653ac`；没有新运行代码混入候选。
- [既有真实任务诊断及候选交接](../2026-10-15-image-task-experience/HANDOFF.md)。本轮复用其限定只读证据，没有重新连接生产、调用恢复接口或扫描历史订单。
- 用户本轮截图显示 API Base URL 为 `https://api.image2pro.top/v1`、当时可用积分 28。这只证明截图展示内容；现有本地脱敏诊断文件未记录可复核的上游主机名，**本轮未重新核实生产 Account 的 Base URL**，不能据截图认定配置正确或错误。网站域名与 API 域名不能混为一谈。

## 官方公开接口能证明什么

| 接口/机制 | 已核实能力 | 不能据此证明 |
|---|---|---|
| GET `/v1/balance` | API Key Bearer 鉴权；返回账户可用积分、欠款和 CREDITS 单位 | 哪笔生成预扣、是否单笔退款、退款金额或完成时间 |
| POST `/v1/images/generations`、`/v1/images/edits` | 同步图片返回 URL/Base64；文档描述按请求数量预扣、按成功返回张数结算，全失败退回或登记补退 | 响应丢失后的最终结果；某笔退款已完成 |
| 图片错误响应 | 文档有 HTTP 分类和 error.message/type；502 对应没有得到图片，并可能退款或登记补退 | 仅凭 502 判定退款已经完成；将通用规则当作这笔真实订单的最终证据 |
| 图片幂等 | client_request_id/clientRequestId 或 Idempotency-Key；约两小时保留；重复通常返回 409 | 只读查询、完整结果重放、两小时后安全重发 |
| GET `/v1/videos/{id}` | 视频具有正式任务查询合同 | 图片也具有同样的任务查询能力 |

文档明确列出的 GET 路径为 `/v1/models`、`/v1/balance`、`/v1/videos/{id}`。未找到图片按 client_request_id、上游 request ID 或其他唯一关联键查询状态/账单/退款的公开接口。

总余额可能被并发消费、充值、退回相互抵消；保持 28、上升或下降均不能独立证明某笔退款。未实际调用真实余额接口，因为这次不能增加单笔可判定性。

### 控制台记录不等于可直接接入的 API

公开页面 JS 引用了 `/api-console/bootstrap`、`/api-console/logs`。该页面通过登录 token 发起请求，账单渲染含 keyId、taskId、status、charge、balance、refunded、refundIssue 等字段，有些退款展示还依赖文本解析。

这说明后台可能有进一步记录，但目前缺少正式服务端调用授权、稳定数据合同及 client_request_id 到图片记录的唯一对应保证。本轮没有调用这些接口、读取登录 token、复用用户私人会话或写爬虫。

最低缺口是：供应商正式支持的只读单笔查询入口；API Key/明确只读身份鉴权；可靠关联请求与凭据身份的唯一键；最终生成状态及结果；预扣、最终收费、退款金额和 pending/completed 状态；保留时间、限流及延迟语义。路径名字不应由本站猜测。

## Sub2API 真正可复用的能力

以下路径均基于上述审查基准，可直接在仓库定位：

| 实现 | 能力与边界 |
|---|---|
| `backend/internal/handler/image_task_handler.go::executeWithGateway/run/Get`，`service/image_task.go` | 原生异步包装复用 Images/GrokImages，把本次响应或错误存为本站任务；GET 校验 User/APIKey 归属后读取本地任务。不会因为原调用 502 就凭空取得供应商最终结果。 |
| `service/studio_image_execution.go::dispatchExecution/recoverExecution` | 原任务和单元持久 claim、请求哈希、冻结绑定；恢复读取已保存回执/响应，必要时获取原响应中的图片 URL，验证和保存原片，处理完整或 partial 交付。没有 Image2Pro 图片单笔查询实现。 |
| `service/studio_native_response.go::prepareStudioNativeRequest` | 禁止 HTTP transport 重放已由 Studio claim 持有的 POST，移除转发的幂等请求头；不能把本地 unit ID 冒充供应商已识别的查询 ID。 |
| `service/studio_image_runtime.go::Recover/settle` | 复用原任务、已有结果及结算；恢复不是纯只读操作，可能保存结果或执行应有的首次结算。不能为只读生产诊断随意调用。 |
| `service/studio_image_billing.go::SettleQuotedImage` → `repository/usage_billing_repo.go::Apply` | 原生请求键与指纹去重、余额/额度/usage 同一数据库事务；重复恢复不能重复应用同一结算。这里管理本站客户资金，不管理供应商积分退款。 |
| `service/upstream_billing_probe.go` | 已有 `/v1/sub2api/billing` 成本/费率探测，不是供应商图片单笔退款查询，不能仅凭名字当作可复用对账接口。 |

已有明确拒绝分类为 400/401/403/404/422/429；502、超时、断线不能仅按传输错误确认供应商未执行。不是所有非 2xx 都已提供细分的业务失败结论。

`studioNativeResult` 目前保留状态和可获得的 request ID，但错误分支不保存原始响应正文；这解释了旧任务缺乏进一步错误详情的证据限制。当前审查不把诊断信息缺口伪装成单笔查询能力，也不为此另造监控系统。原始错误正文已缺失，后加日志不能追溯恢复。

## 自动确认范围

现有链路可靠区分四类本站事实，供应商单笔退款仍没有可靠自动确认路径：

1. 成功/partial：有实际响应和已保存原片，按交付事实处理本站一次结算。
2. 明确拒绝：按已有可判定错误分类结束对应单元；不把这一结论扩展为供应商退款已完成。
3. 本地可恢复：已有响应/URL/成品，允许继续原片保存及幂等结算，不再生成。
4. 不确定：502、断线、超时且没有足够结果/任务身份，保留原任务和明确反馈；不无限展示“正常生成”，不自动重发。

无法自动确认：供应商已完成但响应丢失、真实 502 的最终内部原因、预扣是否发生、单笔退款是否完成/延迟、无法唯一关联的后台记录。这些不能由余额推断。

既有真实 0.075 CNY 任务的诊断仍是：本站发起调用并收到上游 502，没有得到图片或上游任务编号；本站按精确请求键查到 usage/dedup 均 0。用户观察到上游积分不变。**这些事实不等于供应商单笔最终状态和退款已被证实。**本轮没有删除或修改原任务。

## 交付与停止

- 运行代码变更：0；新增测试、监测轮询、数据库、账本、供应商请求：0。
- 本轮仅完成公开文档/现有源码审查和此证据交接。文档检查不冒充模拟测试 PASS。
- 因没有运行代码修改，不重复执行已有隔离验收、CI 或镜像构建。d893 的原有 PASS、镜像、manifest 和候选来源全部保留，见前述候选交接；它仍为 CANDIDATE_READY_NOT_DEPLOYED。
- 正式 `D:/AI-Gateway/AI-Gateway-Handoff.md` 与 Constraints 保持原文；本文件是本次能力核查执行交接。
- 无生产连接/写入、部署、开关变化、真实供应商生成、付费测试、退款或补扣。
- 按用户明确停止条件，结束自动监测扩展。只有获得可靠、正式支持且已授权的图片单笔查询合同后，才能决定是否做最小连接；不要求用户逐笔截图，不使用私有后台爬虫替代。

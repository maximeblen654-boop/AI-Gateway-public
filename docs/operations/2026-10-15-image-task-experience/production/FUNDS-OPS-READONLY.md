# 指定异常任务的客户资金与原生运维只读核查

2026-10-15 北京时间约07:32–07:44，在切换前运行1ab3838a上完成。仅限定任务、资金键、告警时窗及当前15分钟聚合；未调用任务恢复GET、供应商生成或修改订单/资金/监控配置。

## 客户资金

任务 `img_246553331bf3e4639ab4adbe94fcccc2`；原请求 `bdfccad4-adb0-4c1c-a67d-f89c19fc9935`；用户2、Key3、Group31、Account77；冻结报价0.075 CNY。

- **此任务通过本站原生链路实际扣款0 CNY**。不是仅凭usage=0：实际版本的Studio生成handler只检查额度并取得并发槽，直接调用ForwardImages；不调用普通handler的余额预留或额外计费。BFF只传递原生回执，无第二次扣款。唯一资金路径为有效成品保存后的 `SettleQuotedImage → UsageBillingRepository.Apply`。
- 精确原生请求键为SHA256(`studio-image:`+taskID)，连同原requestID、taskID核查，usage、dedup及dedup_archive均0。Apply先在同一事务claim去重键，再执行余额/额度/usage，整体commit或rollback；不能正常出现本任务余额扣款已提交却没有这条去重记录。
- 当前receipt仍unknown/pending，单元没有结果字节、上游ID或result hash。未到达结果验证后的结算步骤。
- **没有这条图片路径的报价预扣步骤**；“冻结报价”冻结规格/售价和执行身份，不冻结客户余额。当前用户2数据库frozen_balance=0，Redis精确在途余额zset/hash均不存在，指定请求键没有占用；用户2视频hold记录0。无需执行释放或退款。
- 数据库当前prepared transaction=0、超过一分钟的其他活动事务=0。pending回执不是一笔尚未commit的扣款事务。
- 现有恢复读取原单元结果；当前unknown无数据，不会触发扣款或重发生成。若以后合法取得有效原片，既有合同允许按原冻结价首次结算一次；不能承诺永久不会收费。相同原生请求键防重复结算。
- 没有当时的独立完整余额快照，不据当前余额倒推出整个账户的历史余额变化；也不把本站0扣款当作供应商积分未预扣或已退款的证明。

证据：[funds-summary.json](funds-summary.json)。当前余额原值未公开，保留与任务结论直接相关的0占用结果。

原任务冻结Base URL主机为 `api.image2pro.top`，与用户截图一致。此次只读补证排除了网站/API域名混用，不意味着查明供应商内部502原因。

## 运维告警

现场事件14/15均在北京时间04:52:50触发，规则实际均为5分钟、overall范围，filters及dimensions为空。事件description也写明5m；没有把用户截图描述中的15分钟当成数据库规则。

评估器将结束时间截断到整分钟，所以本次对应 **04:47:00≤时间<04:52:00**。

|范围|成功|错误|纳入SLA的错误|解释|
|---|---:|---:|---:|---|
|告警实际5分钟|0|1|1|同一笔图片任务，错误率1/1=100%，成功率0/1=0%|
|补核15分钟04:37–04:52|0|1|1|没有额外失败来源|
|检查时最近15分钟|0|0|0|没有新样本，不能声称当前成功率0%或100%|

唯一错误的request_id与指定任务一致；外层路径`/v1/studio/images/tasks`、HTTP409、internal/platform分类，upstream_status_code为空。既有定向日志确认内层ForwardImages收到502。因此告警捕获的是该次失败，但错误表不能完整归因到供应商502；不能将platform标签直接解读为整个平台崩溃。

统计成功来源为usage_logs，错误来源为ops_error_logs，排除count_tokens，SLA分母再排除business-limited；它不是网站所有HTTP访问量，普通页面加载/任务查询200不等于一条生成成功样本。

代码对SLA样本数≤0返回不可计算，不会凭零样本新建这些百分比告警；但目前没有大于1的最低样本门槛。一笔失败可在重叠窗口多次评估后满足持续时间，持续5分钟不意味着连续多笔失败。

**旧告警仍为firing，不证明当前持续异常**。`evaluateOnce`在无样本时resetRuleState并continue，跳过active event解除逻辑。最近07:42:57原生评估心跳成功、33ms、无last_error，8规则中3项可计算，created/resolved均0。还有一条10月9日的旧firing记录，本轮未扩查其历史。

最小改进方向（本轮不实现）：在现有告警展示中附样本数、窗口和最近有效样本时间，对无样本标明“当前无数据，保留历史事件”；不要把没有数据自动当作服务恢复。是否增加最小样本门槛由用户另行决定。本轮没有改阈值、关闭告警或新增监控。

证据：[ops-summary.json](ops-summary.json)、[heartbeat.json](heartbeat.json)。

## 源码依据

本轮核对实际生产1ab3838a与目标d893690a相关原生资金路径未改变：

- `backend/internal/handler/studio_images.go` 的 StudioImageTask：额度与并发准入，调用既有执行运行时。
- `backend/internal/service/studio_image_runtime.go` 与 `studio_image_billing.go`：成品验证/保存后触发唯一原生结算。
- `backend/internal/repository/usage_billing_repo.go`：Apply 内去重 claim、余额/额度与 usage 的事务提交；与普通异步任务的 hold/capture/release 路径区分。
- `backend/internal/service/ops_alert_evaluator_service.go`：无样本时 resetRuleState 后 continue，不把零样本当成功率零，也不解除既有 active event。
- `backend/internal/service/studio_paid_control.go`：进程 epoch 改变会使旧开启授权失效；本轮部署后恢复图片实际开启已取得用户单独明确同意，必须先通过完整非付费预检。

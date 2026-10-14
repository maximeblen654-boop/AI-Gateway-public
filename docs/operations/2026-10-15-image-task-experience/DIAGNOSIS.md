# 真实图片任务只读诊断（2026-10-15）

## 已确认

生产运行源码为 `1ab3838a0dc40a32973ae06cc440b210f0a9d842`。本轮仅 SSH 读取精确任务文件、限定时间日志及 `BEGIN READ ONLY` 查询；未调用生产恢复 API（该 GET 可能持久化/结算），未发送供应商请求，未改变开关。

- Account #77，模型 `gpt-image-2`；用户 #2 / 原生 Key 引用 #3 / Group #31。
- 任务 `img_246553331bf3e4639ab4adbe94fcccc2`，04:47:17.309 北京时间创建。冻结 4K / 16:9 / 3 张，单张 0.025，总价 0.075 CNY。
- 冻结计划为一个原生多图执行单元，`output_count=3`。保存的请求字段为 `model=gpt-image-2,n=3,resolution=4K,aspect_ratio=16:9`；提示词、私有 URL、quote token 和凭据未导出。
- 04:47:22.424 Core 原生 ForwardImages 日志确认路由至 `/v1/images/generations`、apikey Account；04:47:47.458 原生 `account_upstream_error` 记录 Account #77、上游 HTTP 502。
- Core 提交入口 `/v1/studio/images/tasks` 在 04:47:47.463 返回 HTTP 409，耗时 25,348 ms。
- v3 回执为 `unknown/pending`，expected=3、pending=3，没有 result hash；唯一执行单元的持久结果为 `state=unknown`、空 upstream_id、0 响应字节。没有本地最终结果文件。
- 按原生结算请求键 SHA256(`studio-image:` + task_id) 精确查询：`usage_logs=0`、`usage_billing_dedup=0`。这证明本站未找到该任务的原生结算，不证明供应商未计费。
- 04:47:50.143 至 04:54:16.717，共 123 次这个原任务 GET 到达 Core并返回 HTTP 200；BFF journal 同时仍为 unknown/pending、0 成品。包含自动轮询，缺少单次用户点击关联 HAR，不能将全部 GET 解释为手动点击。

回执 SHA-256：`6ec8c567030fcc504978a734114a26504e55fe44b3840a62d6ef652e892e6d46`。
执行单元结果文件 SHA-256：`b50460361f52464ffa08433145cfc38f15e6a8918e51f29cb2226214fcd439`。
脱敏本地诊断证据：`D:/AI-Gateway/output/image-task-20261015/`。完整任务文件和上游凭据未复制到仓库。

## 用户补充观察

用户在本轮反馈：上游积分没有发生变化。此为用户侧余额观察，未取得供应商交易明细；与本站无结算记录并列保留，不能据此断言供应商一定未执行或排除延迟记账。

## 原因与边界

`openai_images.go` 在收到上游错误响应后记录 502；`studio_native_response.go` 将其转为执行错误。`studio_image_execution.go` 不把 5xx 当成“肯定未执行”，因此保存 unknown，禁止重放原生成 POST。原 handler/BFF 将这个非最终结果包装成通用 409；后续 GET 正常返回 unknown，并没有新成品。

现有 `recoverExecution` 只能重读原执行结果、保存可取得的原片并原生结算。此单元没有返回原生任务 ID 或结果数据，读取同一 unknown 文件无法获知供应商的最终执行/收费状态。**供应商是否接受并最终执行、是否计费，仍为 UNKNOWN。** HTTP 502 不等于供应商未生成；不能通过再次付费生成验证。若需要继续核对，缺少的是供应商侧这次请求的最终记录或可核对回执，不是另一次生成授权。本轮不补扣、不退款、不补建订单、不修改旧回执。

## 补充精确运维记录检查

用户补充询问能否确认未生成后删除任务。本轮再次只读查询原 request_id `bdfccad4-adb0-4c1c-a67d-f89c19fc9935`，以及 Account77 同30秒窗口的 `ops_error_logs`。仅有一条外层409记录：`error_phase=internal,error_type=api_error,error_message=image_binding_unavailable`；`upstream_status_code=null`，上游错误说明/详情均0字节。原生 ForwardImages 使用的独立 Gin capture context 内诊断没有在这个外层记录中保留，因此这份现存记录无法解释502的供应商内部原因。证据 `ops-error.json` 只输出允许字段与错误关键词，未导出原始响应体。

删除指令以“查明没有扣费、没有生成”为条件；目前条件未成立，未删除或改写真实任务。用户观察的上游积分不变不能替代供应商最终执行回执。

## 页面锁定与无反馈的独立缺陷

`StudioMediaPanel.vue` 原先同时使用：

1. `canStartNew` 排除 unknown/processing 等未完成状态；
2. `changeMode` 对同一 image 类型的 text/edit 切换直接返回；
3. 存在 active 时隐藏整个 composer，且生成 HTTP 共用全页 busy；
4. 生成响应无条件 `accepted()` 并切回任务；
5. 查询只有禁用按钮，没有 loading、查询时间和“无变化”反馈；每 3 秒自动刷新可能擦除错误。

所以视频能进入而两种图片都锁住。修复只调整既有 Vue 状态与样式，原任务、报价、执行和结算保持不变。

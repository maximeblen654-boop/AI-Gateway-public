# 媒体原片保留机制与空白草稿恢复

2026-10-19（Asia/Shanghai）。状态：`UNCOMMITTED / NOT_DEPLOYED / AWAITING_INDEPENDENT_REVIEW`。第三轮审查后的历史期限修复与风险阶段分类见 `HISTORY_DEADLINE_FIX.md`。

业务仓库 `D:/AI-Gateway-public-staging`，分支 `codex/media-paid-controls`，Git HEAD / 完整 Diff 基线仍为 `33c819064ef95666f6b512ebaed1e2d7a09e34d6`。本轮没有创建运行源码提交或候选镜像，不能把 HEAD 当成包含本轮实现的新 SHA。

上一轮审查通过的保存人工重提、CAS/保存归属确认、跨 Offer 素材与准确报价、提示文案继续保留。本轮只增加原片期限与恢复保护，并修复补测暴露的空白草稿待移除标记缺口；没有重新设计计算器或 Plan B。

## 原片的固定期限

- 新图片：Core 首份完整、有效原片成功持久化后固定 72 小时。复合执行以首份完整成品的持久化时间固定该原任务期限，后续单元或聚合不重新起算。
- 新视频：BFF 完整解码、哈希与原子落盘成功后固定 48 小时；经受保护的 capture 通道把同一绝对时间提交给 Core。跨层修复复用原 `persisted_at/expires_at`。
- 新字段 `result_retention = {persisted_at, expires_at, expired, policy}` 与报价的 `expires_at` 分离；时间为服务端 UTC RFC3339，未知时明确 null。
- 图片 receipt/result、视频 state/result/capture 与 Bridge 透传同一合同。客户端详情和历史卡显示具体截止及到期状态；到期移除预览、播放、下载和本地转换入口，保留任务结果数及原账务状态。
- 原片下载在鉴权和期限校验之后才能返回字节或 ETag/304。已知到期以 410 和安全错误码返回，客户端不将其称为连接失败或生成失败。图片私有缓存不能越过原片期限；视频使用 private/no-store。

## 各存储层与恢复

Core 图片确定的原片副本为 `result`、`upstream`、`materialized`（task/unit）及 `unit-response.Data`。它们受同一 task 的独立严格期限 sidecar 保护。清理前冻结必要结果哈希、计数与单元身份，清理后仍可完成原订单幂等结算；真正 unknown/pending 保留证据，不能重新发送生成 POST。

Core 视频未保存视频原片字节，`video-result-*` 是财务结果哈希凭证，不能当媒体文件删除。Core Original 在回源前后检查固定期限，避免 BFF 删除后再次回源续期。BFF 到期只删 original bytes，保留最小身份/期限/hash tombstone。

图片 BFF 的稳定元数据也不随原片删除。历史展示 journal 即使随后按旧规则安全清理，也不能抹掉防续期的最小期限证明。有效视频文件意外缺失时，仅允许按既有 MIME/大小/hash、解码及原期限原子恢复同一原片；已到期或内容冲突不能恢复。已持久化成功的 proof 在后续供应商状态变化时仍用于原幂等 capture，不能因文件缺失改判 release。

新任务另有永久策略标记；新 sidecar 丢失或损坏不能降为历史七天/无限期，必须拒绝相关读取/恢复。图片 BFF journal 的已提交期限也会限制新 PNG，不能因单份 metadata 丢失而误用旧 PNG 七天规则。

经调用链核查，Studio 原生 forwarder 没有进入独立 API `ImageReceiptRequested` 分支或 ImageTaskService/S3 Rewrite 存储链。清理不扫描普通 API 的 receipt/Redis/S3，详见 `evidence/core/native-copy-callgraph.txt`；这是当前源码静态证据，不是生产盘点。

## 自动清理与观察

- Core：启动后本地维护，每分钟最多 64 个 task，游标轮转；120 个混合 task 的 18 批测试证明未过期和 unknown 不会饿死后续过期任务。只访问受控 Studio 根目录，不做供应商网络请求。
- BFF：沿用启动及每 6 小时的维护，图片与视频分别执行；视频每轮有有限扫描与轮转游标。服务关闭时清除定时器。
- 记录扫描、到期、删除、失败、重试及实际释放字节；失败不会开放到期下载，后续维护重试。视频/图片底层删除成功后即计真实字节，后续 fsync 失败不能把已释放空间漏报。
- Core 剥离 unit-response.Data 时按实际 JSON 文件前后大小统计，不能把内存字节数当成磁盘释放量。该私有双重 base64 envelope 的 reader 单独允许 64 MiB，其他 reader 仍为 40 MiB；原请求/原片上限未放宽。
- 到期即拒绝服务端下载；物理删除按下一轮维护执行，文件系统错误可能延迟。不会虚报所有文件在精确到期秒已经物理消失。

## 历史兼容

- 现有图片以已保存的具体 deadline 为准。旧 PNG 没有元数据时按原文件时间固定原七天承诺，不提前缩短、不用读取时间重新续期。
- Core 只有在真正旧任务、完整结果 hash/解码可信时采用旧七天；未决/未知旧记录不猜时间、不强删。
- 旧视频 v1/v2、旧 slot/旧响应未提供期限及原任务没有新策略标记时保持 `legacy_unknown`，不直接按 48 小时批量删除。兼容迁移方案见 `LEGACY_VIDEO_MIGRATION.md`。
- `draft.save_receipt` 旧 Core 严格解码不兼容的事实没有改变。按用户第三轮审查决定，当前未执行旧版本回退的开发阶段只记录兼容性，不自动升级为 P0 开发阻断，也不开发额外兼容层。旧 Core 不执行 TTL、拒绝新的 capture 保留字段；实际规划升级/回退时需核对配对组件，不以删用户草稿或覆盖业务数据求兼容。详见 `COMPATIBILITY.md`。

## 空白草稿关闭页面补测

补测先复现：原 `removedProducts` 只在内存，本地恢复副本不包含移除意图，关闭页面后会丢失待移除操作。

最小修复为现有本地恢复格式新增向后兼容的可选 `removed_product` 标记，按真实 owner/account/product/model 身份保存；最后一份空白草稿也即时保护。显式恢复仍核对服务器版本、当前移除资格和冲突，不复活被移除商品、不覆盖其他标签页的较新副本。没有增加服务端保存合同或修改已审查 CAS/人工重提逻辑。

单元测试由 6 个红例复现后修复，相关 107 项通过；浏览器实际关闭页面并在新页面恢复，1440×900 与 390×844 均通过。两例在零服务器 PUT 的情况下恢复准确待移除 ID，服务器原稿保持不变。

## 测试与证据边界

精确命令、原始输出、通过/失败/跳过见审查包 `TEST_RESULTS.md` 和 `evidence/`。前端浏览器使用实际 Vue 组件与隔离 HTTP fixture；Core 使用实际 service/handler/Bridge 与合成仓库/上游，不冒充真实生产或付费 E2E。

独立审查发现并修正了：缺失有效视频文件不能恢复、删除后 fsync 失败统计错误、无期限旧视频误套新策略、已落盘 proof 被后续 failed 状态改为 release、新 sidecar 丢失误转 legacy，以及已知 410 的错误分类。原反例与修后证据保留于独立审查报告。

本轮未连接生产、修改商品/价格/mapping/资金/销售开关，未提交、推送、部署或调用真实供应商。新包包含上轮审查包的全部原始成员，验证证据完整接替后仅按准确路径轮换上一份已完成审查的 ZIP；不删除源码、测试证据或报告。

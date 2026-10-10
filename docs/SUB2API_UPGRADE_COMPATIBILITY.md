# Sub2API 官方升级兼容流程

本文件记录 AI-Gateway `sub2api-main` 的 Sub2API 官方同步边界和可重复检查顺序。它只适用于源码、隔离测试和非生产候选；生产切换、生产迁移、真实供应商请求和付费生成仍需要单独批准。

## 本轮基线

- 官方目标：`v0.2.15`
- 官方 tag SHA：`f2669c8cf62555cd92389b3f55920e9e6e7c6ff2`
- 官方共同祖先：`86f93c28ee34cc74b629dafb748bd5ac5ca8c5ea`
- AI-Gateway 原开发基线：`c68752f5d62e4575185e6a9c3a532c7ad0e9ab58`
- 本轮开发分支：`codex/sub2api-v0.2.15-compat`
- 本轮上游记录提交：`f6a02783983000a59dad468ef4bec31f3915860b`

官方版本通过 Git tag 和远端 release 双重核对；不得把未发布分支或实验提交当作升级目标。上游远端使用 `sub2api-upstream`，建议保留不可变的 `refs/tags/upstream/vX.Y.Z` 作为审查依据。

## 日常升级步骤

1. 在 `sub2api-main` 的隔离工作区确认工作树、子模块、当前镜像和回滚引用；任何无关 dirty change 都先保留，不在升级中清理。
2. `git fetch --tags sub2api-upstream`，核对 release tag 的对象 SHA、tag 指向的 commit、官方 release 状态和共同祖先；把 tag 固定为本轮输入。
3. 先建立升级标记，再把官方共同祖先到目标 tag 的补丁应用到开发分支。共同祖先稳定时可改用普通 `git merge --no-ff`；跨历史或已有定制较多时继续使用“ours 记录 + `git apply --3way`”的显式补丁方式，确保官方 diff 和定制 diff 可分别审查。
4. 逐个处理冲突，优先保留 Sub2API 原生 account、API key、group、模型路由、权限、余额、usage、幂等和结算路径；AI-Gateway 只保留媒体配置、工作台、Bridge/BFF 和交付边界的必要定制。每个手工保留的定制都要能在 diff 中指出文件和原因。
5. 检查 migration 文件名、排序、checksum 和回滚语义。特别检查同一序号的多个文件、旧字段到新 JSON/map 的数据转换、唯一约束和既有数据的空值行为。只在隔离数据库运行迁移演练，禁止把升级候选连接生产数据库。
6. 依次运行后端单测、前端 lint/typecheck/Vitest、前端生产构建、定制 Core 构建、Go/前端安全扫描。测试失败时按业务失败定位，不以 HTTP 200 或编译成功替代账户、路由、权限、账务和幂等验证。
7. 生成带源码 commit、Core SHA256、前端构建摘要、迁移清单、测试和安全结果的非生产候选。候选生成不代表生产部署；生产切换单独走发布守卫和批准。

## 本轮兼容要点

- 新增官方 migrations `238`、`239`、`240`、两个 `241` 文件和 `242`。迁移 runner 按完整文件名排序并按文件名保存 checksum，因此两个不同前缀的 `241_*.sql` 不会互相覆盖；升级前仍需在隔离数据库验证顺序。
- migration `239` 会把旧的 `max_reasoning_effort_multiplier` 转入 map。已有 map 优先，空 map 不会被旧字段重复恢复，重复执行保持幂等；这是数据语义兼容点，不能只看 migration 能否执行。
- 官方 HTTP/2 keep-alive 配置与 AI-Gateway 的 OpenAI、长流 profile 定制合并时，必须分别保留 `15s/15s` 和 `10s/5s` 的 read-idle/ping timeout，并验证 transport 实际启用 HTTP/2。
- 官方图片协议/余额错误分类与现有自定义图片计划编译共存：对无 multipart 的合成 streaming edit 保留 legacy rewrite，使上游余额错误仍能进入官方分类和 failover 逻辑。
- CC Switch 导入沿用官方最新平台默认模型策略；媒体配置、图片数量、结果保存/下载和单视频一次一条仍在 AI-Gateway 边界内，账务、用量、幂等和结算继续使用 Sub2API 原生路径。

## 自动检查与必须暂停的情况

可以自动完成：tag/SHA/共同祖先核对、工作树和 diff 检查、冲突文件清单、migration 文件名与 checksum 检查、隔离数据库迁移演练、后端/前端测试、构建、govulncheck、pnpm audit 及审计例外校验、候选 SHA256 生成、GitHub Actions 结果汇总。

必须暂停并由负责人处理：无法证明目标是正式 release；存在未解决冲突；修改了生产配置、凭据、价格或生产数据；migration 顺序/checksum/数据语义不明确；账户、Key、Group、权限、余额、usage、幂等或结算回归失败；安全扫描有未解释的 high/critical；无法建立隔离数据库；需要真实供应商请求、付费生成、生产迁移、部署或重启。

## 图片多图执行兼容边界

图片商品的 `adapter_config.execution` / `edit_execution` 是现有媒体配置的一部分，不建立独立模型能力表，文生图和参考图编辑分别核实。`single` 或省略配置表示只确认单图；客户购买多张时由工作台创建多个普通图片请求。只有管理员明确记录已核实的 `native_multi` 和 `max_output_images` 时，才在每个正常请求中使用 `n`，例如上限 2 的数量 5 会冻结为 `2+2+1`。模型名称、OpenAI 兼容格式或字段存在都不能产生该结论。

每个上游单元保存请求哈希、序号、输出范围、回执和结果哈希；未知回执只允许 GET 恢复，禁止 POST 重放。结果统一进入现有 Studio 结果存储，结算按实际交付数量调用 Sub2API 原生 usage/billing transaction；部分成功保留已交付和未交付数量，未交付数量不计入金额。现有 Gemini/Vertex 原生异步批量仍使用 Sub2API 自己的队列、hold/capture/release 和结果合同；在没有工作台 CNY 冻结报价与该 Account/模型适配器的明确桥接前，不能自动选入 Studio。

日常变更可自动完成：读取已发布 tag/SHA、验证 execution 配置、生成执行计划、运行模拟上游的 1/2/5 张、批次恢复/重复提交/部分成功、原生账务命令、前端契约测试和构建。必须暂停：能力证据只来自模型名或未发布实验接口；异步适配器、Account、报价或结算条件不能逐项证明；结果数量或持久化状态不一致；账务、权限、迁移或安全检查失败；任何真实收费请求或生产操作要求。

## 本轮耗时记录（Asia/Shanghai）

| 阶段 | 实际耗时 | 证据/说明 |
| --- | ---: | --- |
| 官方版本核对、fetch、升级标记 | 未单独计时（UNKNOWN） | 由首轮执行日志完成，下一轮按步骤启动 stopwatch；不能从 Git commit 时间精确推回 |
| 冲突整理与兼容修复 | 未单独计时（UNKNOWN） | 本轮跨历史定制较多，不能把总会话时长冒充纯修复耗时 |
| 后端全量 `go test -tags=unit ./...` | 232.85 s | 通过；其中 service 组 201.634 s |
| Ollama 定向回归 5 次 | 28.10 s | 通过 |
| 前端全量 Vitest | 90.69 s | 371 files / 2903 tests，通过 |
| 前端 lint | 40.16 s | 通过 |
| 前端生产构建（含 i18n、typecheck） | 82.48 s | 通过；Vite 仅报告既有 chunk/dynamic-import 警告 |
| 前端 CI critical Vitest | 42.80 s | 32 files / 587 tests，通过 |
| Go Core 构建 | 61.43 s | 通过；使用定制源码和已构建前端资源 |
| Go `govulncheck ./...` | 33.85 s | 退出码 0；未发现代码可达漏洞 |
| pnpm audit + 例外校验 | 约 6 s | high/critical 为 0；moderate/low 依赖项由现有例外/审计结果记录，例外校验通过 |
| 隔离 PostgreSQL/Redis migration + pricing 回归 | 29.55 s | Testcontainers；migration 239/242、reasoning pricing 与账务 round-trip，通过 |

由于源码同步和手工冲突处理没有在首轮使用独立 stopwatch，本轮不虚报该两项时长。普通补丁版本在共同祖先清晰、依赖缓存命中、无手工冲突时，有希望把源码同步、自动检查和本地候选压到 20–30 分钟；本轮跨历史合并不具备代表性。最大瓶颈是人工冲突和 service 全量测试，其次是 GitHub Actions 排队/构建时间。最小优化是固定上游 tag/SHA、维持可合并祖先、缓存 Go/pnpm/Docker 层、并行前后端 CI，同时保留账务、权限、迁移、幂等和安全检查。

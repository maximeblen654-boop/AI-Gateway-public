# 第三轮审查：图片历史期限最小修复

2026-10-19，状态 `UNCOMMITTED / NOT_DEPLOYED / AWAITING_REVIEW`。

业务仓库 `D:/AI-Gateway-public-staging`，分支 `codex/media-paid-controls`，HEAD仍为 `33c819064ef95666f6b512ebaed1e2d7a09e34d6`。保留此前全部未提交实现，无新提交、推送、候选或生产操作。

## 根因与修复

`studio/bff/image-binding.mjs` 原 `history()` 无条件按 finalized task 的 `created_at + 72h` 隐藏。任务00:00创建、原片01:00落盘时，会在真实到期前一小时消失。原有 owner-scoped cleanup 在本地字节和 metadata 同时缺失时，也可能提前删除仍有 Core 未来原片期限的 journal。

新增短小 `historyExpired(task)`，统一复用现有 `retention(task)` 的可信绝对 `expires_at`，供 history 与 cleanupExpired 使用。没有产生第二种原片期限，也未改变多结果已存在的最早有效期限规则。

- completed/partial 且 billed：有服务端已确认的原片期限就使用该期限；真正无具体期限时沿用已有创建时间历史策略。
- failed/released 且 not_charged：保留已有普通历史策略。
- unknown、pending、billing_unknown、未结算状态：继续保留查询和恢复。
- 旧PNG：复用真实七天截止，不提前隐藏。
- 原片到期后：历史列表按已有到期普通历史策略移出；已打开详情仍显示“原片已到期”，下载410。实际展示journal删除仍要求权威receipt终态、有限批次及无有效原片数据。quotes、dispatch claim、期限证明和原生财务记录不删。

图片72小时、视频48小时、下载授权、报价与结算均未调整。没有为此增加后台服务、价格或存储框架。

## 本轮实际变更

运行代码只有 `studio/bff/image-binding.mjs`。直接测试为 `studio/bff/media-retention.test.mjs`，浏览器新增 `frontend/tests/studio-workspace/history-deadline.spec.ts`；既有fixture `main.ts` 只为专用场景转发真实本地BFF任务GET并禁用合成原片service worker。

业务根 `AGENTS.md` 追加“项目阶段适配与反过度工程”唯一正文，总控 `D:/AI-Gateway/AGENTS.md` 仅追加引用。既有权限、草稿安全、计费、完整审查交付和自动轮换规则保留。

旧 Core 无法读取新草稿回执仍是真实兼容性事实，没有被修复或宣称兼容。用户已明确调整风险阶段分类：当前未执行旧版本回退，因此不再把此事实自动升级为P0开发阻断；未来真正安排升级/旧回退时再核对具体组合。本轮没有新增兼容层或回退体系。旧审查材料中的P0标签保留为历史证据，不代表本轮最新结论。

## 实际测试与证据

证据目录 `.codex-tmp/history-deadline-fix-20261019/`，打包后为 `evidence/current/`。

| 验证 | 结果 | 证据 |
|---|---|---|
| 修复前控制时钟反例 | 3 FAIL，分别复现提前隐藏、未来Core承诺丢失、旧PNG提前隐藏 | red-history.log、red-command.json |
| BFF直接相关7文件 | 105 PASS / 0 FAIL / 0 SKIP | bff-regression.log、bff-command.json |
| 既有报价/任务组件/自动保存/本地恢复4文件 | 223 PASS / 0 FAIL / 0 SKIP | frontend-results.json、frontend-commands.json |
| 完整TypeScript | exit0 | typecheck.log、frontend-commands.json |
| 原片期限既有浏览器测试 | 3 PASS | first-browser-results.json |
| 实际Vue + 实际BFF journal/store/HTTP | 1440×900、390×844两例PASS | browser-results.json、browser-final/四张真实viewport截图 |
| 独立审查定向复跑 | 13 PASS / 0 FAIL，属于以上用例的独立复核，不重复相加 | INDEPENDENT_REVIEW.md |

真实BFF浏览器测试使用隔离目录、合成session和模拟Core，不连接生产/供应商。先在创建满72h检查列表、详情和下载，再在原片到期前1ms验证下载200、字节一致和历史仍在，到期时410、显示过期、刷新历史移出。浏览历史和下载阶段无生成POST、无新增Core receipt/result获取；模拟初始化的一次POST只在本地stub内运行，不是供应商请求。

首次两例浏览器失败是新增断言漏了界面既有“任务：”前缀，改为包含准确task ID后复跑2/2通过。该失败日志与trace保留，没有为了测试修改业务UI。

Core、视频执行与原片TTL底层代码本轮未改，复用上一包完整测试和截图，包括Core112顶层PASS/1个Windows符号链接权限SKIP；不把旧证据写成本轮重跑，不把fixture当生产验收。

## 交付与下一步

新包包含当前所有未提交源码/测试、完整HEAD补丁、本轮增量补丁、最新规则及上一包全部成员原字节。完整性、敏感信息与证据替代核验后，仅轮换上一份明确已完成审查的ZIP，不删除源码、测试证据和报告。等待ChatGPT复核，不继续扩展功能。

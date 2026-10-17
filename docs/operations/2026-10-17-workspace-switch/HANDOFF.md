# AI-Gateway 工作空间切换交接（2026-10-17）

> 给新的 ChatGPT / Codex 工作空间读取。  
> 本文是阶段交接，不替代项目正式 Constraints。正式 Constraints 的本地 canonical 文件仍是：
> `D:/AI-Gateway/AI-Gateway-ChatGPT-Constraints-pricing.md`

## 1. 当前项目与生产事实

- 项目：AI-Gateway / Sub2API 媒体工作台。
- GitHub 仓库：[AI-Gateway-public](https://github.com/maximeblen654-boop/AI-Gateway-public)
- 主工作分支：`codex/media-paid-controls`
- 最新交接提交：`727609be5d6c16875cbf0a9344758ccbd5a564bf`
- 最近一次现网只读核对：
  - 生产三组件实际运行 `native-candidate-{core,bridge,bff}:784d12c3257d7ce40d106ad7991abe6d40c74555`
  - Core、Bridge、BFF 均 healthy
  - `https://laifufu.top/studio/` 与 `/health` 返回 HTTP 200
  - 用户消息中提到的 `d1b87b3f` 是旧基线，不能当作当前现网身份
- 生产开关的历史目标一直是：图片开启、视频关闭；任何新操作前必须重新读取 readiness 和实际容器环境，不能只依赖旧文档。

## 2. 已完成的主要任务

### 2.1 媒体工作台与商品链路

已完成并经过隔离验收：

- 管理员媒体工作台正式 Vue 实现。
- Account、模型、商品、规格、比例、数量、价格、发布和销售状态的前后端联调。
- 文生图、参考图编辑、视频的既有 Sub2API 路径复用。
- 单模型依赖隔离：一个模型不可用不应关闭其他正常模型。
- 目录同步不会因为无关模型或 synced_at 变化误关闭正常商品。
- Account #77 的已发布商品与 Banana 草稿独立处理，Banana 不应被意外发布。

### 2.2 任务、资金与错误终态

已完成并有隔离证据：

- Image2Pro 明确 HTTP 502 且没有交付结果时，客户侧终态为 `failed / not_charged`。
- 不重新发送原始付费 POST，不重复扣费。
- 断线、超时、unknown、billing_pending 保留恢复和查询能力。
- 三笔历史 502 已按一次性白名单维护处理为客户侧失败、未收费。
- 104 笔混合资金/幂等隔离回归通过，覆盖成功、502、部分成功、拒绝、断线、超时、迟到和重复回执。

### 2.3 历史任务与 UI

已完成：

- 失败任务默认隐藏，可点击“显示失败任务（N）”查看，再隐藏。
- 图片原片与普通图片历史按 72 小时规则处理；旧 PNG 的既有 7 天承诺保留。
- 安全终态任务可分批、可重复清理；unknown、pending、billing_unknown 和账务恢复凭证保留。
- 下载原片按钮和图片结果卡片视觉优化已部署到当前现网版本 `784d12c...`。

## 3. 本次最后完成的性能修复

用户反馈：已完成、已结算、原片已保存的图片，刷新或重新打开历史任务仍然很慢，甚至再次显示查询中或连接暂不可用。

### 已确认根因

1. `StudioMediaPanel.vue` 在选择任务和恢复页面时无条件调用 `studioTask()`。
2. BFF `recover()` 对本地已有完整结果仍可能再次 GET Core receipt/result。
3. 原片接口使用 `private, no-store`，浏览器重复打开会再次下载完整 4K 原片。
4. readiness 失败被前端直接渲染成“当前生成服务未开放”。

### 已实现

源码提交：

`75f8bdc2b545c5edde552e9b896aef4f9e18028e`

- 已完成且本地原片齐全的任务，历史打开和页面恢复不再自动查询 Core。
- 本地结果完整时 BFF 直接返回；缺少结果时才走恢复。
- 原片响应使用内容 SHA-256 ETag、`private, max-age=60, must-revalidate` 和 `If-None-Match` 304。
- 保留原始画质、下载 URL、权限、72 小时保留和过期拒绝。
- readiness 区分 enabled / disabled / unknown；状态暂不可用不再误报为已关闭。
- 增加“正在加载已保存原片”提示，不重做任务卡片。

### 验证

- 前端 `StudioMediaPanel.spec.ts`：61 tests PASS。
- BFF image binding / result store：29 tests PASS。
- TypeScript、ESLint、Node 语法检查：PASS。
- GitHub Candidate Run：`38938645575` PASS。
- 完整候选 Artifact：`12063196736`。
- 小证据 Artifact：`12063650738`。
- 该候选**尚未部署生产**。

详细交接：[2026-10-17-image-result-performance/HANDOFF.md](../2026-10-17-image-result-performance/HANDOFF.md)

## 4. 之前 Codex 已经布置、但当前仍需处理的事项

唯一直接待办是：

1. 取得新的生产部署授权。
2. 部署源码 `75f8bdc2...` 对应的完整候选，不要部署旧 `d1b87b3f`。
3. 部署前重新核对：
   - 现网三组件真实身份、Compose、网络和挂载；
   - 图片/视频实际 readiness；
   - 回退资产；
   - 商品、价格、mapping、余额、usage/dedup 和历史任务保护指纹。
4. 部署后只做安全验收：
   - 已完成图片重复打开不再触发 Core recovery；
   - 原片第二次请求可命中私有 ETag/304；
   - 4K 原片仍可预览和下载；
   - unknown / processing / billing_pending 仍可恢复；
   - 桌面 1440px、手机 390px；
   - 不发送新的真实供应商付费请求。
5. 生产部署仍需用户单独明确授权；候选 PASS 不等于已经上线。

不要因为这项性能修复重新开发历史清理、计费、商品、模型映射或客户作品桌。

## 5. 长期 Constraints 核心规则

正式原件：`D:/AI-Gateway/AI-Gateway-ChatGPT-Constraints-pricing.md`

新工作空间至少要遵守：

- 严格区分 Provider、Account ID、Upstream Model ID、Site Model ID、Product ID、Offer ID 和媒体类型。
- 不用“GPT 商品”“Banana 商品”等泛称替代具体模型/商品身份。Account #77 的 `gpt-image-2` 只代表该具体图片模型。
- 配置、发布、下架、归档、恢复、测试、报价、生成和计费必须限定到明确模型或商品。
- 一个模型失败不能无理由关闭其他正常模型；共享资金、权限、凭据和存储故障按真实影响范围阻断。
- 媒体工作台 Published Offer 与独立 API Key 原生调用是两条不同业务路径。
- 默认使用隔离模拟和非付费测试。真实供应商付费生成必须获得当次明确授权。
- 生产部署、生产数据写入、商品发布、启售、改价、mapping 修改和历史任务处理分别受授权约束。
- unknown、断线、超时和账务未决不能被猜测为成功或失败；不重发原付费 POST。
- 优先复用 Sub2API 的 Account/Key/Group、路由、任务、结果和原生资金事务，不新建第二套钱包、账本、任务平台或供应商监控。
- 大型构建优先 GitHub Actions；开始和结束都检查 C/D 磁盘，保留约 10 GiB 余量，清理只针对已确认可再生的临时产物。
- 生产报告必须区分源码提交、候选 PASS、实际部署、客户交付和付费测试。

## 6. 新工作空间启动提示词

可直接把下面这段发给新的 GPT/Codex：

> 继续 AI-Gateway 原项目长线程。先读取 GitHub 交接：
> [2026-10-17 工作空间切换交接](https://github.com/maximeblen654-boop/AI-Gateway-public/blob/727609be5d6c16875cbf0a9344758ccbd5a564bf/docs/operations/2026-10-17-workspace-switch/HANDOFF.md)
>
> 当前不要重新开发已完成的媒体工作台、502 终态、资金验收、历史清理或 UI 任务。先确认现网真实版本，再处理唯一待办：审核并在获得明确授权后部署 `75f8bdc2b545c5edde552e9b896aef4f9e18028e` 图片历史加载性能候选。部署前后必须保留精确模型身份、生产数据、价格、mapping、账务和开关边界；没有新的生产部署授权时只做审查，不切换生产。

## 7. 当前停止状态

`CANDIDATE_READY_NOT_DEPLOYED`

本交接没有授权生产部署、真实供应商付费生成、商品发布、启售或生产历史删除。


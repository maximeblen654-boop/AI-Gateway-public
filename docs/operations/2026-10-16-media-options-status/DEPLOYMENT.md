# 15da7cbba 部署前检查：停止于现有发布依赖不一致

**DEPLOYMENT_BLOCKED_BEFORE_SWITCH**。2026-10-16 北京时间。本次没有切换、重启或回退；生产仍为 `4f10be20ef06bc0a7670822e88eefd60c53d09c9`。图片实际关闭发生在本次切换前，不能报告“部署后保持开启”。

## 已确认的现场状态

- Core、Bridge、BFF 均为预期4f10整组，健康正常、managed-v1正常、sidecar附着当前Core；PostgreSQL/Redis健康，Caddy active。基础Compose及4f10 overlay未改。
- 图片 requested=true、effective=false，管理员API为 `reason=apply_failed`；视频 false/false，reason=closed。内部服务也返回图片paid_enabled=false。此状态在本次执行非付费预检之前已取得；`apply_failed`是锁闭后的汇总原因，不能凭此重建第一次失效的完整历史。
- 生产监控仍为V1。没有启用V2，没有生成供应商请求。
- 迁移记录293条，无候选待执行SQL或checksum差异；4f10→15da的migration文件无变化。

## 实际阻塞与证据

北京时间 **2026-10-16 03:08:14**，正常管理员会话执行既有非付费图片检查：HTTP200，业务 `pass=false`，浏览器334ms、服务端61ms。`billing_eligibility`与`private_result_storage`通过；Account #77 `published_specs`失败，`accounts_validated=0`、`specs_checked=0`。**1,870组合尚未进入，不能报告PASS**。

已发布快照的catalog摘要为 `7a23bb397161bfa30e7194dd6675d6de3b1e3c9e71aa9f0cec493369c3c80e38`；当前Account目录为 `d351a78377633b97bf27bda5694c4b672032dd5115c6a22884de33f257937a81`，两者不同。当前目录更新时间2026-10-15 23:47:27北京时间，当前摘要与后续草稿验证记录完全一致。

现网4f10的 `publishedReadyContext()` 比较 Published.Dependencies 与当前 Account 的 DependenciesFor；目录不同即拒绝。`InspectPublishedOffers()`因此在枚举规格前返回ErrRuntimeBinding。固定15da保留此判断，本次换镜像不会绕过该保护。这里只证明已有发布依赖失效，不将其描述为供应商故障、Banana不支持或未发布草稿本身使销售失效。

## Banana草稿：已保存且校验通过

Account #77数据库当前确实保存**两份**草稿商品：gpt-image-2、Nano-banana-2.1。草稿保存时间北京时间2026-10-16 **00:39:27.558**；验证在同秒完成，revision与草稿一致，PASS、publish_ready=true、diagnostics为空，case_count=3570。

只读管理员详情HTTP200同样显示2份草稿及PASS；Account销售标记仍true，但effective_sales=false / PUBLISHED_NOT_READY。已发布快照仍是2026-10-14的**一份GPT商品**，不是当前两份草稿。

因此当前没有“草稿未保存”或“检查暂不可用”的持久化证据；旧截图当时的浏览器未保存状态无法由现在的数据库追溯证明。此前Handoff中用户自述“没有保存”不能替代上述现场事实。本轮没有保存、覆盖或发布草稿。

## 保护结果和停止边界

前后用户资金、usage/dedup/archive、视频订单摘要一致；Account77完整媒体记录、监控设置、付费开关持久记录、三笔历史502回执摘要均不变。无在途图片claim。原生计费、已终结failed/not_charged任务保持。

已核验候选Artifact11997437376仍有效、绑定15da源码/Run38784147330；本地最终PASS manifest摘要符合批准值。由于生产前置检查失败，未下载三份TAR、未load镜像、未创建部署overlay、未切换或恢复图片开关。候选仍有效，不重新构建。无维护窗口，切换耗时0秒。三组件旧镜像、配置及回退资产均未触碰。

下一步需要**单独审查并决定Account #77已发布依赖如何更新**。不能直接把当前两份草稿整体发布：那会连同尚未授权启售的Banana方案改变发布范围；也不能手改摘要或关闭依赖检查。当前部署授权不包含该业务操作。本轮停在真实阻塞处，不擅自修代码、改mapping、恢复开关或继续付费测试。

## 证据与截图

[结构化脱敏证据](deployment-evidence/deployment-blocked.json)。截图为本次**现网4f10**管理员付费状态，仅裁切控制卡；不是15da新UI验收截图。

![桌面现网图片控制](deployment-evidence/blocked-image-control-1440.png)
![390px现网图片控制](deployment-evidence/blocked-image-control-390.png)

PUB-01/02/04/05：本轮旧版本HTTPS登录页面/原生服务只读范围已核对，15da上线项未执行；PUB-03没有代理变更；PUB-06在切换前发现阻塞并保留现场。ART-01复用已验收候选证据，部署端TAR/load身份尚未执行。不得把候选PASS或旧版页面当作本次上线PASS。

Constraints原文不变。未发生生产部署、商品发布、销售调整、生成、退款或补扣。

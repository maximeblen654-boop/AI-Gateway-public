# 新候选与 Account77 恢复的唯一受控顺序

状态：仅准备；尚未获得本轮生产部署、Published 写入或图片恢复授权。本轮无生产操作。

本文件接续 `../2026-10-16-published-catalog/RECOVERY_PLAN.md` 的原件备份、完整 Account SHA、CAS、重新校验和原子写入机制，不替换用户草稿。最终固定候选身份以本目录最终 HANDOFF 和 PASS manifest 为准；不能使用 3b4 或中间 539 镜像冒充新候选。

1. 后续取得明确授权后，只读重新核对现场：预期旧运行 4f10，图片 requested=true/effective=false，视频 false/false，Account77 原 Published 只有 GPT，Draft 有 GPT+Banana。以现场身份和指纹为准，漂移停止。
2. 核对冻结镜像和 manifest、原三组件与恢复资产、无数据库迁移；按既有流程切换新候选。保持 paid 失效保护，不先强开。
3. 用该候选附带的 `media-published-recovery` 默认 dry-run，仅从 Account77 原 Published 的 GPT Products 重新校验。要求完整1870规格、原 Products/Offers/ID/售价/执行合同逐字段相等；不从当前 Draft 发布。
4. 审阅计划的 Account 全行 SHA、原 Published revision、record_version 和预计修改指纹。已有离线副本预期 record_version 32；现场不同则停止，不自改预期放行。运行受控 `-apply-plan` 时对完整原件二次比较、行锁、独占备份、fsync、CAS原子提交，任一差异回滚事务。
5. 相对旧计划，恢复结果新增逐商品 `product_dependencies`，Published revision 因而为 `mwp_a2ba7043fbb0b9a9528879ba1f8d0fa32df963102bacdf803eb51e29da30f589`（已有离线副本）。这是新固定候选的显式验证结果，不是手改摘要。原 Products、Offers、Draft、Draft revision、validation、Sales 和其他 Account 字段必须不变；仅 Published及record_version32→33由工具处理。时间和JSON序列化口径按工具计划比较。
6. 执行完整1870组合非付费预检、文生图和编辑报价、服务健康与业务指纹比较。额外授权允许时再通过既有管理员机制恢复图片，执行服务端二次检查；视频不动。Banana仍仅为草稿，不整体发布、不改价、不真实生成。
7. 验证管理员逐商品状态、选择发布、生命周期和客户提示的只读页面。保存/上下架/归档无需在生产补测，使用本轮最终镜像隔离证据。

## 回退兼容

本轮新增生命周期及逐商品 Published JSON 字段；4f/3b严格解码器不兼容。任何新字段写入后不能盲目回退旧三组件，更不能覆盖整份 Account 配置、数据库或历史任务。切换前必须证明没有新字段写入才能采用旧组件回退；写入后发生异常时保留数据并报告，使用经验证兼容版本或另获授权的精确定向恢复。原Published备份保留，不把恢复它视为默认授权；旧目录摘要本来失效，回到它并不等于可售。

## 商品隔离语义

完成原 Published 的受控逐商品依赖恢复后，无关目录增加、顺序或同步时间变化不使GPT失效。实际GPT删除、映射或执行合同变化会阻断GPT；将来其他商品明确选择发布且获必要付费预检授权后，可独立营业。当前Banana未Published，因此本轮不能宣称生产已有第二个可售图片模型。

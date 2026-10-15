# Account #77 原 Published 的 GPT 依赖恢复方案

状态：隔离验证及新候选通过，等待额外生产授权；**本轮未修改生产 Published、Draft、销售或付费开关，未部署**。

## 已确认的变化与边界

原发布目录 46 个模型、同步时间 2026-10-13T16:33:40Z；当前目录 53 个模型、同步时间 2026-10-15T15:47:27Z。新增 7 个模型，未删除任何模型；gpt-image-2 仍在。原目录的原生类型摘要与旧 Published 依赖完全一致。见 `catalog-delta.json`。

原实现 `DependenciesFor` 对整个 Catalog（含 synced_at、模型列表及顺序）取摘要；`publishedReady` 和 managed-v1 指纹均使用它。因此同步时间或无关新增模型也会阻断正常 GPT 商品。没有证据表明 GPT 模型映射、路由、绑定或价格发生变化。

修复保留完整目录摘要作为草稿校验/CAS 的依赖。新发布快照使用版本化 `published-models-v1:<sha256>`，仅绑定已发布商品引用模型是否仍存在。Account、完整 mapping、路由、协议绑定和 registry 摘要继续参与。模型删除、真实映射/路由/协议变化仍阻断。每次 publishedReady 仍调用完整原生校验，不以摘要代替校验。

旧 64 位摘要的快照继续严格校验；读取不静默升级、不改写。新代码部署本身不会修复生产旧快照。

## 唯一建议的生产操作顺序（须追加授权）

1. 使用本轮新候选（不是 15da）按既有发布锁/三组件流程部署，保持视频关闭及图片当前失效保护；禁止先强开图片。
2. 在同一受控维护窗口核对实际源码/镜像、数据库迁移零差异、回退资产及完整 Account #77 指纹。使用候选附带的 `media-published-recovery` 工具默认 dry run，DSN 仅从受保护进程环境传入，不打印凭据。
3. 工具固定 Account 77、原 Published 仅一个 image/gpt-image-2 产品。从原 Published.Products 运行现有完整 Validate 与 InspectPublishedOffers（必须 1870）；严格相等比较 Products、Offers 和非目录依赖。**不使用当前 Draft 来发布**。
4. 审阅 dry-run JSON：Account 全行 SHA、当前配置 SHA、原 Published revision、record_version、替换 Published SHA、预计配置 SHA、1870 结果。身份与本报告不一致停止，不自动更新预期值给变更放行。
5. 取得本次追加授权后，运行 `media-published-recovery -apply-plan reviewed-plan.json -backup NEW_PRIVATE_PATH`。事务对 Account 行加锁、重读原生投影、重复完整校验、比较预期 SHA；O_EXCL/0600 新文件备份并 fsync；写前再次校验全行 SHA；原子修改且仅修改 `extra.media_workbench_v1.published` 和 `record_version`。提交前重读核对预计 SHA。任何差异/备份失败/取消均回滚，重复应用旧计划拒绝。
6. 生产写入预期：record_version 32→33；旧 Published revision →本报告恢复 revision；PublishedAt 为该次受控 dry run 的时间。Draft、Draft.revision、Config.validation、两个产品、价格、销售标记及其他 extra/Account 字段完全保留。当前两商品草稿仍未整体发布，Banana 不进入 Published。
7. 全量 1870 非付费预检、文生图和参考图报价及前后资金/商品/历史任务指纹核对通过后，按额外部署授权恢复图片 requested/effective=true，并完成服务端二次预检；视频保持 false/false。不调用供应商生成。

## 现有副本的预期指纹

见 `offline-native-proof.json`。恢复后的 Published revision 不含 PublishedAt，故确定为：
`mwp_9c5f3bc01007b9372219a8e2fbb9a0a1d25a4d49a083a584d8359da6b889be6f`。

旧 Published revision：`mwp_398091bdc7e4e4e90e1a2c92808fa182c203560023448ece87b910b25bef012e`。

保留的 Draft revision：`mwd_e7d66dfc6b79c84ec1382c602d1ef9d2e42e992e7765ebff89bca21a8adcba6e`，两商品、validation PASS。

GPT Product/Offer、规格、执行绑定和售价必须逐字段相等；唯一允许的 Published 变化是目录依赖、发布 revision 和 PublishedAt。原配置、替换 JSON、数据库 canonical JSON 的 SHA 有不同序列化口径，不能混用；正式 apply 使用同一 PostgreSQL canonical 格式的计划。

离线证明覆盖 1870 个规格；只读投影不含密钥，原生仓储解析 RuntimeReady、mapping、路由。文生图及1/16参考图、1/3/10张价格核对为每张0.025 CNY，3张0.075。该证明是隔离商品解析，不冒充生产完整付费控制预检。

## 兼容和失败处理

不增加数据库 schema 或 JSON 字段。旧程序可以解码版本化摘要，但不能认可新语义，会 fail closed。**在写入新摘要后，不能无条件回退旧镜像并宣称销售恢复**。

部署发生在依赖写入前：可以按原有兼容流程回退三组件，原旧快照仍保持未就绪。依赖写入后：优先停止进一步操作并保留数据；若需恢复旧依赖，只能在取得对应授权、确认本操作仍拥有该 Published 且没有后续配置变更时，定向恢复本次备份的原 Published，并推进 CAS 版本。不得整份恢复配置覆盖用户 Draft，更不得恢复整库、任务或资金。旧快照目录仍不匹配，因此回退不等于恢复销售。

本轮不执行以上生产写入/部署/开关操作。

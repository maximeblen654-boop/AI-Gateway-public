# 8ad2eff 生产部署准备

状态：`READY_FOR_EXPLICIT_DEPLOY_AUTHORIZATION`。本轮未导入候选镜像，未切换或重启生产应用，未操作商品、资金或付费开关。以下现场时点均为 2026-10-19 北京时间（原始 JSON 保留 UTC）。

## 固定候选与暂存

唯一运行源码 `8ad2eff39ff5bf6bfd07563041556f4a4c42d9a1`。CI `39163329810`、Security `39163329880` PASS；其测试提交 `ebeb7ee9bb73c429687cdfaf7f132023d27ef6c7` 与运行源码 2,415 个运行条目一致。最终补验 Run `39164189216` / 脚本 `bc90cb09105eaca5434c4464a9fd1e0d09a81f71` PASS。

完整 Artifact `12149012613`（构建 Run `39161087117`）与最终证据 Artifact `12149958347` 已由 VPS 直连下载，分别校验官方大小和 ZIP 摘要、压缩完整性、安全解包、三个 TAR、所有 OCI layer、config 与源码标签。没有在 Windows 下载完整镜像，没有重建。

原包旧 manifest 的 `NOT_PASSED` 原样保留；最终补验没有重新导出镜像。放行配对是**原始固定 TAR + 最终 PASS manifest + 对应补验报告**，不是改写旧失败结果。

| 对象 | SHA256 |
|---|---|
| 完整 ZIP | `e3c0f01272a2964a6e52d2ebc0cf070e825548238c113b0c526c5400a3d16c7a` |
| 最终证据 ZIP | `b996a052802086a3b8d6f5bff66de32019266f0abebc9ef0c32b772807915232` |
| 最终 manifest | `485c4a8fcc54b31bb415304366f9244d33ed95a9fb63a6c43f0779451a7d0dca` |

| 组件 | TAR SHA256 | OCI manifest digest | config digest |
|---|---|---|---|
| core | `4b7340643da2095e32af304b59b62946709dad888932cb1570fa2134d392ef41` | `sha256:02246764463d28040bd4917ca4c6d0a9903d9977f377648ddb528e46b2e71d48` | `sha256:76a084ae2d253dfaf1d48fa5af2c8dfa8775a230c6e95822686fc25d5a0e965c` |
| bridge | `e4c91eec68ee3fd9eeee62450accdf387610db0df4d04720cc92dd5034aa90c3` | `sha256:b3f8836b60b2baad304bb78747fea1e70298f865a1fba9fbf122f8409bc6b11b` | `sha256:5845bd670349d4c363c2732c248744a1de03b6329b7a34d9f1296c8150189bc0` |
| bff | `726eaababccb16855fc1013c103b59c49029868f7b80dac8b0a622aa157da413` | `sha256:a15a5581e39eca3cd1dbe7d6faeb379cff23cc416a3b3539d39750ebd3e7b4cf` | `sha256:88ad43ec7b56f4f47ef653f26d3eed6187c8dcd9f00a433bedc2c9698cde39c8` |

受保护暂存目录：`/var/lib/ai-gateway/candidate-transfer-8ad2eff39-20261018T211618Z`。原包在 `original/`，最终清单和补验证据在 `final-evidence/`。两个 Artifact 有效期至 2026-11-01；具体 UTC 时刻和归档路径见 [脱敏证据](predeploy-evidence.json)。完整包不是只有截图的小证据包。

已有同镜像 104 笔资金、19 项既有浏览器、24 项采购流程、最终真实隔离三组件/数据库/模拟上游验收按原证明复用，未重做；不将模拟供应商结果当作真实供应商可用性。

## 实际生产与保护指纹

05:13:36 首次、05:46:13 最终全量只读采样一致；05:49:15 再复核业务文件和入口。仍为 `b5b23a1f01721d41d94fb03bc6ac8796453dd24b`，不是候选 8ad2eff。

| 生产容器 | 实际 image ID（同时对应旧归档 OCI manifest） | 启动 UTC | 健康 |
|---|---|---|---|
| sub2api | `sha256:5f4aa40e4d9acc693ec17144107cfa8e00aeddfb83d33ce070f86f3052d07907` | 2026-10-18T17:18:07.323057013Z | healthy |
| studio-v2-bridge | `sha256:8d107297b2f73be71c74475052ff77f150a3b62bf774749f094d5c85d8f005d5` | 2026-10-18T17:18:14.065175356Z | healthy |
| studio-v2-bff | `sha256:a3a3e3bffb8803523f65bffbf01a283ddf2660d04dd3295107b7a1bd7ae2c5a4` | 2026-10-18T17:18:34.883454017Z | healthy |

运行中的 Core 程序、Bridge 程序、BFF 入口文件也与旧正式 Artifact 的 runtime-files 清单相符，防止只看 image ID 漏掉容器内热替换。旧 config digest 与 TAR/运行 rootfs 核对记录见证据，不能把 config digest 与 Docker 实际 image ID 混称。

实际 Compose base 为 `/home/ubuntu/services/ai-gateway/phase5-launch-20261010-final-3bb336b/compose.json`；生效 override 为 `/var/lib/ai-gateway/candidate-transfer-b5b23a1f0/compose.override.json`。Bridge/BFF 均附着当前 Core 的同一 container network namespace，Core 使用 `deploy_sub2api-network`。PostgreSQL、Redis、旧辅助服务的容器身份及启动时间均未变化；本轮未重启它们。

Core 数据卷仍为 `deploy_sub2api_data`；PostgreSQL 18、Redis 8 使用既有卷；素材、图片、视频绑定目录为 `/var/lib/ai-gateway/studio-v2/{assets,images,videos}`。完整挂载/只读属性、Compose 和 Caddy 摘要见证据，不公开原始环境变量或配置正文。

通过既有官方内部只读 GET（凭据只在远端内存）读取 effective，并以只读 settings 核对 requested：**图片 true/true，视频 false/false，managed-v1**。不是用匿名 401 或 legacy 环境变量推断开启状态。legacy 提交开关及 receipt worker 仍为 false，没有改变。

Account #44 / Group #31 / SiteModel、UpstreamModel `WAN3.0-可参考视频` / Product `media-92a8e4ac-0ca9-4ece-bd6b-0921d2a55f97`：record_version 5、销售 true。Account #77 / Group #31 / SiteModel、UpstreamModel `gpt-image-2` / Product `media-290f101c-aad9-40bf-a48b-b506ae80c762`：record_version 35、销售 true。各自 Offer ID、Draft/Published revision 和配置/售价摘要见证据。不得由上述具体模型扩大到同 Account 的其他商品或 API 模型。

首末采样的商品配置、草稿/发布、价格、mapping、Group、Channel/采购规则、Key、余额/冻结余额、usage/dedup、视频订单与迁移指纹一致。Core 174 文件、BFF 45 文件未增加或删除，业务文件及原片摘要一致。Core 总清单原始摘要不同，准确原因是三份既有监控报告的采样/成功时间单调推进；没有把全目录冒称逐字节未变。

备份窗口捕获的其他正常后台变化单列核实：其他 Account 的 `extra.upstream_billing_probe` 和更新时间、`scheduler_outbox` 的 account_changed 事件、统计聚合 watermark。Account #44/#77 无此变化。账户业务值使用 PostgreSQL canonical JSONB 精确比较，保留 null/空对象和精确数字区别；usage 与结算去重仍逐表核对。没有回写或回滚这些后台变化。

文件只读观察为 5 个图片任务（2 completed、3 failed）、5 个有保存响应的单元 claim、0 未决/损坏记录；视频订单 1 CAPTURED、1 RELEASED、0 HELD。05:41 的原生 Account 并发槽、活跃 lease、等待计数均为 0，且未清理过期槽。此为观察点，不代替正式切换锁内的重新排空检查。

## 当前完整检查点与真实恢复

新建而未覆盖旧备份：`/var/lib/ai-gateway/checkpoints/predeploy-8ad2eff-20261018T212207Z`。root-only 0700；完成于 05:35:00。约 268.85 MiB，包含在线导出快照的 PostgreSQL custom dump、必要角色恢复信息、Redis RDB、实际运行配置、容器/镜像身份、Core 数据与 BFF 素材/图片/视频、权限及文件清单。全部敏感原件只保留在受保护主机，未上传公开 GitHub。

`SHA256SUMS.ready` 摘要 `ef3894e8bab9288039c15e23615c9d97f226b4250e0aff90101b551f160fb90b`，逐文件校验通过；PostgreSQL dump SHA256 `ef8557244851fd1e45b41c466441b95572d4d6c9ece54d788c51e5631f15ebbb`。

| 恢复项目 | 实际验证 |
|---|---|
| PostgreSQL | 真正启动独立 PG 并 pg_restore：101 表、44,941 行，各表指纹零差异；不是只读 TOC |
| 持久文件 | 真正解包恢复 219 文件、140,597,629 字节，所有归档文件摘要一致；商品、任务、receipt 和素材关系保留 |
| Redis | 独立 Redis 实际载入 RDB、PING、redis-check-rdb CRC 通过；3,139 keys、139 expires |
| 隔离 | network=none、无公布端口、无生产可写挂载；PG/Redis 使用独立 tmpfs，未启动恢复后的应用/worker |

数据库各表来自同一导出事务快照；DB 与文件不是一个跨系统原子快照，因此额外对关键业务数据和文件做稳定性检查。先前阻断报告原样保留；确认差异只属上述逐字段后台观测后，另建最终 `restore-acceptance.json`，没有把失败报告直接改成 PASS。仅清理本轮确实创建且核对 immutable ID 的隔离容器，不碰旧备份或生产对象。

## 空间与回退资产

VPS 根盘可用从约 23.44 GiB 到 **22.67 GiB**；变化主要来自必要候选暂存与新检查点，无生产磁盘清理。三个候选 TAR 共 201,510,761 字节，OCI layer 共 504,607,232 字节。后续导入/展开/临时空间及必要快照更新保守预算额外 4 GiB，再留 10 GiB 运维余量；切换前至少需 14 GiB，目前满足。此预算不能用本机磁盘替代。

旧 b5 Artifact `12143512127`、ZIP、三个 TAR、旧 manifest 和实际镜像都仍在 `/var/lib/ai-gateway/candidate-transfer-b5b23a1f0`；旧 manifest SHA256 `43912b83efa4b538c323a9ff2b214f6197bff59f17e3ad777b7537bf564bfefd`。实际运行 rootfs 与归档相符，旧镜像未删。本机未下载完整包，C/D 最终约 3.74/23.20 GiB；只收尾删除本轮兼容实验可再生的约 116.8 MiB 独占编译缓存，没有清理共享缓存或其他资产。

## 新成本合同与条件性回退

无数据库结构迁移，也无新增必需环境服务；候选 proposed override 已渲染比较，仅三个 image 引用与 pull_policy=never 改变，其余合并配置相同，**尚未应用**。路径和摘要见证据。

[实际旧/新类型的离线兼容实验](predeploy-compatibility-result.json) 14/14 断言通过；使用同一 Go 1.27.2、缓存依赖、无网络/数据库/worker。旧 strict Config 接受 v0，拒绝 6 种包含新字段的草稿/Published/Product/Offer；新 strict 类型接受全部 7 种。宽松旧解码再保存丢失新字段只是负面对照，不能把它当作合法降级方法。具体范围见 [兼容性摘要](predeploy-compatibility.json)。

| 数据状态 | 可否回退旧 b5 应用 |
|---|---|
| 尚未写新版字段/成本来源 | 条件允许：相关写入者已阻断、任务排空、锁内重新扫描和旧 strict 读取全部通过，且满足组件归属 |
| 已保存新成本草稿 | 不安全；旧 strict Account 媒体配置读失败，即使 Published 仍为 v0 |
| 已发布新成本/Offer | 不安全；不能删除字段或覆盖整个 Account 求降级 |
| 已有新成本报价/订单/任务 | 不安全；旧 accounting source/store 无法解释 `studio_published_cost`，必须保留兼容执行者恢复 |

现场 4 份媒体配置、68 个 Core JSON、视频订单未发现 cost_rules/cost_version 或新版成本来源；另 11 个非 JSON 文件精确归类为 5 个 unit payload claim、5 个 dispatch claim、1 个旧空 claim，与原 receipt/哈希绑定。两项证据配对才构成当前扫描结论；非 JSON 分类不会单独证明 JSON 兼容。即使 `cost_version=0/null` 也按字段出现判定，不用 truthy 检测。

旧版严格解码失败路径及新 accounting source 限制已核对，不能把“镜像还在”当作无条件可回退。**部署锁无法阻止用户在网页保存新版草稿**。因此下阶段需要一段明确授权的短维护窗口：在实际代理入口临时阻断管理员配置写入和新 Studio 报价/prepare/提交，排空在途请求；保留登录/只读及既有结果读取，由唯一发布者受控调用官方管理接口。通用 Account 更新等配置写入也必须覆盖，不能只拦媒体保存按钮。为排空本次要重建的 Core，短窗口还须暂缓其新原生转发请求，避免检查为零后又进入请求；不改这些 API 的路由、权限、价格或幂等合同，维护结束即恢复原入口。具体路径从实际 Caddy 与 routes 复核后冻结、验证阻断/只读例外；本轮未修改代理。

在这段写入保护及发布锁内再次扫描所有 Account（含归档快照）、Core quote/task/receipt/prepare 与视频订单，未识别/不可读记录均拒绝旧版回退。若已产生新版数据，停止降级，留在 8ad 兼容版本，必要时同版本重启或另做兼容修复候选；不能恢复旧数据库、Account、journal 或 receipt 覆盖最新业务数据。

## 发布守卫与尚未执行的验收

| 门槛 | 部署前结果和范围 | 切换后 |
|---|---|---|
| PUB-01 | PASS：正常 HTTPS 校验证书，HTTP video-studio 跳转到同域 HTTPS，无循环；实际 Caddy/源站路径核对。未更改 TLS，未据此宣称核实 Cloudflare Full(strict) 设置 | 新版本入口重验 |
| PUB-02 | PASS：正常页面/静态资源无挑战，真实 MIME/摘要正确；匿名 protected readiness 为预期 401，不代表付费关闭 | 新版正常 URL、资源和认证响应重验 |
| PUB-03 | PASS：当前 b5 源站/公网 HTML 只允许响应 CSP 绑定 nonce 与单个固定 RUM；其余字节相同，6 JS/CSS 与源站完全一致 | 新版源站/公网比较 |
| PUB-04 | PASS（准备范围）：旧真实运行文件/镜像/资源身份与新固定 TAR 均有证明 | 新版实际容器、文件和正常 URL 内容待验 |
| PUB-05 | PASS（准备范围）：当前三组件健康、官方只读 paid status 与候选既有真实隔离验收 | 新版认证页面、非付费报价/权限/历史/原片待验 |
| PUB-06 | PASS（条件性恢复）：新检查点、实际隔离恢复、旧回退资产、现场指纹与唯一执行者；明确数据合同回退边界 | 保存当次操作/异常证据并按数据状态恢复 |
| ART-01 | PASS：复用实际固定 TAR 成品运行/全量摘要与最终验收，不用合成小程序代替真实产物 | 新运行文件及已授权完成回执核对 |

HTML 原始摘要随 CSP nonce 与边缘注入变化，不冒称原始整页相等。本轮窄比较器固定已观察 RUM src、配置结构、token 摘要、integrity 摘要与实际 CDN SRI 内容；8 个变异（未知脚本、旧资源、重复/错版/错 integrity/token、额外空白、错 nonce）均拒绝。[Cloudflare 官方机制](https://developers.cloudflare.com/speed/observatory/rum-beacon/) 支持自动 HTML beacon 注入。验证脚本见 [predeploy-checks](predeploy-checks)，未改变生产代理、安全策略或候选源码；部署时必须封存并复核该实际验证范围。

原先一次辅助请求漏带本轮固定诚实客户端标识得到 403，未当作业务关闭或取消防护；恢复该检查原已声明的固定 User-Agent 后采样。匿名 readiness 401 仅证明保护边界和路由存在；实际 effective 来自前述官方内部认证 GET。当前绑定链路使用 `/v1/studio/images/readiness` 与 `/studio-v2/api/image/readiness`，Bridge 为身份专用；早期旧图片桥路径不作为本候选执行合同。

切换后的新资源、真实认证浏览器及管理操作入口现在不能验证，均标记 PENDING，而非提前 PASS，也不算本轮准备失败。不邀请用户反复登录；下一轮先验证已修复浏览器通道与断言，再用一次合法认证完成 360/390/768/1366/1440 五视口，只读检查发布/销售入口、成本/售价、客户图片/视频与历史。不得以 fixture 截图代替生产。

## 下一轮唯一受控操作链（等待新授权）

1. 批准固定 8ad 三组件切换、短维护窗口的临时配置写入/新 Studio 提交及 Core 新转发请求保护，以及恢复原有图片准入；仍禁止视频开放、商品/价格/Account/Group/Channel/mapping 业务修改和真实付费测试。
2. 唯一发布者验证已封存操作与基线，在维护保护和发布锁内核对现场、排空在途、再次验证成本格式/恢复归属、必要时只增量补快照；若有无法解释的漂移或授权会话缺失，在切换前停止。需要管理员恢复图片时，先验证执行通道并准备合法短期会话。
3. 复核完整包/最终清单，空间够时导入固定 TAR，核对加载后的实际 Docker image ID、OCI/config/源码；应用当前真实 Compose + 已核对的候选 override，仅定向重建 Core/Bridge/BFF，确保 Bridge/BFF 附着新 Core namespace。不复制隔离环境配置，不换 PG/Redis/卷，不迁移数据库。
4. 验证三组件健康、公网/源站资源与受保护路径。Core epoch 改变会使原图片运行准入失效：**只有切换前仍为 true/true 时**，经官方管理员 check、完整 1,870 组合与必要报价、服务端二次校验及 CAS apply 恢复原 true/true；视频维持 false/false。本轮未开关，下一轮须把这项授权一次说明。
5. 执行允许的非付费报价、权限、历史、原片和五视口只读验收，核对资金/商品/存储保护指纹。普通未决历史不能为验收主动触发真实结算恢复；已有隔离合同证据继续复用。
6. 健康、认证、历史、报价一致性、资金或身份异常则停止放开写入并留证；尚无新版格式且门槛通过才回退旧三组件，之后同样重新核对图片准入。已写新版格式则保留兼容版本和最新数据，采取同版本/兼容前向修复；绝不整库恢复。完成验收后恢复原代理范围、解除维护保护，再复核服务状态。

Account #44 的上述 v0 WAN3.0 商品不会被部署自动补成本或重新发布，部署不保证其原生报价立即通过。管理员之后录入真实采购成本、保存并明确发布选中商品是独立配置步骤，不阻塞本轮准备；本轮未创建 Channel、未采用合成测试金额、未改售价。API/Studio 双业务隔离及真实模型身份要求保持。

结论：现在可以安排固定版本上线审批。需要用户下一次集中批准的动作是短维护写入保护、固定三组件切换，以及按官方流程恢复切换前原有图片 true/true；不包含任何商品启售、视频开放或真实付费生成。本轮到此停止。

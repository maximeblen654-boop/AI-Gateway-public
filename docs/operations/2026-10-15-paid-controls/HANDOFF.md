# 图片报价与管理员付费开关：执行交接

本轮范围：非生产源码、隔离模拟、测试与候选。没有连接生产、修改生产商品/价格/mapping、开启销售或调用真实供应商。生产最后接受状态仍为 `BLOCKED_IMAGE_QUOTE_BINDING_BOTH_DISABLED`；本轮不重新核实生产。

## 报价根因与修复

用已有脱敏资料构造同形账号：目录包含 `gpt-image-2`，Account mapping 包含其他模型别名，但没有 `gpt-image-2` 的匹配规则。商品层允许目录直通，原生运行准入却把非空 mapping 当成支持列表，导致已发布商品在 `SelectQuotedImageAccount` 被拒绝。文生图和编辑两条新增测试在修复前均失败，修复后通过。这是隔离根因证据，不是新的生产付费验证。

运行准入先重新解析当前 Published offer 并比较冻结绑定，随后仅为该精确 Account、模型、上游身份及凭据指纹授予目录直通。仍复用原生模型映射与调度；普通 API 的 allowlist 不变，不删除权限或冻结依赖校验。视频共享同一准入工具。

Core、Bridge、BFF 保留有限且脱敏的 `diagnostic_stage`。客户仍收到通用错误；不传播原始响应、凭据、内部地址。测试覆盖未知/恶意诊断字段不透传。另补齐原生 middleware 的余额/配额/订阅拒绝分类：仅允许已知原生错误码映射为 `billing_eligibility`，未知内容仍封闭为 binding；不透传原始消息。

## 实际开关机制

- 部署时三组件必须一起启用 `STUDIO_PAID_CONTROL_MODE=managed-v1`；旧部署保持原环境开关行为。不能只部署 UI 或只写数据库布尔值。
- 唯一 Core 使用既有 settings 仓储保存 image/video 独立请求状态、版本、检查指纹和进程 epoch；没有新增表或迁移。
- Core 在实际提交处校验；Bridge/BFF 每次准入读取当前 Core 生效状态，无“已开启”缓存。初始状态关闭。
- 开启操作先关闭准入，再重新执行服务端检查，比较用户检查指纹及最新依赖，最后确认实际状态。UI 分开显示请求和实际状态。
- 依赖变化、读写错误、sidecar 不可用或检查失败保持/锁定关闭。恢复旧配置不自动恢复旧 PASS；Core 重启也要求重新检查开启。
- 此模式下运行期开关无需重启；首次采用需要另行授权部署整组三组件和管理模式配置。本轮没有实施。

## 检查覆盖和边界

检查已有管理员原生 Key 的真实 Group/权限、已启售已发布商品、canonical mapping、发布依赖、正数售价、完整规格（不使用64条预览抽样）、原生 Account 成本规则、私有结果/素材存储及三组件运行合同。

图片分别走现有 `StudioImageRuntime.Issue` 文生图/编辑非付费报价；视频通过现有报价实现的内部预检分支编译参数、核对 Account 与成本，不上传素材、不请求供应商、不生成可执行视频 token。原生客户权限和余额仍在客户请求时再次检查；管理员预检不能保证每个客户都具备余额/权限。

未发布草稿不改变已冻结报价或开启检查依赖。成本计算器不参与开关、报价或结算。开启不自动发布、改价、补余额，也不改变 Account 销售状态。关闭只阻止新付费提交，已有任务查询/恢复保持既有规则，不重发未知上游请求。

## 验证状态

工作分支：`codex/media-paid-controls`。冻结运行源码：`c6af2299086831f99a40b045b889ce72573aadc2`；当前验收脚本：`f60f684999fcf0b2e212bb238df7d0a33b3ae2d5`。运行源码 CI [38611429466](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38611429466) 与 Security [38611429465](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38611429465) 均 PASS。验收脚本 f60f6849 的 [CI 38612617456](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38612617456) 与 [Security 38612617507](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38612617507) 也均 PASS。最终候选 [Run 38612619132](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38612619132) 已 PASS。状态：`CANDIDATE_READY_NOT_DEPLOYED`。

已完成本地定向验证：报价同形复现、绑定漂移、图片/视频隔离、旧 PASS、存储失败、重启、只读非付费视频预检、内部回环地址与重定向安全、BFF 错误脱敏、Vue 开关确认与失败状态。已有相关多图、partial、恢复、单视频及原生账务测试继续复用并运行受影响范围。

前序候选试验未通过，不作为合格部署候选。隔离 fixture 曾误用不处理 balance 的普通用户更新 API，已改用既有原生余额操作；仅作用于合成账户。移动端断言等待实际布局稳定。依赖漂移注入原先走原生 Account 更新 API，它会自动调用本地模拟器的 Responses 能力探针，因此改为仅隔离库的定向故障注入；没有放宽预检零上游请求断言，没有修改原生探针机制。新商品配置、保存、发布和客户业务仍走实际页面/API。

最终组合使用真实 Core 镜像页面、Bridge/BFF、隔离 PostgreSQL/Redis 与本地模拟器；不用 Vite 或浏览器 API mock。模拟器只在 runner 内，不转发真实供应商。全部生产配置和业务数据保持不动。

## 后续生产条件

本轮运行源码 CI/安全扫描和最终镜像隔离验收已通过。由用户另行批准部署具体候选；部署授权与真实销售开启授权分别处理。需核对生产对应 Group、现有 Key 权限、发布销售状态、成本与私有存储。检查失败不得自动修商品或探测供应商。

正式 `D:/AI-Gateway/AI-Gateway-Handoff.md`、Constraints 本轮未改写。此文件是本次代码执行证据交接，不替代正式产品决策。

## 最终隔离结果

| 场景 | 实际结果 |
|---|---|
| 关闭状态报价 | 文生图、参考图编辑均成功；同形 Account 有无关映射时不再错误拒绝 |
| 余额拒绝 | 两条报价均 409，安全分类 billing_eligibility；预检 FAIL、保持关闭 |
| 权限 | 普通客户调用管理员检查/开启均 403 |
| 生效 | Vue 二次确认后图片实际开启、视频仍关闭；视频需独立开启 |
| 旧 PASS / 配置漂移 | 409；实际状态关闭；恢复旧 mapping 不自动重新开启 |
| sidecar 故障 | 停止隔离 BFF 后正式开启动作失败，保持关闭 |
| 非付费检查 | 整个预检/拒绝/漂移阶段模拟器请求列表前后完全相同，image_posts=0、video_posts=0 |
| 文生图 | 1K、1:1、3 张；正常 3 个单图批次；模拟售价0.70×3=2.10；usage仅+1 |
| 参考图编辑 | 2K、3:2、2 张；2个单图批次；模拟售价0.90×2=1.80；usage仅+1 |
| 兼容单视频 | 1次视频提交，模拟售价2.00；usage仅+1、capture仅+1 |
| 刷新/查询/下载 | 原片摘要一致；请求次数、余额、usage、capture不增加 |
| 收尾 | 隔离 image/video 均关闭；三组件healthy、sidecar同一Core network namespace |

上述金额仅合成数据。图片原片 SHA-256：`431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460`；视频：`9738ac5e6756d120b3a6805420362e31390b3b4a26b604dcacac86c660f72299`。完整请求与结算增量见 evidence/native-customer-*.json。未运行真实供应商或付费验证。

截图来自最终 Core 镜像，17份管理员页面JS/CSS响应与直接Core内容相同；无Vite、无浏览器API mock。1440/390浅色深色已实际查看，未见重叠或水平溢出。截图中的“实际已开放”仅指合成隔离环境，不是生产。

- [桌面浅色](evidence/native-paid-controls-1440-light.png)
- [桌面深色](evidence/native-paid-controls-1440-dark.png)
- [手机浅色](evidence/native-paid-controls-390-light.png)
- [手机深色](evidence/native-paid-controls-390-dark.png)

## 候选身份与保存位置

[原始 manifest](evidence/manifest.json) SHA-256：`9364d33ef3562968978991d17bfa09ff4e64a300d90a86e7755f00ffd66d7eef`。

三组件均有实际运行改动，因此均由冻结 c6af2299 源码构建；没有复用 b2 冒充新版本。构建/验收脚本独立为 f60f6849。最终云端运行从2026-10-15 02:08:30至02:16:57（UTC+8），8分27秒；这不是本轮全部开发耗时。

- core（linux/amd64）
  - Image ID / config digest：`sha256:8fcdb2a0c4fbee281f0df2abbf2d8a4a1ce4a5f651ef7aabfa9a92cd5601923d`
  - OCI manifest：`sha256:e0aeec12b9bb77011fe60b87a4c500328ac55ecb293b4d60756f988ee2baad6d`
  - TAR：`core-c6af2299086831f99a40b045b889ce72573aadc2.tar.gz`
  - TAR SHA-256：`a1070f752822346b7475758e794fc00d3752d1dff552ea82a743c71de223c10e`
- bridge（linux/amd64）
  - Image ID / config digest：`sha256:caf64e63e1a1f29b4685795e8fb585c40bb1f75ebd2cf52232a3814195db3dec`
  - OCI manifest：`sha256:9cf2285b85924cd062d22be05eeacd88d2c1148c7cfbc632d49897f6bfb7e82a`
  - TAR：`bridge-c6af2299086831f99a40b045b889ce72573aadc2.tar.gz`
  - TAR SHA-256：`c17c638fd8899efdfd7ea572df070ce234b15916490c23db9f02696aefa398d8`
- bff（linux/amd64）
  - Image ID / config digest：`sha256:fe7407d6abbfb3d84c6f1270a1a2cae94a47ba1b3ebf723087c692b83ce456ac`
  - OCI manifest：`sha256:c821cccd98d6bfe4dc5762e005fe3bc6f713780ef2741a5022f4bd45e69740f5`
  - TAR：`bff-c6af2299086831f99a40b045b889ce72573aadc2.tar.gz`
  - TAR SHA-256：`26d3cd853827b65a2f600b828f1da415fb0c87377b5db699008788e8499a9ab4`

完整候选 Artifact **11918028540**，名称 `native-media-candidate-c6af2299086831f99a40b045b889ce72573aadc2`，约201 MiB；小证据 Artifact **11917688792**。都属于 Run38612619132，14天保留，到期2026-10-29 02:16（UTC+8）。Artifact不是永久备份，需要部署时应在到期前取回这一份并按manifest复核。本地仅保存小报告和截图：`D:/AI-Gateway/output/paid-controls-20261015/final/`；没有重复下载/解压完整镜像。

本地主要做源码和定向测试；大型Linux构建及真实组合验收全部在GitHub-hosted runner。未执行清理、prune或删除旧候选/回滚资产。收尾测量C盘5.89 GiB、D盘8.04 GiB，故继续避免本地大型构建。

## 部署前仍需独立批准的事项

1. 审核并批准具体c6af2299整组三组件及首次管理模式配置；不是只部署前端。已有环境提交开关保持false，`STUDIO_PAID_CONTROL_MODE=managed-v1`、Core↔sidecar回环地址与服务认证必须一致；生产BFF端口按真实拓扑核对，不能复制本次模拟Compose。
2. 不需要新增数据库schema，但未来管理员切换会写原生settings；预检图片会存放现有本地不计费报价记录，并做私有存储可写检查，不承诺零文件写入。不会自动发布商品、改价、补余额或调用供应商。
3. 部署与开放分别授权。上线后须先验证实际状态关闭，再按真实Group/权限/成本/存储运行预检。管理员检查不替代每个客户的原生权限、余额、额度检查。
4. 回退须使用部署前完整组件与配置、保持原环境开关关闭；新设置不会给旧legacy模式自动开放权限。无schema迁移，不进行整库恢复；实际生产兼容/在途状态仍需获授权时核对。

本轮没有连接生产、生产部署、生产数据库/商品/价格/mapping/销售变更，也没有真实供应商请求。生产最后已知状态仍是 `BLOCKED_IMAGE_QUOTE_BINDING_BOTH_DISABLED`，本次没有把它验证为已修复或已开放。

## 发布守卫适用性

依据主项目 `tools/project-control/RELEASE_GUARD.md`。本轮目标是隔离候选，不是生产切换；没有修改域名、TLS、Cloudflare或生产路由。

| 门槛 | 本轮状态与范围 | 证据/后续边界 |
|---|---|---|
| PUB-01 | N/A：未执行公网发布；生产当前HTTPS情况UNKNOWN | 另行批准部署时采样，不能以隔离HTTP替代 |
| PUB-02 | N/A：未经生产边缘代理；生产挑战/拦截UNKNOWN | 不伪装UA、不关闭防护 |
| PUB-03 | PASS：隔离Core资源准确比对；生产注入UNKNOWN | native-paid-controls-verify.json assets；未使用宽泛内容清洗 |
| PUB-04 | PASS：最终镜像页面；生产缓存版本UNKNOWN | 17份管理员JS/CSS与直接Core一致；未宣称公网已更新 |
| PUB-05 | PASS：隔离服务、登录、实际UI、报价/提交/交付/结算 | acceptance.json、native-paid-controls及native-customer报告；生产功能未验收 |
| PUB-06 | PASS：隔离故障有阶段、状态、截图和脱敏报告；生产恢复资产UNKNOWN | 本轮未采样生产基线、未持生产切换锁；实际部署前须保留当前资产和限定回退范围 |
| ART-01 | PASS：本次镜像启动、程序/资源摘要与真实业务验证；生产完成回执验证UNKNOWN | manifest.json、runtime-files.json、acceptance.json；本轮不调用生产upstream completion接口 |

这些结果不等于全部生产发布门槛通过。收到具体部署授权后，只补生产现场、配置、恢复资产和上线验证，不因文档归档重建本候选或重复整套隔离测试。

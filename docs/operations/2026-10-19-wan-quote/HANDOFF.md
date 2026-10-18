# 工作台采购成本、发布与双业务隔离

本页是当前交接；此前要求为 Studio 建立 Channel 成本的方案已退出，历史证据保留在 Git。正式 Constraints 与主工作区历史 Handoff 原件未覆盖。

## 当前身份与边界

- 应用运行源码：`8ad2eff39ff5bf6bfd07563041556f4a4c42d9a1`，分支 `codex/media-paid-controls`。
- 项目私有规则：`b5eded864a570ffada61669beb2df67905039721`，私有仓库 `AI-Gateway` 的 `codex/video-studio-portal-bff`；仅规则，不进入运行镜像。
- 2026-10-19 05:46 北京时间经已登记 SSH 重新核对：生产仍为 `b5b23a1f01721d41d94fb03bc6ac8796453dd24b`，三组件 healthy，图片 true/true、视频 false/false；有效状态来自官方内部认证只读 GET，未使用匿名 401 推断。
- 当前状态：`READY_FOR_EXPLICIT_DEPLOY_AUTHORIZATION`；固定候选、现场、当前检查点、隔离恢复与条件性回退边界已核对。仅暂存候选及创建受保护备份/证据，没有导入候选镜像、切换生产或真实供应商测试。下一步等待固定版本的正式切换授权。
- 不需要真实采购金额才能完成开发。测试只用合成账号、价格、素材和本地模拟上游。

## 最新部署准备增量（2026-10-19）

完整结果和下一轮唯一操作链见 [PREDEPLOY.md](PREDEPLOY.md)，脱敏现场及摘要见 [predeploy-evidence.json](predeploy-evidence.json)。正式 Constraints、私有历史 Handoff 及无关未提交工作保留。

- 原 TAR 与最终 PASS manifest 已在 VPS 独立校验；暂存 `/var/lib/ai-gateway/candidate-transfer-8ad2eff39-20261018T211618Z`，旧 NOT_PASSED 清单未改写。
- 新检查点 `/var/lib/ai-gateway/checkpoints/predeploy-8ad2eff-20261018T212207Z` 已真实隔离恢复：101 表/44,941 行、219 文件/140,597,629 字节、Redis 3,139 keys；完整性 PASS，无应用/worker 外连。
- 商品、价格、mapping、资金、usage/dedup、receipt 和原片保护通过；Account #44 record_version 5、#77 record_version 35，销售均 true，未修改。正常探测元数据、调度事件、统计游标及监控采样时间变化单列核实，未冒称全部原始字节不变。
- VPS 余量 22.67 GiB；现存旧镜像、完整旧 TAR 与检查点保留，未清理生产磁盘。当前真实镜像/Compose/挂载与起始采样一致。
- 实际旧/新 Config 类型离线兼容实验 14/14：旧 b5 不能读取新成本字段，保存新版草稿即跨越安全降级边界。下一轮必须把短维护写入保护、固定三组件切换，以及官方非付费预检/CAS 恢复切换前图片 true/true 一并申请授权。视频保持 false/false。
- 尚未执行的新版生产资源、认证页面及五视口只读验收留到切换后；不要求本轮反复登录。Account #44 真实成本录入与明确重新发布是后续独立配置，不自动执行，不为 Studio 创建 Channel。

## 数据与执行合同

在现有 Account 媒体 JSON 中新增 `Product.cost_rules`，每条使用既有 Match 与精确 CNY/per_request 金额；图片为单张、视频为整条。成本按合法规格独立于 `pricing_rules` 匹配，不能用售价推算成本或按售价行号绑定。显式 0 合法，空白不是 0。规则最多 100 条，组合枚举预算保持原限额。

新保存和明确重新发布的商品由服务器标记 `cost_version=1`。保存草稿允许缺项；只对明确选中的发布商品检查规格、适配器编译、唯一成本与售价覆盖、金额及依赖版本。未选中的半成品不阻塞。成本、产品与草稿 revision/CAS record_version 同次原子写入，不新增数据库表或迁移。

报价冻结成本金额、Account 倍率、具体商品、真实模型及 Published revision。Account 额度扣减为冻结单张/整条成本 × 实际计费数量 × 冻结 Account 倍率，仅计算一次；客户仍按冻结售价收费。图片按实际交付张数计算，视频不额外乘秒。新 v1 商品只读已发布工作台成本，不读或创建 API Channel；API 别名、价格或成本变化不改工作台真实上游模型。原生用户/Key/Group 授权、余额、账号状态、凭据、总并发与额度仍生效。执行时仅创建请求内的 Account 视图，原共享 Account 与 API 配置不改。

客户目录、报价、任务、历史与错误只返回公共字段；私有成本快照保留在服务端。原生 usage、结算去重、恢复与幂等复用既有机制，不新增钱包或账本。

旧不可变发布及已冻结订单使用原版本合同（v0）；不自动补零、追溯改成本、重新发布或暂停销售。旧发布的新报价可能仍依赖历史 Channel 成本；历史已冻结订单恢复读取其原快照，不重新取得当前 Channel 价格。管理员之后明确重新发布时必须补齐工作台成本，不再要求另配 Channel。

## 管理员操作

1. 选择具体 Account 与模型商品，仍沿用五步向导。第 4 步为“采购成本与售价”。
2. 直接填成本，或计算后点“采用此结果”：只写入当前草稿，显示“已采用，尚未保存”。成本可按分辨率、比例、画质、时长、创作方式或精细条件拆分；售价维度保持独立。
3. 第 5 步明确保存；收到响应后重新读取服务器确认 revision 与数据。明确拒绝保留输入，可修正重存；超时/并发/不明结果先核对，不自动重发。
4. 检查缺项可定位具体商品、第 4 步与字段，滚动聚焦并尊重未保存修改。保存不等于发布。
5. 在模型列表上方选择发布商品，确认后显示持久发布版本与范围。发布不自动开销售。
6. 同一上方操作区提供 Account 级工作台销售确认；失败保留弹窗。提示实际受影响商品。销售不改变原生 API，也不自动开图片/视频全局付费。

成本计算器是管理员确认录入的依据，不是供应商实际账单。旧本地估算不会自动迁移为正式成本。复杂参考图和输出格式条件保留原规则，不能静默合并。

## 验证与证据等级

- 本地 Go：mediaworkbench 全包及 Studio/WAN/原生 Channel、模型映射、权限、CAS、DTO 隐私回归通过；最终数量及云端全量结果见下方证据。
- 本地 Vue/TS：完整 `vue-tsc --noEmit` 与定向 ESLint 通过；采购成本/保存/选择发布/销售/售价保护组件回归通过。
- 真实 Vue 外壳 + 本地 HTTP/Axios fixture：24 项浏览器测试通过，覆盖 1440、1366、768、390、360、浅深色及正常/拒绝/超时。此层不冒充真实 Core 联调。
- 最终成品 Core/Bridge/BFF：使用 GitHub-hosted 一次性数据库与本地模拟供应商验证通过；覆盖工作台成本保存、选择发布、图片及 WAN3.0 两条路径、API 隔离、原生安全门禁、一次结算及恢复。新脚本 `tools/native-media-e2e/workbench-procurement.cjs` 在非隔离环境拒绝运行。
- 真实供应商生成不纳入本轮验收；没有真实付费请求或生产订单。
- 原生允许正余额提交、结算后可能为负余额的合同保持不变；拒绝用例使用余额为 0，不把低正余额错误当作预计售价预扣门槛。

截图为隔离真实 Vue 外壳（HTTP fixture），不是生产截图：[桌面成本编辑](screenshots/procurement-1440-light.png)、[手机成本编辑](screenshots/procurement-390-light.png)、[桌面发布/销售入口](screenshots/account-operations-1440-light.png)、[手机发布/销售入口](screenshots/account-operations-390-light.png)。

## 云端固定候选

- 运行源码固定为 `8ad2eff39ff5bf6bfd07563041556f4a4c42d9a1`。
- [CI 39163329810](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/39163329810) 与 [Security 39163329880](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/39163329880)：PASS，检查源码 `ebeb7ee9bb73c429687cdfaf7f132023d27ef6c7`。
- [最终候选补验 39164189216](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/39164189216)：PASS，验收脚本 `bc90cb09105eaca5434c4464a9fd1e0d09a81f71`，未重新构建或导出镜像。
- [完整镜像 Artifact 12149012613](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/39161087117/artifacts/12149012613)：由构建 Run `39161087117` 生成的固定 TAR。该次首次整体验收因测试 fixture 失败，包内旧 manifest 为 NOT_PASSED，**不得单独作为已验收候选**。
- [最终补验证据 Artifact 12149958347](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/39164189216/artifacts/12149958347)：与上述原 TAR 配对使用；其中最终 PASS manifest、acceptance.json 和资金复用证明才是当前验收依据。不能把原包内旧 manifest 当成最终 PASS。
- [前端浏览器证据 Artifact 12149143857](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/39163329810/artifacts/12149143857)：19 项既有浏览器回归与 24 项采购流程回归通过。
- 后续 CI/补验变更仅涉及测试和验收脚本；[运行代码等价证明](source-equivalence.json) 核对 2,415 个运行条目一致，manifest SHA256 `138f523771fe9839ae4a01f47569dc5498c49da123259f68d02865b163a9f6bd`。文档提交不是运行镜像源码。

最终 [candidate-manifest.json](candidate-manifest.json) SHA256：`485c4a8fcc54b31bb415304366f9244d33ed95a9fb63a6c43f0779451a7d0dca`。三组件 TAR、OCI 与 config digest 均在其中；补验先独立核对原 TAR SHA256、OCI/config、源码标签及实际加载 image ID，再运行成品集成测试。[三组件健康记录](candidate-acceptance.json)、[采购闭环原始报告](native-workbench-procurement.json)、[验收摘要](acceptance-summary.json)、[原包复用记录](reuse-existing.json) 一并保留。manifest 中的安全关闭标记属于隔离验收条件，不是覆盖现网配置或开启付费的指令。

104 笔资金混合场景在同一固定三组件首次构建中完成并通过。最终补验仅在 TAR 身份、测试输入 Git blob 与证据 SHA 一致后复用该结果，保留 [资金复用证明](funds-reuse.json)；没有无意义重做 104 笔。分布为成功 24、部分交付 12、明确拒绝 12、502 16、断线 12、超时 12、迟到 8、重复 8；结算、余额守恒及重启后不重发校验通过。其余新采购闭环、客户生成/编辑/视频、恢复、1,870 组合、目录依赖、生命周期和监控用例在最终补验重新通过。三次 1,870 规格完整预检浏览器耗时为 1,047 / 705 / 799 ms，预检本身零供应商请求。

以下均是合成价格，不能用于 Account #44 生产配置：

| 隔离执行 | 客户实际结算 | Account 额度增量 | 模拟上游 POST / 恢复重发 |
|---|---:|---:|---:|
| 图片 2 张，成本 0.12/张、售价 0.9/张、倍率 1.25 | 1.8 | 0.30 | 1 / 0 |
| WAN3.0，无参考素材，5 秒整条成本 0.3、售价 2、倍率 1.25 | 2 | 0.375 | 1 / 0 |
| WAN3.0，1 份参考素材，同整条成本与售价 | 2 | 0.375 | 1 / 0 |
| 显式零成本图片，售价 1.1 | 1.1 | 0 | 1 / 0 |

均生成原始结果并核对文件 SHA、原生 usage 和一次结算；之后重新发布成本/售价，不改变这些原任务的金额。API Channel 使用另一组合成报价，修改 API 别名和成本不改变上述 Studio 实际模型与冻结金额。余额 0、共享额度不足、Account 停止调度、Key 失效分别拒绝，失败无新增供应商 POST 或 usage；客户响应不含私有成本及凭据。

## Account #44 后续生产操作边界

具体对象：Account #44 / Group #31 / UpstreamModel 与 SiteModel `WAN3.0-可参考视频` / Product `media-92a8e4ac-0ca9-4ece-bd6b-0921d2a55f97`。以上身份已于本轮部署准备重新只读核对；正式切换前仍需检查漂移。

新代码不自动改变此商品。若此商品仍为 v0 且没有历史 Channel 成本，单纯部署不会恢复报价；需管理员明确发布成本完整的 v1 后复查。用户之后确认真实采购单价、单位及规格覆盖后，在工作台第 4 步录入成本，保存、检查并仅发布选中的商品；不为 Studio 创建 Channel。采购若按秒变化，管理员先换算相应时长的整条成本并以时长规则表达，运行时不重复乘秒。客户售价由管理员独立决定。

## 唯一受控上线链与回退边界

本轮停止在部署准备就绪，不部署。后续须另行授权 [PREDEPLOY.md](PREDEPLOY.md) 的受控链：短维护写入保护 → 锁内现场/任务/格式与备份复核 → 固定三组件切换 → 官方预检及恢复切换前图片准入 → 非付费接口与认证浏览器验收 → 保护指纹及安全恢复判定 → 解除维护保护。Account #44 成本录入/发布、视频开放、真实供应商测试不属于切换的附带授权。

没有数据库结构变更，但新成本字段和快照属于新的应用合同。新版本写入过草稿/发布或冻结任务后，禁止盲目回退到不了解这些字段的旧镜像；需逐项确认旧读写兼容，必要时采用兼容修复候选。不能整份恢复 Account、receipt、journal 或旧数据库来回滚应用，不覆盖切换后的客户数据。

以下为研发阶段隔离门槛记录，保留验证范围；本轮现场已补齐的准备项以 [PREDEPLOY.md 发布守卫表](PREDEPLOY.md#发布守卫与尚未执行的验收) 为准。切换后的验收仍未执行：

| 门槛 | 本轮结论与证据 | 后续生产必补 |
|---|---|---|
| PUB-01 HTTPS/跳转 | N/A：隔离候选不改变域名、TLS 或跳转 | UNKNOWN：现场 HTTPS、入口及对应关系 |
| PUB-02 边缘安全拦截 | N/A：本轮 GitHub-hosted 直连隔离栈，无 Cloudflare 路径 | UNKNOWN：正常客户公网资源/接口与挑战标志 |
| PUB-03 页面改写 | PASS（隔离范围）：成品资源与 Core 直读摘要一致，无 Vite/API mock | UNKNOWN：源站/公网差异及窄边界 |
| PUB-04 实际版本 | PASS（候选范围）：TAR、OCI/config、运行 image ID、资源摘要一致 | UNKNOWN：切换后正常 URL 缓存及新资源 |
| PUB-05 健康及业务 | PASS（隔离范围）：三组件 healthy、真实接口/账务与浏览器回归 | UNKNOWN：生产认证、报价、历史与原片保护 |
| PUB-06 诊断及恢复归属 | PASS（候选范围）：失败/成功报告、原 TAR 及版本来源可追溯 | UNKNOWN：生产有效备份、控制锁、当次保护指纹与兼容回退 |

磁盘收尾：保留必要的小证据，未下载本地完整镜像包；本轮独占实验缓存收尾，共享缓存未清空，主工作区未提交内容保留。C/D 约 3.74/23.20 GiB。仅创建本轮受保护快照与候选暂存；生产磁盘清理、应用切换或回退均未执行。
